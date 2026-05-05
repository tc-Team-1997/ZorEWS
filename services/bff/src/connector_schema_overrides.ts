// services/bff/src/connector_schema_overrides.ts
//
// T6 M3.3 — Per-tenant schema overrides.
//
// M3.2 ships connector schemas as platform-static. Some BIL tenants
// receive bespoke field extensions from their upstream systems
// (custom CBS exports, regulator-mandated audit fields). M3.3 lets
// admins layer per-tenant additional fields on top of the
// platform-default schema. Existing fields are NOT overridable —
// changes there break downstream consumers — only ADDITIONS allowed.
//
// Per-tenant cap = 25 added fields per connector to keep validate
// fast.

import {
  type ConnectorSchema,
  type FieldDef,
  type FieldType,
  getConnectorSchema as getPlatformSchema,
} from './connector_schema';

export class SchemaOverrideError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SchemaOverrideError';
  }
}

export interface FieldDefInput {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
  sample: string;
  enum_values?: string[];
  max_length?: number;
  min?: number;
  max?: number;
}

const VALID_TYPES: readonly FieldType[] = [
  'string', 'integer', 'number', 'boolean', 'date', 'datetime', 'enum',
] as const;

const CAP_PER_CONNECTOR = 25;

function validateField(input: unknown): FieldDef {
  if (!input || typeof input !== 'object') {
    throw new SchemaOverrideError('invalid_input', 'field must be an object');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new SchemaOverrideError('invalid_input', 'name is required');
  }
  if (i.name.length > 64) throw new SchemaOverrideError('invalid_input', 'name ≤ 64 chars');
  if (typeof i.type !== 'string' || !VALID_TYPES.includes(i.type as FieldType)) {
    throw new SchemaOverrideError('invalid_input', `type must be one of ${VALID_TYPES.join(', ')}`);
  }
  if (typeof i.required !== 'boolean') {
    throw new SchemaOverrideError('invalid_input', 'required must be boolean');
  }
  if (typeof i.description !== 'string') {
    throw new SchemaOverrideError('invalid_input', 'description must be a string');
  }
  if (typeof i.sample !== 'string') {
    throw new SchemaOverrideError('invalid_input', 'sample must be a string');
  }
  if (i.type === 'enum') {
    if (!Array.isArray(i.enum_values) || i.enum_values.length === 0) {
      throw new SchemaOverrideError('invalid_input', 'enum fields require enum_values[]');
    }
    for (const v of i.enum_values) {
      if (typeof v !== 'string') {
        throw new SchemaOverrideError('invalid_input', 'enum_values must be strings');
      }
    }
  }
  return {
    name: i.name.trim(),
    type: i.type as FieldType,
    required: i.required,
    description: i.description,
    sample: i.sample,
    enum_values: i.enum_values as string[] | undefined,
    max_length: typeof i.max_length === 'number' ? i.max_length : undefined,
    min: typeof i.min === 'number' ? i.min : undefined,
    max: typeof i.max === 'number' ? i.max : undefined,
  };
}

export interface SchemaOverrideStore {
  list(tenant_id: string, connector_id: string): FieldDef[];
  add(tenant_id: string, connector_id: string, field: unknown): FieldDef;
  remove(tenant_id: string, connector_id: string, field_name: string): boolean;
  /** Build the effective schema = platform fields + tenant additions. */
  effective(tenant_id: string, connector_id: string): ConnectorSchema | null;
}

export class InMemorySchemaOverrideStore implements SchemaOverrideStore {
  // (tenant, connector) → field[]
  private readonly map = new Map<string, FieldDef[]>();

  private k(tenant: string, connector: string): string {
    return `${tenant}::${connector}`;
  }

  list(tenant_id: string, connector_id: string): FieldDef[] {
    return [...(this.map.get(this.k(tenant_id, connector_id)) ?? [])];
  }

  add(tenant_id: string, connector_id: string, field: unknown): FieldDef {
    const platform = getPlatformSchema(connector_id);
    if (!platform) {
      throw new SchemaOverrideError('unknown_connector', `connector ${connector_id} not found`);
    }
    const valid = validateField(field);
    const platformNames = new Set(platform.fields.map((f) => f.name));
    if (platformNames.has(valid.name)) {
      throw new SchemaOverrideError(
        'reserved_field',
        `field "${valid.name}" is already in the platform schema and cannot be overridden`,
      );
    }
    const existing = this.map.get(this.k(tenant_id, connector_id)) ?? [];
    if (existing.find((f) => f.name === valid.name)) {
      throw new SchemaOverrideError(
        'duplicate_field',
        `field "${valid.name}" already exists in this tenant's overrides`,
      );
    }
    if (existing.length >= CAP_PER_CONNECTOR) {
      throw new SchemaOverrideError(
        'cap_reached',
        `tenant has ${CAP_PER_CONNECTOR} overrides for ${connector_id}`,
      );
    }
    existing.push(valid);
    this.map.set(this.k(tenant_id, connector_id), existing);
    return valid;
  }

  remove(tenant_id: string, connector_id: string, field_name: string): boolean {
    const arr = this.map.get(this.k(tenant_id, connector_id));
    if (!arr) return false;
    const idx = arr.findIndex((f) => f.name === field_name);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return true;
  }

  effective(tenant_id: string, connector_id: string): ConnectorSchema | null {
    const platform = getPlatformSchema(connector_id);
    if (!platform) return null;
    const overrides = this.list(tenant_id, connector_id);
    return {
      ...platform,
      fields: [...platform.fields, ...overrides],
    };
  }
}

export const defaultSchemaOverrideStore: SchemaOverrideStore =
  new InMemorySchemaOverrideStore();
