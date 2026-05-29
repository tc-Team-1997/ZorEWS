// services/bff/src/case_type_config.ts
//
// Master Setup — Case Management Setup (MASTER SETUP spec screen #13).
//
// Per-tenant master of CASE TYPES. The doc's fields:
//   Case_Type · Priority · SLA · Assigned_Team
// Each case type carries a default priority (P1-P4, reused from the CMS
// vocabulary), an SLA in hours (time-to-resolve), and a default assigned
// team. When the CMS opens a case of a given type these defaults seed the
// case's priority + SLA + queue.
//
// Distinct from:
//   - /v1/admin/sla-config — a single GLOBAL sla config, not per-case-type.
//   - reassign_teams master (missing_masters) — the team VOCABULARY this
//     references; case types just store a team string.
//   - cms_cases.case_category — a free field on a live case; this is the
//     editable TYPE catalogue the SPA picker would populate from.
//
// In-memory + deterministic seed; env-gated pg swap target
// (data/schema/047_case_type_config.sql). No existing route/table touched.

// ─── Priority (reused from CMS) ──────────────────────────────────────

export const ALL_CASE_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type CasePriority = (typeof ALL_CASE_PRIORITIES)[number];
export function isCasePriority(v: unknown): v is CasePriority {
  return typeof v === 'string' && (ALL_CASE_PRIORITIES as readonly string[]).includes(v);
}
const PRIORITY_RANK: Record<CasePriority, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

export type CasePriorityFilter = CasePriority | 'all';

// ─── Shapes ──────────────────────────────────────────────────────────

export interface CaseTypeConfig {
  case_type_id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  priority: CasePriority;
  sla_hours: number; // time-to-resolve
  assigned_team: string; // default team (references reassign_teams vocab)
  enabled: boolean;
  sort_order: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CaseTypeCreateInput {
  code: string;
  name: string;
  description?: string | null;
  priority: CasePriority;
  sla_hours: number;
  assigned_team: string;
  enabled?: boolean;
}
export interface CaseTypeUpdateInput {
  name?: string;
  description?: string | null;
  priority?: CasePriority;
  sla_hours?: number;
  assigned_team?: string;
  enabled?: boolean;
}

export interface CaseTypeSummary {
  tenant_id: string;
  total: number;
  enabled_count: number;
  by_priority: Record<CasePriority, number>;
  mean_sla_hours: number | null; // over enabled types; null when none
  fastest_sla_hours: number | null;
  slowest_sla_hours: number | null;
}

// ─── Error ───────────────────────────────────────────────────────────

export type CaseTypeConfigErrorCode =
  | 'invalid_input'
  | 'invalid_priority'
  | 'invalid_sla'
  | 'duplicate_code'
  | 'unknown_case_type'
  | 'cap_reached';
export class CaseTypeConfigError extends Error {
  constructor(public code: CaseTypeConfigErrorCode, message: string) {
    super(message);
    this.name = 'CaseTypeConfigError';
  }
}

// ─── Limits ──────────────────────────────────────────────────────────

export const CASE_TYPE_CODE_MAX = 40;
export const CASE_TYPE_NAME_MAX = 200;
export const CASE_TYPE_DESC_MAX = 2000;
export const CASE_TYPE_TEAM_MAX = 120;
export const CASE_TYPES_PER_TENANT_MAX = 60;
export const SLA_HOURS_MAX = 8760; // one year
const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Seed (MASTER SETUP screen #13 example types) ────────────────────

interface SeedCaseType {
  code: string;
  name: string;
  description: string;
  priority: CasePriority;
  sla_hours: number;
  assigned_team: string;
}
const SEED: SeedCaseType[] = [
  { code: 'FRAUD_INVESTIGATION', name: 'Fraud Investigation', description: 'Suspected fraud — SIU workflow', priority: 'P1', sla_hours: 4, assigned_team: 'Fraud Desk' },
  { code: 'CREDIT_RISK_REVIEW', name: 'Credit Risk Review', description: 'Borrower deterioration / SMA movement', priority: 'P2', sla_hours: 24, assigned_team: 'Credit Risk Team' },
  { code: 'KYC_REMEDIATION', name: 'KYC Remediation', description: 'Expired / incomplete KYC follow-up', priority: 'P3', sla_hours: 72, assigned_team: 'Compliance' },
  { code: 'COLLECTIONS_FOLLOWUP', name: 'Collections Follow-up', description: 'Recovery + repayment chase', priority: 'P4', sla_hours: 168, assigned_team: 'Recovery Desk' },
];

// ─── Store ───────────────────────────────────────────────────────────

export class InMemoryCaseTypeConfigStore {
  private byTenant = new Map<string, CaseTypeConfig[]>();
  private seq = new Map<string, number>();

  private mintId(tenant: string): string {
    const n = (this.seq.get(tenant) ?? 0) + 1;
    this.seq.set(tenant, n);
    return `cty-${tenant}-${String(n).padStart(4, '0')}`;
  }

  private seeded(tenant: string): CaseTypeConfig[] {
    let rows = this.byTenant.get(tenant);
    if (rows) return rows;
    const iso = new Date(0).toISOString();
    rows = SEED.map((s, i) => ({
      case_type_id: this.mintId(tenant),
      tenant_id: tenant,
      code: s.code,
      name: s.name,
      description: s.description,
      priority: s.priority,
      sla_hours: s.sla_hours,
      assigned_team: s.assigned_team,
      enabled: true,
      sort_order: i,
      created_by: 'system',
      created_at: iso,
      updated_at: iso,
    }));
    this.byTenant.set(tenant, rows);
    return rows;
  }

  list(tenant: string, priority: CasePriorityFilter = 'all', enabledOnly = false): CaseTypeConfig[] {
    return this.seeded(tenant)
      .filter((r) => (priority === 'all' || r.priority === priority) && (!enabledOnly || r.enabled))
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code))
      .map((r) => structuredClone(r));
  }

