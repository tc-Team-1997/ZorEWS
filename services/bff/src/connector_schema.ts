// services/bff/src/connector_schema.ts
//
// T6 M3.2 — Connector schema metadata.
//
// M3.1 ships the 8-connector ingestion registry but stops at the
// connector-level metadata (name, type, schedule, status). M3.2
// attaches the *field-level* schema each connector expects so the
// ingestion UI can:
//   1. render a "preview / column-mapper" step before file upload.
//   2. validate a sample row client-side OR server-side.
//   3. surface required vs optional fields + types + sample values.
//
// Design: pure-data tables + pure validator. No store, no AppDeps
// slot — schema metadata is platform-static and identical across
// tenants (the SAME upstream system speaks the SAME wire format).
// Per-tenant *overrides* would be a future M3.3.
//
// Two routes (both read-only):
//   GET  /v1/ingestion/connectors/:id/schema
//   POST /v1/ingestion/connectors/:id/schema/validate { record }
//
// Validation rules:
//   - required fields must be present and not null/undefined/'' (after trim)
//   - type: string | integer | number | boolean | date | datetime | enum
//   - enum: value must be in `enum_values`
//   - string: optional max_length cap
//   - number/integer: optional min/max bounds (inclusive)
//   - extra fields → reported as `unknown_field` warnings (not errors)

import { SEED_CONNECTORS, type ConnectorDef } from './ingestion';

// ─── Public types ──────────────────────────────────────────────────────

export type FieldType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'      // ISO-8601 calendar date YYYY-MM-DD
  | 'datetime'  // ISO-8601 timestamp
  | 'enum';

export interface FieldDef {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
  /** Sample value the SPA can show in the column-mapper preview. */
  sample: string;
  /** For type = 'enum'. */
  enum_values?: readonly string[];
  /** For type = 'string'. */
  max_length?: number;
  /** For type = 'integer' | 'number'. Inclusive bounds. */
  min?: number;
  max?: number;
}

export type RecordFormat = 'kafka_json' | 'csv' | 'sftp_csv' | 'rest_json';

export interface ConnectorSchema {
  connector_id: string;
  /** Schema-version string. Bumping forces clients to re-fetch. */
  version: string;
  /** Wire-format the connector expects. */
  record_format: RecordFormat;
  /** Field names that together form the natural primary key. */
  primary_key: readonly string[];
  fields: readonly FieldDef[];
}

export interface ValidationError {
  field: string;
  code:
    | 'required'
    | 'wrong_type'
    | 'enum_violation'
    | 'too_long'
    | 'out_of_range'
    | 'unknown_field';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  connector_id: string;
  schema_version: string;
  errors: ValidationError[];
  warnings: ValidationError[];
}

export class ConnectorSchemaError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ConnectorSchemaError';
  }
}

// ─── Schema tables (1 per seed connector) ─────────────────────────────

const SCHEMA_VERSION = '1.0.0';

const CBS_LOAN_BOOK: ConnectorSchema = {
  connector_id: 'cbs_loan_book',
  version: SCHEMA_VERSION,
  record_format: 'kafka_json',
  primary_key: ['account_id'],
  fields: [
    { name: 'customer_id', type: 'string', required: true, description: 'BIL customer identifier', sample: 'CUST-100123', max_length: 32 },
    { name: 'account_id', type: 'string', required: true, description: 'Loan account number', sample: 'LN-9001234', max_length: 32 },
    { name: 'product_type', type: 'enum', required: true, description: 'Loan product class', sample: 'home_loan', enum_values: ['home_loan', 'personal_loan', 'auto_loan', 'business_loan', 'credit_card'] },
    { name: 'outstanding_balance', type: 'number', required: true, description: 'Current principal outstanding (INR)', sample: '1250000.00', min: 0 },
    { name: 'dpd', type: 'integer', required: true, description: 'Days past due', sample: '0', min: 0, max: 720 },
    { name: 'sanctioned_amount', type: 'number', required: true, description: 'Original sanctioned amount (INR)', sample: '1500000.00', min: 0 },
    { name: 'disbursed_at', type: 'datetime', required: true, description: 'When the loan was disbursed', sample: '2024-08-12T09:30:00Z' },
    { name: 'interest_rate', type: 'number', required: false, description: 'Annual rate (%)', sample: '8.5', min: 0, max: 100 },
    { name: 'last_payment_at', type: 'datetime', required: false, description: 'Most recent EMI receipt', sample: '2026-04-15T10:00:00Z' },
    { name: 'status', type: 'enum', required: true, description: 'Account state', sample: 'standard', enum_values: ['standard', 'special_mention', 'sub_standard', 'doubtful', 'loss', 'closed'] },
  ],
};

