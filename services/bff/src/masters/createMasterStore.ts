// services/bff/src/masters/createMasterStore.ts
//
// Phase 9 T11 — Master Setup framework foundation.
//
// Per the Phase 9 design doc, T11 ships ~25 master tables (Countries /
// Regions / States / Cities / Branches / Departments / Teams / User
// Types / Risk Categories / Alert Types / Severity Levels / Escalation
// Levels / Banking Products / Loan Types / Sectors / Risk Buckets /
// Policy Types / Claim Types / Channels / etc). Building 25 separate
// stores + 25 separate route mounters would be ~3-4 sessions of
// duplicate work, so this file establishes the REUSABLE foundation:
//
//   createMasterStore(name, schema) → IMasterStore<T>
//   createMasterRoutes(store)        → Express router
//
// Adding a 26th entity is then ~10 lines (declare the schema + mount
// the routes + add a nav entry). The first 3 representative entities
// (Countries / Departments / Risk Categories) prove the pattern:
//   - Countries: platform-static (no tenant_id, 250 ISO countries)
//   - Departments: tenant-scoped (per-bank departments)
//   - Risk Categories: tenant-scoped + closed-enum severity field
//
// Production swaps the in-memory Map for an Aurora table; the
// IMasterStore interface stays unchanged.

import { randomUUID } from 'node:crypto';

/** Tenant context for tenant-scoped entities. Platform-static entities
 *  ignore this parameter (they share one row set across all tenants). */
export type TenantId = string;

/** Field type for soft validation. */
export type MasterFieldType = 'string' | 'integer' | 'number' | 'boolean' | 'enum';

export interface MasterField {
  name: string;
  type: MasterFieldType;
  /** Required at create time (PATCH may omit). Defaults to false. */
  required?: boolean;
  /** Max string length (only meaningful for type='string'). */
  max_length?: number;
  /** Closed enum values (only meaningful for type='enum'). */
  enum_values?: readonly string[];
  /** Human-readable label for the SPA form (defaults to name). */
  label?: string;
}

export interface MasterSchema {
  /** kebab-case entity slug used in routes + nav (e.g. 'countries'). */
  entity: string;
  /** Singular human label (e.g. 'Country'). */
  label: string;
  /** Plural human label (e.g. 'Countries'). */
  label_plural: string;
  /** Whether each row belongs to a single tenant. Platform-static entities
   *  (e.g. Countries) set this false → one shared row set across tenants. */
  tenant_scoped: boolean;
  /** Field schema for validation + SPA form rendering. */
  fields: MasterField[];
  /** Optional seed rows applied on cold-start. */
  seed?: Array<Record<string, unknown>>;
}

export interface MasterRow {
  /** Auto-generated unique id (`mst-<entity>-<uuid>`). */
  id: string;
  /** Tenant the row belongs to. 'PLATFORM' for platform-static entities. */
  tenant_id: TenantId | 'PLATFORM';
  /** Free-form per-schema fields. */
  fields: Record<string, unknown>;
  /** ISO timestamp. */
  created_at: string;
  /** Username of the actor that created the row. */
  created_by: string;
  /** ISO timestamp; bumped on every PATCH. */
  updated_at: string;
  /** Username of the actor that last edited the row. */
  updated_by: string;
}

/** Validation + persistence error. */
export class MasterStoreError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'unknown_row'
      | 'missing_required'
      | 'wrong_type'
      | 'enum_violation'
      | 'too_long',
    message: string,
  ) {
    super(message);
    this.name = 'MasterStoreError';
  }
}

/** Pluggable store interface — `createMasterStore` returns an in-memory
 *  impl; production swaps to a pg-backed one with the same shape. */
export interface IMasterStore {
  readonly schema: MasterSchema;
  list(tenant_id: TenantId): MasterRow[];
  get(tenant_id: TenantId, id: string): MasterRow | undefined;
  create(tenant_id: TenantId, actor: string, fields: Record<string, unknown>): MasterRow;
  update(
    tenant_id: TenantId,
    id: string,
    actor: string,
    fields: Record<string, unknown>,
  ): MasterRow;
  delete(tenant_id: TenantId, id: string): boolean;
}

/** Soft-validates `fields` against the schema and returns a normalised
 *  copy. Empty / undefined entries are dropped on update; required
 *  fields are enforced on create. */