  get(tenant: string, case_type_id: string): CaseTypeConfig | null {
    const row = this.seeded(tenant).find((r) => r.case_type_id === case_type_id);
    return row ? structuredClone(row) : null;
  }

  create(tenant: string, input: CaseTypeCreateInput, actor: string, nowMs: number): CaseTypeConfig {
    const rows = this.seeded(tenant);
    if (rows.length >= CASE_TYPES_PER_TENANT_MAX) {
      throw new CaseTypeConfigError('cap_reached', `case-type cap (${CASE_TYPES_PER_TENANT_MAX}) reached`);
    }
    const code = validateCode(input.code);
    if (rows.some((r) => r.code === code)) {
      throw new CaseTypeConfigError('duplicate_code', `case type code '${code}' already exists`);
    }
    const row: CaseTypeConfig = {
      case_type_id: this.mintId(tenant),
      tenant_id: tenant,
      code,
      name: validateName(input.name),
      description: validateDesc(input.description),
      priority: validatePriority(input.priority),
      sla_hours: validateSla(input.sla_hours),
      assigned_team: validateTeam(input.assigned_team),
      enabled: input.enabled ?? true,
      sort_order: rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.sort_order)) + 1,
      created_by: actor,
      created_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
    };
    rows.push(row);
    return structuredClone(row);
  }

  update(tenant: string, case_type_id: string, patch: CaseTypeUpdateInput, nowMs: number): CaseTypeConfig {
    const row = this.seeded(tenant).find((r) => r.case_type_id === case_type_id);
    if (!row) throw new CaseTypeConfigError('unknown_case_type', `unknown case type '${case_type_id}'`);
    if (patch.name !== undefined) row.name = validateName(patch.name);
    if (patch.description !== undefined) row.description = validateDesc(patch.description);
    if (patch.priority !== undefined) row.priority = validatePriority(patch.priority);
    if (patch.sla_hours !== undefined) row.sla_hours = validateSla(patch.sla_hours);
    if (patch.assigned_team !== undefined) row.assigned_team = validateTeam(patch.assigned_team);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new CaseTypeConfigError('invalid_input', 'enabled must be boolean');
      row.enabled = patch.enabled;
    }
    row.updated_at = new Date(nowMs).toISOString();
    return structuredClone(row);
  }

  remove(tenant: string, case_type_id: string): void {
    const rows = this.seeded(tenant);
    const idx = rows.findIndex((r) => r.case_type_id === case_type_id);
    if (idx < 0) throw new CaseTypeConfigError('unknown_case_type', `unknown case type '${case_type_id}'`);
    rows.splice(idx, 1);
  }
}

