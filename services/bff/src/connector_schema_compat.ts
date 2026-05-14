// services/bff/src/connector_schema_compat.ts
//
// T6 M3.9 — Connector schema breaking-change check.
//
// M3.2 ships per-connector schemas; M3.7 surfaces source attribution;
// M3.8 builds a cross-connector field index. M3.9 ships the
// forward-looking checker: given the current schema (a) and a
// candidate next schema (b), report what BREAKS for existing
// publishers vs what's ADDITIVE.
//
// Mirrors infra/schema-registry/scripts/check_compat.py (the Glue
// BACKWARD compat checker for Kafka schemas) but operates over the
// M3.2 ConnectorSchema shape instead of JSON-Schema documents.
//
// Pure — no I/O. Caller passes both schemas explicitly. The route
// looks up `a` from the M3.2 registry and accepts `b` in the body.

import type { ConnectorSchema, FieldDef, FieldType } from './connector_schema';

// ─── Public types ─────────────────────────────────────────────────────

export type BreakingChangeKind =
  | 'field_removed'
  | 'type_changed'
  | 'required_added'        // existing optional field made required
  | 'new_required_field'    // brand-new field added as required
  | 'enum_narrowed'         // existing enum value removed
  | 'max_length_decreased'
  | 'min_increased'         // numeric min raised (tightens what's accepted)
  | 'max_decreased'         // numeric max lowered
  | 'record_format_changed';

export type AdditiveChangeKind =
  | 'field_added'          // optional only
  | 'required_loosened'    // required → optional
  | 'enum_widened'         // new enum value added
  | 'max_length_increased'
  | 'min_decreased'
  | 'max_increased';

export interface ChangeEntry {
  field: string | null;
  kind: BreakingChangeKind | AdditiveChangeKind;
  detail: string;
}

export interface SchemaCompatReport {
  from_version: string;
  to_version: string;
  compatible: boolean;
  breaking_count: number;
  additive_count: number;
  unchanged_field_count: number;
  breaking_changes: ChangeEntry[];
  additive_changes: ChangeEntry[];
}

// ─── Pure compat checker ─────────────────────────────────────────────

function setEq<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function compareEnums(
  field: string,
  aValues: readonly string[],
  bValues: readonly string[],
  breaking: ChangeEntry[],
  additive: ChangeEntry[],
): void {
  const aSet = new Set(aValues);
  const bSet = new Set(bValues);
  if (setEq(aSet, bSet)) return;
  const removed = [...aValues].filter((v) => !bSet.has(v));
  const added = [...bValues].filter((v) => !aSet.has(v));
  if (removed.length > 0) {
    breaking.push({
      field,
      kind: 'enum_narrowed',
      detail: `enum_values removed: ${removed.join(', ')}`,
    });
  }
  if (added.length > 0 && removed.length === 0) {
    additive.push({
      field,
      kind: 'enum_widened',
      detail: `enum_values added: ${added.join(', ')}`,
    });
  }
}

function compareField(
  before: FieldDef,
  after: FieldDef,
  breaking: ChangeEntry[],
  additive: ChangeEntry[],
): boolean {
  let changed = false;
  if (before.type !== after.type) {
    breaking.push({
      field: before.name,
      kind: 'type_changed',
      detail: `type changed from ${before.type} → ${after.type}`,
    });
    changed = true;
  }
  if (!before.required && after.required) {
    breaking.push({
      field: before.name,
      kind: 'required_added',
      detail: 'existing optional field promoted to required',
    });
    changed = true;
  }
  if (before.required && !after.required) {
    additive.push({
      field: before.name,
      kind: 'required_loosened',
      detail: 'existing required field demoted to optional',
    });
    changed = true;
  }
  if (
    before.type === 'enum' && after.type === 'enum' &&
    before.enum_values && after.enum_values
  ) {
    compareEnums(before.name, before.enum_values, after.enum_values, breaking, additive);
  }
  if (
    (before.type === 'string' || after.type === 'string') &&
    before.max_length !== undefined && after.max_length !== undefined
  ) {
    if (after.max_length < before.max_length) {
      breaking.push({
        field: before.name,
        kind: 'max_length_decreased',
        detail: `max_length ${before.max_length} → ${after.max_length}`,
      });
      changed = true;
    } else if (after.max_length > before.max_length) {
      additive.push({
        field: before.name,
        kind: 'max_length_increased',
        detail: `max_length ${before.max_length} → ${after.max_length}`,
      });
      changed = true;
    }
  }
  // Numeric bounds — interpretation: TIGHTENING accepted set (raising
  // min OR lowering max) is breaking; LOOSENING is additive.
  if (before.min !== undefined && after.min !== undefined && before.min !== after.min) {
    if (after.min > before.min) {
      breaking.push({
        field: before.name,
        kind: 'min_increased',
        detail: `min ${before.min} → ${after.min}`,
      });
    } else {
      additive.push({
        field: before.name,
        kind: 'min_decreased',
        detail: `min ${before.min} → ${after.min}`,
      });
    }
    changed = true;
  }
  if (before.max !== undefined && after.max !== undefined && before.max !== after.max) {
    if (after.max < before.max) {
      breaking.push({
        field: before.name,
        kind: 'max_decreased',
        detail: `max ${before.max} → ${after.max}`,
      });
    } else {
      additive.push({
        field: before.name,
        kind: 'max_increased',
        detail: `max ${before.max} → ${after.max}`,
      });
    }
    changed = true;
  }
  return changed;
}

