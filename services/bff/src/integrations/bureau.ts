// services/bff/src/integrations/bureau.ts
//
// T6 M14.5 — Credit Bureau adapter (5th adapter in Module 14).
//
// Bureau pulls feed both banking (loan underwriting + monitoring) and
// insurance (premium pricing + agent persistency). The BIL pitch lists
// 4 supported bureaus: CIBIL, CRIF, EXPERIAN, EQUIFAX. M14.5 surfaces
// per-customer pull + report retrieval; the production adapter wires to
// the real bureau APIs. The stub holds an in-memory ledger keyed by
// (tenant, customer) and produces idempotent reports per day.

// ─── Public types ──────────────────────────────────────────────────────

export type BureauType = 'CIBIL' | 'CRIF' | 'EXPERIAN' | 'EQUIFAX';

/**
 * Score bands per the standard 300-900 scale used by all 4 bureaus
 * (CIBIL TransUnion convention; CRIF/Experian/Equifax compatible):
 *   < 600  subprime
 *   600-700 near_prime
 *   700-800 prime
 *   ≥ 800  super_prime
 */
export type BureauScoreBand = 'subprime' | 'near_prime' | 'prime' | 'super_prime';

export interface BureauReport {
  report_id: string;
  customer_id: string;
  bureau_type: BureauType;
  /** Bureau score on the 300-900 scale. */
  score: number;
  band: BureauScoreBand;
  /** ISO date the bureau pulled the report. */
  pulled_at: string;
  /** Reports become stale after 90 days. */
  expires_at: string;
  /** Username that triggered the pull. */
  pulled_by: string;
  summary: BureauReportSummary;
}

export interface BureauReportSummary {
  /** Active credit accounts. */
  open_accounts: number;
  /** Closed/settled accounts in the last 24 months. */
  closed_accounts_24m: number;
  /** Total outstanding across all open lines, in KES. */
  total_outstanding_kes: number;
  /** Total credit limit across all open lines, in KES. */
  total_limit_kes: number;
  /** Worst DPD in the last 24 months. */
  dpd_max_24m: number;
  /** Bureau enquiries in the last 3 months. */
  enquiries_3m: number;
  /** Months on bureau record. */
  months_on_record: number;
}

export interface BureauAdapter {
  /** Pull a fresh report. The stub enforces a 1-pull-per-tenant-per-
   *  customer-per-day idempotency: same caller, same day → same report
   *  (the bureau treats this as a cache hit). */
  pull(tenant_id: string, customer_id: string, bureau_type: BureauType, pulled_by: string, asOf: Date): Promise<BureauReport>;
  /** All reports for a customer, newest-pulled-first. */
  listByCustomer(tenant_id: string, customer_id: string): Promise<BureauReport[]>;
  /** Single report by id. Tenant-scoped. */
  get(tenant_id: string, report_id: string): Promise<BureauReport | null>;
}

export class BureauError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BureauError';
  }
}

const VALID_BUREAU_TYPES: BureauType[] = ['CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX'];

export function isBureauType(s: unknown): s is BureauType {
  return typeof s === 'string' && VALID_BUREAU_TYPES.includes(s as BureauType);
}

export function listBureauTypes(): BureauType[] {
  return [...VALID_BUREAU_TYPES];
}

export function bandFor(score: number): BureauScoreBand {
  if (score < 600) return 'subprime';
  if (score < 700) return 'near_prime';
  if (score < 800) return 'prime';
  return 'super_prime';
}

// ─── Deterministic PRNG ────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysAhead(d: Date, n: number): string {
  return new Date(d.getTime() + n * 86_400_000).toISOString();
}

// ─── Stub data synthesis ───────────────────────────────────────────────

