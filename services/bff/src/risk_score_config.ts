// services/bff/src/risk_score_config.ts
//
// Master Setup — Risk Score Configuration (MASTER SETUP spec screen #11).
//
// A per-tenant set of NAMED scoring FACTORS, each carrying a percentage
// weight. The composite risk score is Σ(factor.weight_pct × factor signal),
// so the enabled factors' weights MUST sum to 100%. The headline operator
// affordance is rebalancing weights (drag / type) with a live "sums to
// 100%?" check + a one-click NORMALIZE that rescales enabled weights to
// exactly 100.
//
// Distinct from:
//   - /v1/scoring/presets (M6.3) — per-INDICATOR multiplier bundles for the
//     Σ(W×V) engine. That's indicator-grain; this is high-level factor-grain
//     (Overdue / EMI Bounce / Bureau Score / Transaction Behaviour …).
//   - /v1/master/:type (missing_masters) — flat code/name/attribute rows with
//     no cross-row sum constraint. Risk-score factors carry a sum-to-100
//     invariant + ordering, so they get a dedicated store.
//
// In-memory + deterministic seed; env-gated pg swap target
// (data/schema/045_risk_score_config.sql). No existing route/table touched.

// ─── Enums ───────────────────────────────────────────────────────────

export const ALL_SCORE_FACTOR_DOMAINS = ['banking', 'insurance', 'both'] as const;
export type ScoreFactorDomain = (typeof ALL_SCORE_FACTOR_DOMAINS)[number];
export function isScoreFactorDomain(v: unknown): v is ScoreFactorDomain {
  return typeof v === 'string' && (ALL_SCORE_FACTOR_DOMAINS as readonly string[]).includes(v);
}

// A `domain` query filter the SPA passes — 'all' returns every factor.
export type ScoreFactorDomainFilter = ScoreFactorDomain | 'all';