export function compareConnectorSchemas(
  before: ConnectorSchema,
  after: ConnectorSchema,
): SchemaCompatReport {
  const breaking: ChangeEntry[] = [];
  const additive: ChangeEntry[] = [];
  let unchanged = 0;

  if (before.record_format !== after.record_format) {
    breaking.push({
      field: null,
      kind: 'record_format_changed',
      detail: `record_format ${before.record_format} → ${after.record_format}`,
    });
  }

  const afterByName = new Map(after.fields.map((f) => [f.name, f]));
  const beforeByName = new Map(before.fields.map((f) => [f.name, f]));

  for (const b of before.fields) {
    const a = afterByName.get(b.name);
    if (!a) {
      breaking.push({
        field: b.name,
        kind: 'field_removed',
        detail: `field removed from new schema`,
      });
      continue;
    }
    const wasChanged = compareField(b, a, breaking, additive);
    if (!wasChanged) unchanged += 1;
  }
  for (const a of after.fields) {
    if (beforeByName.has(a.name)) continue;
    if (a.required) {
      breaking.push({
        field: a.name,
        kind: 'new_required_field',
        detail: `new required field added (existing publishers will fail validation)`,
      });
    } else {
      additive.push({
        field: a.name,
        kind: 'field_added',
        detail: `new optional field added`,
      });
    }
  }

  return {
    from_version: before.version,
    to_version: after.version,
    compatible: breaking.length === 0,
    breaking_count: breaking.length,
    additive_count: additive.length,
    unchanged_field_count: unchanged,
    breaking_changes: breaking,
    additive_changes: additive,
  };
}

// Helper for the route to construct a minimal schema for validation
// of the candidate input.
export class SchemaCompatInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SchemaCompatInputError';
  }
}

const VALID_TYPES: readonly FieldType[] = [
  'string',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'enum',
];

export function validateCandidateSchema(candidate: unknown, connector_id: string): ConnectorSchema {
  if (!candidate || typeof candidate !== 'object') {
    throw new SchemaCompatInputError('invalid_input', 'candidate schema body required');
  }
  const c = candidate as Record<string, unknown>;
  if (typeof c.version !== 'string' || !c.version) {
    throw new SchemaCompatInputError('invalid_input', 'candidate.version is required (string)');
  }
  if (typeof c.record_format !== 'string') {
    throw new SchemaCompatInputError('invalid_input', 'candidate.record_format is required (string)');
  }
  if (!Array.isArray(c.fields)) {
    throw new SchemaCompatInputError('invalid_input', 'candidate.fields must be an array');
  }
  const fields: FieldDef[] = [];
  for (const f of c.fields as unknown[]) {
    if (!f || typeof f !== 'object') {
      throw new SchemaCompatInputError('invalid_input', 'every field must be an object');
    }
    const fd = f as Record<string, unknown>;
    if (typeof fd.name !== 'string' || !fd.name) {
      throw new SchemaCompatInputError('invalid_input', 'every field requires a non-empty name');
    }
    if (!VALID_TYPES.includes(fd.type as FieldType)) {
      throw new SchemaCompatInputError('invalid_input', `field ${fd.name} has invalid type`);
    }
    fields.push({
      name: fd.name,
      type: fd.type as FieldType,
      required: Boolean(fd.required),
      description: typeof fd.description === 'string' ? fd.description : '',
      sample: typeof fd.sample === 'string' ? fd.sample : '',
      enum_values: Array.isArray(fd.enum_values) ? (fd.enum_values as string[]) : undefined,
      max_length: typeof fd.max_length === 'number' ? fd.max_length : undefined,
      min: typeof fd.min === 'number' ? fd.min : undefined,
      max: typeof fd.max === 'number' ? fd.max : undefined,
    });
  }
  return {
    connector_id,
    version: c.version,
    record_format: c.record_format as ConnectorSchema['record_format'],
    primary_key: Array.isArray(c.primary_key) ? (c.primary_key as string[]) : [],
    fields,
  };
}