const CORE_INSURANCE_POLICIES: ConnectorSchema = {
  connector_id: 'core_insurance_policies',
  version: SCHEMA_VERSION,
  record_format: 'sftp_csv',
  primary_key: ['policy_id'],
  fields: [
    { name: 'policy_id', type: 'string', required: true, description: 'BIL policy identifier', sample: 'POL-BIL-200001', max_length: 32 },
    { name: 'customer_id', type: 'string', required: true, description: 'Policy holder', sample: 'CUST-100123', max_length: 32 },
    { name: 'product', type: 'enum', required: true, description: 'Insurance product', sample: 'term_life', enum_values: ['term_life', 'whole_life', 'endowment', 'ulip', 'health', 'motor', 'home', 'travel'] },
    { name: 'sum_assured', type: 'number', required: true, description: 'Cover amount (INR)', sample: '5000000.00', min: 0 },
    { name: 'premium', type: 'number', required: true, description: 'Annual premium (INR)', sample: '24500.00', min: 0 },
    { name: 'start_date', type: 'date', required: true, description: 'Policy effective date', sample: '2024-01-15' },
    { name: 'end_date', type: 'date', required: true, description: 'Policy expiry / maturity date', sample: '2034-01-15' },
    { name: 'status', type: 'enum', required: true, description: 'Policy state', sample: 'active', enum_values: ['active', 'lapsed', 'matured', 'surrendered', 'claim_paid', 'cancelled'] },
  ],
};

const POLICY_MASTER_INCREMENT: ConnectorSchema = {
  connector_id: 'policy_master_increment',
  version: SCHEMA_VERSION,
  record_format: 'kafka_json',
  primary_key: ['policy_id', 'change_at'],
  fields: [
    { name: 'policy_id', type: 'string', required: true, description: 'Policy that changed', sample: 'POL-BIL-200001', max_length: 32 },
    { name: 'change_type', type: 'enum', required: true, description: 'What changed', sample: 'premium_paid', enum_values: ['issued', 'premium_paid', 'lapsed', 'reinstated', 'rider_added', 'rider_removed', 'surrendered', 'matured'] },
    { name: 'change_at', type: 'datetime', required: true, description: 'When the change occurred', sample: '2026-05-04T08:15:00Z' },
    { name: 'customer_id', type: 'string', required: true, description: 'Policy holder', sample: 'CUST-100123', max_length: 32 },
    { name: 'premium_delta', type: 'number', required: false, description: 'Premium amount change (INR)', sample: '24500.00' },
  ],
};

const CLAIMS_FEED: ConnectorSchema = {
  connector_id: 'claims_feed',
  version: SCHEMA_VERSION,
  record_format: 'kafka_json',
  primary_key: ['claim_id'],
  fields: [
    { name: 'claim_id', type: 'string', required: true, description: 'BIL claim identifier', sample: 'CLM-BIL-700001', max_length: 32 },
    { name: 'policy_id', type: 'string', required: true, description: 'Policy under which claim filed', sample: 'POL-BIL-200001', max_length: 32 },
    { name: 'customer_id', type: 'string', required: true, description: 'Claimant', sample: 'CUST-100123', max_length: 32 },
    { name: 'claim_amount', type: 'number', required: true, description: 'Claim amount (INR)', sample: '125000.00', min: 0 },
    { name: 'claim_type', type: 'enum', required: true, description: 'Cause of claim', sample: 'illness', enum_values: ['death', 'illness', 'accident', 'damage', 'theft', 'maturity', 'surrender', 'other'] },
    { name: 'filed_at', type: 'datetime', required: true, description: 'Claim submission timestamp', sample: '2026-05-01T11:20:00Z' },
    { name: 'status', type: 'enum', required: true, description: 'Workflow stage', sample: 'submitted', enum_values: ['submitted', 'under_review', 'investigating', 'approved', 'paid', 'rejected', 'withdrawn'] },
  ],
};