function validateFields(
  schema: MasterSchema,
  fields: Record<string, unknown>,
  mode: 'create' | 'update',
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    const raw = fields[f.name];
    const present = raw !== undefined && raw !== null && raw !== '';
    if (!present) {
      if (mode === 'create' && f.required) {
        throw new MasterStoreError(
          'missing_required',
          `field ${f.name} is required`,
        );
      }
      continue;
    }
    if (f.type === 'string' || f.type === 'enum') {
      if (typeof raw !== 'string') {
        throw new MasterStoreError('wrong_type', `field ${f.name} must be a string`);
      }
      const s = raw.trim();
      if (f.max_length && s.length > f.max_length) {
        throw new MasterStoreError(
          'too_long',
          `field ${f.name} exceeds max length ${f.max_length}`,
        );
      }
      if (f.type === 'enum' && f.enum_values && !f.enum_values.includes(s)) {
        throw new MasterStoreError(
          'enum_violation',
          `field ${f.name} must be one of ${f.enum_values.join(', ')}`,
        );
      }
      out[f.name] = s;
    } else if (f.type === 'integer') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new MasterStoreError(
          'wrong_type',
          `field ${f.name} must be an integer`,
        );
      }
      out[f.name] = n;
    } else if (f.type === 'number') {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        throw new MasterStoreError('wrong_type', `field ${f.name} must be a number`);
      }
      out[f.name] = n;
    } else if (f.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        throw new MasterStoreError(
          'wrong_type',
          `field ${f.name} must be a boolean`,
        );
      }
      out[f.name] = raw;
    }
  }
  return out;
}

/** In-memory implementation. Each entity gets its own `byTenant` map:
 *  for tenant-scoped entities, keyed by tenant_id; for platform-static
 *  entities, every tenant reads/writes the same 'PLATFORM' bucket. */
export function createMasterStore(schema: MasterSchema): IMasterStore {
  const byTenant: Map<string, Map<string, MasterRow>> = new Map();

  function bucketKey(tenant_id: TenantId): string {
    return schema.tenant_scoped ? tenant_id : 'PLATFORM';
  }

  function bucket(tenant_id: TenantId): Map<string, MasterRow> {
    const key = bucketKey(tenant_id);
    let b = byTenant.get(key);
    if (!b) {
      b = new Map();
      byTenant.set(key, b);
    }
    return b;
  }

  // Apply seed rows once on construction.
  if (schema.seed && schema.seed.length > 0) {
    const seedTenant = schema.tenant_scoped ? 'BANK_DEMO' : 'PLATFORM';
    const b = bucket(seedTenant);
    for (const seed of schema.seed) {
      // Soft-validate but skip the required-field gate for seeds so
      // partial seeds work for tests.
      let validated: Record<string, unknown>;
      try {
        validated = validateFields(schema, seed, 'create');
      } catch {
        continue;
      }
      const id = `mst-${schema.entity}-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      b.set(id, {
        id,
        tenant_id: seedTenant,
        fields: validated,
        created_at: now,
        created_by: 'system:seed',
        updated_at: now,
        updated_by: 'system:seed',
      });
    }
  }

  return {
    schema,
    list(tenant_id) {
      return Array.from(bucket(tenant_id).values())
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    },
    get(tenant_id, id) {
      return bucket(tenant_id).get(id);
    },
    create(tenant_id, actor, fields) {
      const validated = validateFields(schema, fields, 'create');
      const id = `mst-${schema.entity}-${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const row: MasterRow = {
        id,
        tenant_id: schema.tenant_scoped ? tenant_id : 'PLATFORM',
        fields: validated,
        created_at: now,
        created_by: actor || 'unknown',
        updated_at: now,
        updated_by: actor || 'unknown',
      };
      bucket(tenant_id).set(id, row);
      return row;
    },
    update(tenant_id, id, actor, fields) {
      const b = bucket(tenant_id);
      const existing = b.get(id);
      if (!existing) {
        throw new MasterStoreError('unknown_row', `unknown ${schema.entity} id ${id}`);
      }
      const validated = validateFields(schema, fields, 'update');
      const updated: MasterRow = {
        ...existing,
        fields: { ...existing.fields, ...validated },
        updated_at: new Date().toISOString(),
        updated_by: actor || 'unknown',
      };
      b.set(id, updated);
      return updated;
    },
    delete(tenant_id, id) {
      return bucket(tenant_id).delete(id);
    },
  };
}
