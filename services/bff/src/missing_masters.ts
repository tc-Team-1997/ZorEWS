// services/bff/src/missing_masters.ts
//
// Missing master-data screens — closes §2.3 #19 of
// ZorEWS_Pending_Gap_Analysis.md.
//
// Existing /v1/master/* covers: accounts, bureaus, customers, geographies,
// policies, sectors. This module adds the 12 missing master surfaces
// flagged by the gap doc as a single unified-store CRUD (type-tagged
// records) so all 12 share one validation pass + one set of HTTP routes.
//
//   GET    /v1/master/:master_type
//   POST   /v1/master/:master_type
//   GET    /v1/master/:master_type/:record_id
//   PATCH  /v1/master/:master_type/:record_id
//   DELETE /v1/master/:master_type/:record_id
//
// Supported master_type values + schema rules below.

export const MISSING_MASTER_TYPES = [
  'currencies',
  'source_types',
  'severity_levels',
  'borrower_segments',
  'regulators',
  'financial_ratios',
  'review_cadences',
  'reference_data',
  'roles_master',
  'reassign_basis',
  'recipients',
  'schedule_formats',
] as const;
export type MissingMasterType = (typeof MISSING_MASTER_TYPES)[number];

export interface MasterRecord {
  record_id: string;
  tenant_id: string;
  master_type: MissingMasterType;
  code: string;
  name: string;
  description: string;
  attributes: Record<string, string | number | boolean>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  created_by: string;
}

export class MasterDataError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'MasterDataError';
  }
}

export function isMissingMasterType(x: unknown): x is MissingMasterType {
  return typeof x === 'string' && MISSING_MASTER_TYPES.includes(x as MissingMasterType);
}

const _store = new Map<string, MasterRecord>();
let _seq = 0;

const CODE_RE = /^[A-Z0-9_]{2,32}$/;
const NAME_RE = /^[A-Za-z0-9 _.,()/-]{2,120}$/;

// Per-type required attribute keys (minimum). Extras allowed.
const REQUIRED_ATTRS: Record<MissingMasterType, string[]> = {
  currencies: ['symbol', 'decimals'],
  source_types: ['category'],
  severity_levels: ['rank'],
  borrower_segments: [],
  regulators: ['country', 'framework'],
  financial_ratios: ['formula', 'polarity'],
  review_cadences: ['interval_days'],
  reference_data: ['namespace'],
  roles_master: [],
  reassign_basis: [],
  recipients: ['channel', 'address'],
  schedule_formats: ['mime_type'],
};

function validateAttributesForType(type: MissingMasterType, attrs: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else throw new MasterDataError('invalid_attribute', `attribute ${k} must be string/number/boolean`);
  }
  for (const req of REQUIRED_ATTRS[type]) {
    if (!(req in out))
      throw new MasterDataError('missing_required_attribute', `master_type ${type} requires attribute "${req}"`);
  }
  return out;
}

function keyFor(tenant_id: string, type: MissingMasterType, code: string): string {
  return `${tenant_id}|${type}|${code}`;
}

const _codeIndex = new Map<string, string>(); // tenant|type|code → record_id

export function listMasterRecords(
  tenant_id: string,
  type: MissingMasterType,
  filter: { enabled_only?: boolean; q?: string } = {},
): MasterRecord[] {
  if (!tenant_id) throw new MasterDataError('invalid_input', 'tenant_id required');
  if (!isMissingMasterType(type)) throw new MasterDataError('unknown_master_type', `unknown ${type}`);
  const out: MasterRecord[] = [];
  for (const r of _store.values()) {
    if (r.tenant_id !== tenant_id) continue;
    if (r.master_type !== type) continue;
    if (filter.enabled_only && !r.enabled) continue;
    if (filter.q) {
      const q = filter.q.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.code.toLowerCase().includes(q)) continue;
    }
    out.push({ ...r, attributes: { ...r.attributes } });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

export function getMasterRecord(tenant_id: string, type: MissingMasterType, record_id: string): MasterRecord | null {
  if (!isMissingMasterType(type)) throw new MasterDataError('unknown_master_type', `unknown ${type}`);
  const found = _store.get(record_id);
  if (!found || found.tenant_id !== tenant_id || found.master_type !== type) return null;
  return { ...found, attributes: { ...found.attributes } };
}

export function createMasterRecord(
  tenant_id: string,
  type: MissingMasterType,
  input: { code: string; name: string; description?: string; attributes?: Record<string, unknown>; enabled?: boolean },
  actor: string,
  now: Date,
): MasterRecord {
  if (!tenant_id) throw new MasterDataError('invalid_input', 'tenant_id required');
  if (!isMissingMasterType(type)) throw new MasterDataError('unknown_master_type', `unknown ${type}`);
  if (!actor) throw new MasterDataError('invalid_input', 'actor required');
  if (!input.code || !CODE_RE.test(input.code))
    throw new MasterDataError('invalid_code', 'code must match ^[A-Z0-9_]{2,32}$');
  if (!input.name || !NAME_RE.test(input.name))
    throw new MasterDataError('invalid_name', 'name must match pattern');

  const dupKey = keyFor(tenant_id, type, input.code);
  if (_codeIndex.has(dupKey))
    throw new MasterDataError('duplicate_code', `code ${input.code} already exists in ${type}`);

  const attrs = validateAttributesForType(type, input.attributes ?? {});

  _seq++;
  const id = `m-${type}-${tenant_id}-${String(_seq).padStart(6, '0')}`;
  const entry: MasterRecord = {
    record_id: id,
    tenant_id,
    master_type: type,
    code: input.code,
    name: input.name,
    description: input.description ?? '',
    attributes: attrs,
    enabled: input.enabled !== false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    created_by: actor,
  };
  _store.set(id, entry);
  _codeIndex.set(dupKey, id);
  return { ...entry, attributes: { ...entry.attributes } };
}

export function updateMasterRecord(
  tenant_id: string,
  type: MissingMasterType,
  record_id: string,
  patch: Partial<{ name: string; description: string; attributes: Record<string, unknown>; enabled: boolean }>,
  now: Date,
): MasterRecord {
  if (!isMissingMasterType(type)) throw new MasterDataError('unknown_master_type', `unknown ${type}`);
  const entry = _store.get(record_id);
  if (!entry || entry.tenant_id !== tenant_id || entry.master_type !== type)
    throw new MasterDataError('unknown_record', `unknown ${record_id}`);
  if (patch.name !== undefined) {
    if (!NAME_RE.test(patch.name)) throw new MasterDataError('invalid_name', 'name invalid');
    entry.name = patch.name;
  }
  if (patch.description !== undefined) entry.description = patch.description;
  if (patch.attributes !== undefined) {
    const merged = { ...entry.attributes, ...patch.attributes };
    entry.attributes = validateAttributesForType(type, merged);
  }
  if (patch.enabled !== undefined) entry.enabled = patch.enabled;
  entry.updated_at = now.toISOString();
  return { ...entry, attributes: { ...entry.attributes } };
}

export function deleteMasterRecord(tenant_id: string, type: MissingMasterType, record_id: string): boolean {
  if (!isMissingMasterType(type)) throw new MasterDataError('unknown_master_type', `unknown ${type}`);
  const entry = _store.get(record_id);
  if (!entry || entry.tenant_id !== tenant_id || entry.master_type !== type) return false;
  _codeIndex.delete(keyFor(tenant_id, type, entry.code));
  _store.delete(record_id);
  return true;
}

export function _resetMissingMastersStore() {
  _store.clear();
  _codeIndex.clear();
  _seq = 0;
}