const AGENT_PRODUCTIVITY: ConnectorSchema = {
  connector_id: 'agent_productivity',
  version: SCHEMA_VERSION,
  record_format: 'csv',
  primary_key: ['agent_id', 'period_month'],
  fields: [
    { name: 'agent_id', type: 'string', required: true, description: 'BIL agent code', sample: 'AGT-001234', max_length: 16 },
    { name: 'branch_code', type: 'string', required: true, description: 'Originating branch', sample: 'BR-MUM-007', max_length: 16 },
    { name: 'period_month', type: 'date', required: true, description: 'First-of-month for the rollup', sample: '2026-04-01' },
    { name: 'policies_sold', type: 'integer', required: true, description: 'Policies issued in the month', sample: '12', min: 0, max: 5000 },
    { name: 'persistency_rate', type: 'number', required: true, description: '13-month persistency (0-1)', sample: '0.82', min: 0, max: 1 },
    { name: 'churn_rate', type: 'number', required: false, description: 'Voluntary surrender rate (0-1)', sample: '0.04', min: 0, max: 1 },
  ],
};

const AML_WATCHLIST: ConnectorSchema = {
  connector_id: 'aml_watchlist',
  version: SCHEMA_VERSION,
  record_format: 'rest_json',
  primary_key: ['list_id'],
  fields: [
    { name: 'list_id', type: 'string', required: true, description: 'AML list-entry identifier', sample: 'OFAC-SDN-12345', max_length: 64 },
    { name: 'list_type', type: 'enum', required: true, description: 'Watchlist category', sample: 'sanctions', enum_values: ['sanctions', 'pep', 'adverse_media', 'internal'] },
    { name: 'entity_name', type: 'string', required: true, description: 'Sanctioned individual/entity', sample: 'John Doe', max_length: 200 },
    { name: 'entity_type', type: 'enum', required: true, description: 'Person or organisation', sample: 'individual', enum_values: ['individual', 'organisation', 'vessel', 'aircraft'] },
    { name: 'country', type: 'string', required: false, description: 'ISO-3166-1 alpha-2 code', sample: 'IN', max_length: 2 },
    { name: 'date_added', type: 'date', required: true, description: 'When this entry was published', sample: '2026-04-22' },
  ],
};

const BUREAU_PULL: ConnectorSchema = {
  connector_id: 'bureau_pull',
  version: SCHEMA_VERSION,
  record_format: 'rest_json',
  primary_key: ['customer_id', 'bureau_name', 'pulled_at'],
  fields: [
    { name: 'customer_id', type: 'string', required: true, description: 'BIL customer identifier', sample: 'CUST-100123', max_length: 32 },
    { name: 'bureau_name', type: 'enum', required: true, description: 'Source bureau', sample: 'CIBIL', enum_values: ['CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX'] },
    { name: 'score', type: 'integer', required: true, description: 'Bureau credit score (300-900)', sample: '780', min: 300, max: 900 },
    { name: 'dpd_max_24m', type: 'integer', required: true, description: 'Worst DPD across 24-month trail', sample: '15', min: 0, max: 720 },
    { name: 'enquiries_6m', type: 'integer', required: true, description: 'Hard enquiries in last 6 months', sample: '2', min: 0, max: 100 },
    { name: 'pulled_at', type: 'datetime', required: true, description: 'When this report was pulled', sample: '2026-04-30T01:00:00Z' },
  ],
};

const IFRS9_STAGE_FEED: ConnectorSchema = {
  connector_id: 'ifrs9_stage_feed',
  version: SCHEMA_VERSION,
  record_format: 'rest_json',
  primary_key: ['customer_id', 'snapshot_date'],
  fields: [
    { name: 'customer_id', type: 'string', required: true, description: 'BIL customer identifier', sample: 'CUST-100123', max_length: 32 },
    { name: 'stage', type: 'integer', required: true, description: 'IFRS 9 stage 1/2/3', sample: '1', min: 1, max: 3 },
    { name: 'pd', type: 'number', required: true, description: 'Probability of default (0-1)', sample: '0.012', min: 0, max: 1 },
    { name: 'lgd', type: 'number', required: true, description: 'Loss given default (0-1)', sample: '0.45', min: 0, max: 1 },
    { name: 'ead', type: 'number', required: true, description: 'Exposure at default (INR)', sample: '1250000.00', min: 0 },
    { name: 'ecl', type: 'number', required: true, description: 'Expected credit loss = pd × lgd × ead', sample: '6750.00', min: 0 },
    { name: 'snapshot_date', type: 'date', required: true, description: 'IFRS 9 snapshot calendar date', sample: '2026-04-30' },
  ],
};

const SCHEMAS_BY_ID: Record<string, ConnectorSchema> = {
  cbs_loan_book: CBS_LOAN_BOOK,
  core_insurance_policies: CORE_INSURANCE_POLICIES,
  policy_master_increment: POLICY_MASTER_INCREMENT,
  claims_feed: CLAIMS_FEED,
  agent_productivity: AGENT_PRODUCTIVITY,
  aml_watchlist: AML_WATCHLIST,
  bureau_pull: BUREAU_PULL,
  ifrs9_stage_feed: IFRS9_STAGE_FEED,
};