// ─── Pure summary ────────────────────────────────────────────────────

export function summarizeCaseTypes(tenant: string, rows: CaseTypeConfig[]): CaseTypeSummary {
  const by_priority: Record<CasePriority, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
  for (const r of rows) by_priority[r.priority]++;
  const enabled = rows.filter((r) => r.enabled);
  const slas = enabled.map((r) => r.sla_hours);
  return {
    tenant_id: tenant,
    total: rows.length,
    enabled_count: enabled.length,
    by_priority,
    mean_sla_hours: slas.length === 0 ? null : round2(slas.reduce((s, n) => s + n, 0) / slas.length),
    fastest_sla_hours: slas.length === 0 ? null : Math.min(...slas),
    slowest_sla_hours: slas.length === 0 ? null : Math.max(...slas),
  };
}

// Exported so callers can present priorities worst-first.
export function priorityRank(p: CasePriority): number {
  return PRIORITY_RANK[p];
}

// ─── Field validators ────────────────────────────────────────────────

function validateCode(raw: unknown): string {
  if (typeof raw !== 'string') throw new CaseTypeConfigError('invalid_input', 'code is required');
  const code = raw.trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new CaseTypeConfigError('invalid_input', `code must match ${CODE_RE} (≤ ${CASE_TYPE_CODE_MAX} chars)`);
  return code;
}
function validateName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new CaseTypeConfigError('invalid_input', 'name is required');
  const n = raw.trim();
  if (n.length > CASE_TYPE_NAME_MAX) throw new CaseTypeConfigError('invalid_input', `name exceeds ${CASE_TYPE_NAME_MAX} chars`);
  return n;
}
function validateDesc(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new CaseTypeConfigError('invalid_input', 'description must be a string');
  const d = raw.trim();
  if (d.length > CASE_TYPE_DESC_MAX) throw new CaseTypeConfigError('invalid_input', `description exceeds ${CASE_TYPE_DESC_MAX} chars`);
  return d || null;
}
function validatePriority(raw: unknown): CasePriority {
  if (!isCasePriority(raw)) throw new CaseTypeConfigError('invalid_priority', `priority must be one of ${ALL_CASE_PRIORITIES.join('/')}`);
  return raw;
}
function validateSla(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new CaseTypeConfigError('invalid_sla', 'sla_hours must be a finite number');
  if (raw <= 0 || raw > SLA_HOURS_MAX) throw new CaseTypeConfigError('invalid_sla', `sla_hours must be in (0, ${SLA_HOURS_MAX}]`);
  return round2(raw);
}
function validateTeam(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new CaseTypeConfigError('invalid_input', 'assigned_team is required');
  const t = raw.trim();
  if (t.length > CASE_TYPE_TEAM_MAX) throw new CaseTypeConfigError('invalid_input', `assigned_team exceeds ${CASE_TYPE_TEAM_MAX} chars`);
  return t;
}

// ─── Singleton ───────────────────────────────────────────────────────

export const defaultCaseTypeConfigStore = new InMemoryCaseTypeConfigStore();
export function _resetCaseTypeConfigStore(): void {
  const fresh = new InMemoryCaseTypeConfigStore();
  const target = defaultCaseTypeConfigStore as unknown as { byTenant: Map<string, unknown>; seq: Map<string, unknown> };
  const src = fresh as unknown as { byTenant: Map<string, unknown>; seq: Map<string, unknown> };
  target.byTenant = src.byTenant;
  target.seq = src.seq;
}