function buildReport(
  tenant_id: string,
  customer_id: string,
  bureau_type: BureauType,
  pulled_by: string,
  asOf: Date,
): BureauReport {
  const seed = fnv1a(`bureau|${tenant_id}|${customer_id}|${bureau_type}|${dayOf(asOf)}`);
  const r = rng(seed);

  // Score distribution biased toward prime (~50%) with a long tail.
  // Roll a base 300-900 with realistic distribution.
  const roll = r();
  let score: number;
  if (roll < 0.10) score = 300 + Math.floor(r() * 250); // subprime 300-549
  else if (roll < 0.25) score = 550 + Math.floor(r() * 100); // near subprime 550-649
  else if (roll < 0.55) score = 650 + Math.floor(r() * 100); // near_prime/prime boundary
  else if (roll < 0.85) score = 720 + Math.floor(r() * 80); // prime 720-799
  else score = 800 + Math.floor(r() * 100); // super_prime 800-899

  const band = bandFor(score);

  // Summary calibrated by band — subprime customers carry more debt +
  // higher DPD; super_prime customers carry less.
  const open_accounts =
    band === 'subprime' ? 5 + Math.floor(r() * 8) :
    band === 'near_prime' ? 4 + Math.floor(r() * 6) :
    band === 'prime' ? 3 + Math.floor(r() * 5) :
    2 + Math.floor(r() * 4);
  const closed_accounts_24m = Math.floor(r() * 5);
  const total_outstanding_kes =
    band === 'subprime' ? 800_000 + Math.floor(r() * 4_200_000) :
    band === 'near_prime' ? 400_000 + Math.floor(r() * 2_600_000) :
    band === 'prime' ? 150_000 + Math.floor(r() * 1_350_000) :
    50_000 + Math.floor(r() * 950_000);
  const total_limit_kes = Math.round(total_outstanding_kes / (0.4 + r() * 0.5));
  const dpd_max_24m =
    band === 'subprime' ? 30 + Math.floor(r() * 270) :
    band === 'near_prime' ? Math.floor(r() * 60) :
    band === 'prime' ? Math.floor(r() * 30) :
    0;
  const enquiries_3m =
    band === 'subprime' ? 3 + Math.floor(r() * 6) :
    band === 'near_prime' ? 1 + Math.floor(r() * 4) :
    Math.floor(r() * 2);
  const months_on_record = 12 + Math.floor(r() * 240); // 1-21 years

  return {
    report_id: `bur-${tenant_id.slice(0, 3).toLowerCase()}-${(seed % 10_000_000).toString().padStart(7, '0')}`,
    customer_id,
    bureau_type,
    score,
    band,
    pulled_at: asOf.toISOString(),
    expires_at: daysAhead(asOf, 90),
    pulled_by,
    summary: {
      open_accounts,
      closed_accounts_24m,
      total_outstanding_kes,
      total_limit_kes,
      dpd_max_24m,
      enquiries_3m,
      months_on_record,
    },
  };
}

// ─── Stub adapter ──────────────────────────────────────────────────────

export class StubBureauAdapter implements BureauAdapter {
  /** tenant_id → customer_id → report_id → BureauReport. */
  private readonly byCustomer = new Map<string, Map<string, Map<string, BureauReport>>>();
  /** tenant_id → report_id → BureauReport. Reverse index. */
  private readonly byId = new Map<string, Map<string, BureauReport>>();
  /** Idempotency key: tenant|customer|bureau|day → report_id. */
  private readonly dailyDedup = new Map<string, string>();

  async pull(
    tenant_id: string,
    customer_id: string,
    bureau_type: BureauType,
    pulled_by: string,
    asOf: Date,
  ): Promise<BureauReport> {
    if (!tenant_id || typeof customer_id !== 'string' || !customer_id.trim()) {
      throw new BureauError('invalid_input', 'customer_id is required');
    }
    if (!isBureauType(bureau_type)) {
      throw new BureauError('invalid_bureau_type', `bureau_type must be one of ${VALID_BUREAU_TYPES.join(',')}`);
    }
    // Idempotency: same (tenant, customer, bureau, day) returns the
    // existing report. Bureau APIs cache identically.
    const dedupKey = `${tenant_id}|${customer_id}|${bureau_type}|${dayOf(asOf)}`;
    const existingId = this.dailyDedup.get(dedupKey);
    if (existingId) {
      const existing = this.byId.get(tenant_id)?.get(existingId);
      if (existing) return existing;
    }

    const report = buildReport(tenant_id, customer_id, bureau_type, pulled_by, asOf);
    let custCustomerMap = this.byCustomer.get(tenant_id);
    if (!custCustomerMap) {
      custCustomerMap = new Map();
      this.byCustomer.set(tenant_id, custCustomerMap);
    }
    let custMap = custCustomerMap.get(customer_id);
    if (!custMap) {
      custMap = new Map();
      custCustomerMap.set(customer_id, custMap);
    }
    custMap.set(report.report_id, report);

    let idMap = this.byId.get(tenant_id);
    if (!idMap) {
      idMap = new Map();
      this.byId.set(tenant_id, idMap);
    }
    idMap.set(report.report_id, report);
    this.dailyDedup.set(dedupKey, report.report_id);
    return report;
  }

  async listByCustomer(tenant_id: string, customer_id: string): Promise<BureauReport[]> {
    const m = this.byCustomer.get(tenant_id)?.get(customer_id);
    if (!m) return [];
    return [...m.values()].sort((a, b) => b.pulled_at.localeCompare(a.pulled_at));
  }

  async get(tenant_id: string, report_id: string): Promise<BureauReport | null> {
    return this.byId.get(tenant_id)?.get(report_id) ?? null;
  }

  /** Test helper. */
  reset(): void {
    this.byCustomer.clear();
    this.byId.clear();
    this.dailyDedup.clear();
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultBureauAdapter: BureauAdapter = new StubBureauAdapter();