// ─── Public read API ───────────────────────────────────────────────────

/** All registered connector ids (1 per M3.1 seed connector). */
export function listSchemaConnectorIds(): string[] {
  return Object.keys(SCHEMAS_BY_ID);
}

/** Returns the schema for `connector_id`, or null if not registered. */
export function getConnectorSchema(connector_id: string): ConnectorSchema | null {
  return SCHEMAS_BY_ID[connector_id] ?? null;
}

/** Static cross-check that every M3.1 seed connector has a schema —
 *  flips on import-time so the test suite catches drift fast. */
export function assertSchemaCoverage(seeds: readonly ConnectorDef[] = SEED_CONNECTORS): void {
  for (const s of seeds) {
    if (!SCHEMAS_BY_ID[s.id]) {
      throw new ConnectorSchemaError(
        'missing_schema',
        `connector ${s.id} has no schema registered`,
      );
    }
  }
}

// ─── Validation ────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function isMissing(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string' && v.trim().length === 0) return true;
  return false;
}

function checkType(field: FieldDef, value: unknown): ValidationError | null {
  switch (field.type) {
    case 'string':
    case 'enum':
      if (typeof value !== 'string') {
        return { field: field.name, code: 'wrong_type', message: `${field.name}: expected string, got ${typeof value}` };
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return { field: field.name, code: 'wrong_type', message: `${field.name}: expected integer` };
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { field: field.name, code: 'wrong_type', message: `${field.name}: expected number` };
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { field: field.name, code: 'wrong_type', message: `${field.name}: expected boolean` };
      }
      break;
    case 'date':
      if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) {
        return { field: field.name, code: 'wrong_type', message: `${field.name}: expected ISO date YYYY-MM-DD` };
      }
      break;
    case 'datetime':
      if (typeof value !== 'string' || !ISO_DATETIME_RE.test(value)) {
        return { field: field.name, code: 'wrong_type', message: `${field.name}: expected ISO datetime` };
      }
      break;
  }
  return null;
}

/**
 * Validate a single record against a connector schema.
 * Pure function — no I/O, no mutation.
 */
export function validateRecord(
  connector_id: string,
  record: unknown,
): ValidationResult {
  const schema = SCHEMAS_BY_ID[connector_id];
  if (!schema) {
    throw new ConnectorSchemaError('unknown_connector', `unknown connector: ${connector_id}`);
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ConnectorSchemaError('invalid_input', 'record must be a JSON object');
  }
  const obj = record as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // Forward pass: each declared field.
  for (const field of schema.fields) {
    const v = obj[field.name];
    const missing = isMissing(v);
    if (missing) {
      if (field.required) {
        errors.push({
          field: field.name,
          code: 'required',
          message: `${field.name} is required`,
        });
      }
      continue; // skip type check on missing optional
    }
    const typeErr = checkType(field, v);
    if (typeErr) {
      errors.push(typeErr);
      continue;
    }
    if (field.type === 'enum' && field.enum_values) {
      if (!field.enum_values.includes(v as string)) {
        errors.push({
          field: field.name,
          code: 'enum_violation',
          message: `${field.name}: '${v}' not in [${field.enum_values.join(', ')}]`,
        });
        continue;
      }
    }
    if (field.type === 'string' && typeof v === 'string' && field.max_length !== undefined) {
      if (v.length > field.max_length) {
        errors.push({
          field: field.name,
          code: 'too_long',
          message: `${field.name}: ${v.length} chars exceeds max ${field.max_length}`,
        });
        continue;
      }
    }
    if ((field.type === 'integer' || field.type === 'number') && typeof v === 'number') {
      if (field.min !== undefined && v < field.min) {
        errors.push({
          field: field.name,
          code: 'out_of_range',
          message: `${field.name}: ${v} below min ${field.min}`,
        });
        continue;
      }
      if (field.max !== undefined && v > field.max) {
        errors.push({
          field: field.name,
          code: 'out_of_range',
          message: `${field.name}: ${v} above max ${field.max}`,
        });
        continue;
      }
    }
  }

  // Reverse pass: extra keys in record that aren't in schema → warning.
  const known = new Set(schema.fields.map((f) => f.name));
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) {
      warnings.push({
        field: k,
        code: 'unknown_field',
        message: `${k} is not in the ${connector_id} schema (will be ignored)`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    connector_id,
    schema_version: schema.version,
    errors,
    warnings,
  };
}