export interface ScoreFactor {
  factor_id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  domain: ScoreFactorDomain;
  weight_pct: number; // 0..100
  enabled: boolean;
  sort_order: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ScoreFactorCreateInput {
  code: string;
  name: string;
  description?: string | null;
  domain: ScoreFactorDomain;
  weight_pct: number;
  enabled?: boolean;
}
export interface ScoreFactorUpdateInput {
  name?: string;
  description?: string | null;
  domain?: ScoreFactorDomain;
  weight_pct?: number;
  enabled?: boolean;
}

export interface RiskScoreWeightSummary {
  domain: ScoreFactorDomainFilter;
  factor_count: number;
  enabled_count: number;
  total_weight_pct: number; // sum of ENABLED factor weights (rounded 2dp)
  balanced: boolean; // total_weight_pct === 100 (within 0.01 tolerance)
  remainder_pct: number; // 100 − total_weight_pct (signed; rounded 2dp)
}

// ─── Error ───────────────────────────────────────────────────────────

export type RiskScoreConfigErrorCode =
  | 'invalid_input'
  | 'invalid_domain'
  | 'invalid_weight'
  | 'duplicate_code'
  | 'unknown_factor'
  | 'cap_reached';
export class RiskScoreConfigError extends Error {
  constructor(public code: RiskScoreConfigErrorCode, message: string) {
    super(message);
    this.name = 'RiskScoreConfigError';
  }
}

// ─── Limits ──────────────────────────────────────────────────────────

export const FACTOR_CODE_MAX = 40;
export const FACTOR_NAME_MAX = 200;
export const FACTOR_DESC_MAX = 2000;
export const FACTORS_PER_TENANT_MAX = 40;
const CODE_RE = /^[A-Z][A-Z0-9_]{1,39}$/;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Seed (MASTER SETUP screen #11 example factors) ──────────────────

interface SeedFactor {
  code: string;
  name: string;
  description: string;
  domain: ScoreFactorDomain;
  weight_pct: number;
}
const SEED: SeedFactor[] = [
  // Banking — the doc's worked example (Overdue 30 / EMI Bounce 25 /
  // Bureau Score 20 / Transaction Behaviour 25 → sums to 100).
  { code: 'OVERDUE', name: 'Overdue / DPD', description: 'Principal or interest overdue ageing', domain: 'banking', weight_pct: 30 },
  { code: 'EMI_BOUNCE', name: 'EMI Bounce', description: 'Auto-debit / EMI dishonour frequency', domain: 'banking', weight_pct: 25 },
  { code: 'TXN_BEHAVIOUR', name: 'Transaction Behaviour', description: 'Account turnover + cash-flow anomalies', domain: 'banking', weight_pct: 25 },
  { code: 'BUREAU_SCORE', name: 'Bureau Score', description: 'External bureau score deterioration', domain: 'banking', weight_pct: 20 },
  // Insurance — a balanced 4-factor set (sums to 100).
  { code: 'PREMIUM_MISSED', name: 'Premium Missed', description: 'Missed / late premium payments', domain: 'insurance', weight_pct: 35 },
  { code: 'CLAIM_FREQUENCY', name: 'Claim Frequency', description: 'Claims raised in trailing window', domain: 'insurance', weight_pct: 30 },
  { code: 'PERSISTENCY', name: 'Persistency', description: '13/25/37M persistency shortfall', domain: 'insurance', weight_pct: 20 },
  { code: 'LAPSE_RISK', name: 'Lapse Risk', description: 'Model-scored lapse probability', domain: 'insurance', weight_pct: 15 },
];

// ─── Store ───────────────────────────────────────────────────────────

export class InMemoryRiskScoreConfigStore {
  private byTenant = new Map<string, ScoreFactor[]>();
  private seq = new Map<string, number>();

  private seeded(tenant: string): ScoreFactor[] {
    let rows = this.byTenant.get(tenant);
    if (rows) return rows;
    const nowIso = new Date(0).toISOString();
    rows = SEED.map((s, i) => ({
      factor_id: this.mintId(tenant),
      tenant_id: tenant,
      code: s.code,
      name: s.name,
      description: s.description,
      domain: s.domain,
      weight_pct: s.weight_pct,
      enabled: true,
      sort_order: i,
      created_by: 'system',
      created_at: nowIso,
      updated_at: nowIso,
    }));
    this.byTenant.set(tenant, rows);
    return rows;
  }

  private mintId(tenant: string): string {
    const n = (this.seq.get(tenant) ?? 0) + 1;
    this.seq.set(tenant, n);
    return `rsf-${tenant}-${String(n).padStart(4, '0')}`;
  }

  list(tenant: string, domain: ScoreFactorDomainFilter = 'all'): ScoreFactor[] {
    const rows = this.seeded(tenant)
      .filter((r) => domain === 'all' || r.domain === domain)
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
    return rows.map((r) => structuredClone(r));
  }

  get(tenant: string, factor_id: string): ScoreFactor | null {
    const row = this.seeded(tenant).find((r) => r.factor_id === factor_id);
    return row ? structuredClone(row) : null;
  }

  create(tenant: string, input: ScoreFactorCreateInput, actor: string, nowMs: number): ScoreFactor {
    const rows = this.seeded(tenant);
    if (rows.length >= FACTORS_PER_TENANT_MAX) {
      throw new RiskScoreConfigError('cap_reached', `factor cap (${FACTORS_PER_TENANT_MAX}) reached for tenant`);
    }
    const code = validateCode(input.code);
    if (rows.some((r) => r.code === code)) {
      throw new RiskScoreConfigError('duplicate_code', `factor code '${code}' already exists`);
    }
    const name = validateName(input.name);
    const description = validateDesc(input.description);
    if (!isScoreFactorDomain(input.domain)) {
      throw new RiskScoreConfigError('invalid_domain', `unknown domain '${String(input.domain)}'`);
    }
    const weight_pct = validateWeight(input.weight_pct);
    const iso = new Date(nowMs).toISOString();
    const row: ScoreFactor = {
      factor_id: this.mintId(tenant),
      tenant_id: tenant,
      code,
      name,
      description,
      domain: input.domain,
      weight_pct,
      enabled: input.enabled ?? true,
      sort_order: rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.sort_order)) + 1,
      created_by: actor,
      created_at: iso,
      updated_at: iso,
    };
    rows.push(row);
    return structuredClone(row);
  }

  update(tenant: string, factor_id: string, patch: ScoreFactorUpdateInput, nowMs: number): ScoreFactor {
    const rows = this.seeded(tenant);
    const row = rows.find((r) => r.factor_id === factor_id);
    if (!row) throw new RiskScoreConfigError('unknown_factor', `unknown factor '${factor_id}'`);
    if (patch.name !== undefined) row.name = validateName(patch.name);
    if (patch.description !== undefined) row.description = validateDesc(patch.description);
    if (patch.domain !== undefined) {
      if (!isScoreFactorDomain(patch.domain)) {
        throw new RiskScoreConfigError('invalid_domain', `unknown domain '${String(patch.domain)}'`);
      }
      row.domain = patch.domain;
    }
    if (patch.weight_pct !== undefined) row.weight_pct = validateWeight(patch.weight_pct);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new RiskScoreConfigError('invalid_input', 'enabled must be boolean');
      row.enabled = patch.enabled;
    }
    row.updated_at = new Date(nowMs).toISOString();
    return structuredClone(row);
  }

  remove(tenant: string, factor_id: string): void {
    const rows = this.seeded(tenant);
    const idx = rows.findIndex((r) => r.factor_id === factor_id);
    if (idx < 0) throw new RiskScoreConfigError('unknown_factor', `unknown factor '${factor_id}'`);
    rows.splice(idx, 1);
  }

  // Reorder a domain's factors to the given id sequence. ids must be exactly
  // the set of factor_ids in that domain (any order). sort_order is rewritten
  // to the supplied sequence; factors in other domains are untouched.
  reorder(tenant: string, domain: ScoreFactorDomain, orderedIds: string[], nowMs: number): ScoreFactor[] {
    if (!isScoreFactorDomain(domain)) {
      throw new RiskScoreConfigError('invalid_domain', `unknown domain '${String(domain)}'`);
    }
    if (!Array.isArray(orderedIds)) throw new RiskScoreConfigError('invalid_input', 'ordered_ids must be an array');
    const rows = this.seeded(tenant);
    const domainRows = rows.filter((r) => r.domain === domain);
    const domainIds = new Set(domainRows.map((r) => r.factor_id));
    if (orderedIds.length !== domainRows.length || orderedIds.some((id) => !domainIds.has(id)) || new Set(orderedIds).size !== orderedIds.length) {
      throw new RiskScoreConfigError('invalid_input', 'ordered_ids must be the exact set of factor_ids in this domain');
    }
    const iso = new Date(nowMs).toISOString();
    orderedIds.forEach((id, i) => {
      const row = rows.find((r) => r.factor_id === id)!;
      row.sort_order = i;
      row.updated_at = iso;
    });
    return this.list(tenant, domain);
  }

  // Rescale the ENABLED factors of a domain so their weights sum to exactly
  // 100. Proportional scaling; the last enabled factor absorbs rounding drift
  // so the post-condition sum === 100 holds exactly. Disabled factors keep
  // their weight (they don't count toward the score). Throws invalid_input
  // when there are no enabled factors OR their current sum is 0 (nothing to
  // scale from).
  normalize(tenant: string, domain: ScoreFactorDomain, nowMs: number): ScoreFactor[] {
    if (!isScoreFactorDomain(domain)) {
      throw new RiskScoreConfigError('invalid_domain', `unknown domain '${String(domain)}'`);
    }
    const rows = this.seeded(tenant);
    const enabled = rows.filter((r) => r.domain === domain && r.enabled).sort((a, b) => a.sort_order - b.sort_order);
    if (enabled.length === 0) throw new RiskScoreConfigError('invalid_input', 'no enabled factors to normalize');
    const sum = enabled.reduce((s, r) => s + r.weight_pct, 0);
    if (sum <= 0) throw new RiskScoreConfigError('invalid_input', 'enabled factor weights sum to 0 — cannot normalize');
    const iso = new Date(nowMs).toISOString();
    let running = 0;
    enabled.forEach((row, i) => {
      if (i === enabled.length - 1) {
        row.weight_pct = round2(100 - running);
      } else {
        const scaled = round2((row.weight_pct / sum) * 100);
        row.weight_pct = scaled;
        running += scaled;
      }
      row.updated_at = iso;
    });
    return this.list(tenant, domain);
  }
}

// ─── Pure summary ────────────────────────────────────────────────────

export function summarizeWeights(factors: ScoreFactor[], domain: ScoreFactorDomainFilter): RiskScoreWeightSummary {
  const enabled = factors.filter((f) => f.enabled);
  const total = round2(enabled.reduce((s, f) => s + f.weight_pct, 0));
  return {
    domain,
    factor_count: factors.length,
    enabled_count: enabled.length,
    total_weight_pct: total,
    balanced: Math.abs(total - 100) < 0.01,
    remainder_pct: round2(100 - total),
  };
}

// ─── Field validators ────────────────────────────────────────────────

function validateCode(raw: unknown): string {
  if (typeof raw !== 'string') throw new RiskScoreConfigError('invalid_input', 'code is required');
  const code = raw.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new RiskScoreConfigError('invalid_input', `code must match ${CODE_RE} (≤ ${FACTOR_CODE_MAX} chars)`);
  }
  return code;
}
function validateName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new RiskScoreConfigError('invalid_input', 'name is required');
  const name = raw.trim();
  if (name.length > FACTOR_NAME_MAX) throw new RiskScoreConfigError('invalid_input', `name exceeds ${FACTOR_NAME_MAX} chars`);
  return name;
}
function validateDesc(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new RiskScoreConfigError('invalid_input', 'description must be a string');
  const d = raw.trim();
  if (d.length > FACTOR_DESC_MAX) throw new RiskScoreConfigError('invalid_input', `description exceeds ${FACTOR_DESC_MAX} chars`);
  return d || null;
}
function validateWeight(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new RiskScoreConfigError('invalid_weight', 'weight_pct must be a finite number');
  }
  if (raw < 0 || raw > 100) throw new RiskScoreConfigError('invalid_weight', 'weight_pct must be in [0, 100]');
  return round2(raw);
}

// ─── Singleton ───────────────────────────────────────────────────────

export const defaultRiskScoreConfigStore = new InMemoryRiskScoreConfigStore();
export function _resetRiskScoreConfigStore(): void {
  const fresh = new InMemoryRiskScoreConfigStore();
  const target = defaultRiskScoreConfigStore as unknown as {
    byTenant: Map<string, unknown>;
    seq: Map<string, unknown>;
  };
  const src = fresh as unknown as { byTenant: Map<string, unknown>; seq: Map<string, unknown> };
  target.byTenant = src.byTenant;
  target.seq = src.seq;
}
