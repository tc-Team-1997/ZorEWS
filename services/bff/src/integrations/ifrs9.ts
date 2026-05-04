// services/bff/src/integrations/ifrs9.ts
//
// T6 M14.2 — IFRS9 Stage adapter (second adapter in Module 14).
//
// IFRS9 (International Financial Reporting Standard 9) is the
// regulatory standard that classifies financial assets into 3 stages:
//   Stage 1 — performing, 12-month PD-based ECL
//   Stage 2 — under-performing (significant credit deterioration),
//             lifetime PD-based ECL
//   Stage 3 — non-performing (credit-impaired), lifetime ECL on
//             gross carrying amount
//
// The BIL pitch (DataNetworks-EWS-Ver1.pdf) lists IFRS9 as one of the
// 11 regulatory upstreams. This adapter provides per-customer stage
// + ECL data so the SPA can render the staging panel alongside risk
// profile + indicators.
//
// Same interface contract as the InsuranceAdapter in M14.1: stub for
// the prototype with deterministic synthetic data; production swaps in
// an HTTP adapter that calls the IFRS 9 engine.

// ─── Types ─────────────────────────────────────────────────────────────

export type Ifrs9StageNum = 1 | 2 | 3;

export interface Ifrs9Stage {
  customer_id: string;
  /** 1 / 2 / 3 per IFRS9 spec. */
  stage: Ifrs9StageNum;
  /** 12-month PD for Stage 1; Stage 2/3 also report this for trend. 0..1. */
  pd_12m: number;
  /** Lifetime PD — drives ECL for Stage 2 + 3. 0..1. */
  pd_lifetime: number;
  /** Loss Given Default — fraction of EAD lost in default scenario. 0..1. */
  lgd: number;
  /** Exposure at Default in KES. */
  ead_kes: number;
  /** Expected Credit Loss in KES (PD × LGD × EAD, rounded). */
  ecl_kes: number;
  /** Days past due triggering the SICR (Significant Increase in Credit
   *  Risk) move from Stage 1→2. 0 when Stage 1. */
  dpd_days: number;
  /** Reason text for the current stage assignment. */
  stage_reason: string;
  /** ISO date of the most-recent stage assessment. */
  evaluation_date: string;
}

export interface Ifrs9StageListPage {
  items: Ifrs9Stage[];
  /** 1-based current page. */
  page: number;
  page_size: number;
  /** Total matching the filter (across all pages). */
  total: number;
  /** Active filter — null when listing all stages. */
  stage_filter: Ifrs9StageNum | null;
}

export interface Ifrs9Adapter {
  /** Fetch a single customer's stage. Returns null when the customer
   *  has no IFRS9 record (not in the loan book). */
  getStage(tenant_id: string, customer_id: string, asOf: Date): Promise<Ifrs9Stage | null>;
  /**
   * Paginated list of customers in the loan book, optionally filtered
   * by stage. The stub fixes the book size at 200 customers per tenant
   * for deterministic pagination.
   */
  listStages(
    tenant_id: string,
    opts: { stage?: Ifrs9StageNum; page?: number; page_size?: number },
    asOf: Date,
  ): Promise<Ifrs9StageListPage>;
}

// ─── Deterministic PRNG (FNV-1a + Mulberry32) ──────────────────────────
// Same scheme as bil_dashboards.ts + integrations/insurance.ts.

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seedFrom(...parts: (string | number)[]): number {
  return fnv1a(parts.map(String).join('|'));
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

function daysBefore(d: Date, n: number): string {
  return new Date(d.getTime() - n * 86_400_000).toISOString();
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ─── Stub adapter ──────────────────────────────────────────────────────

const BOOK_SIZE = 200;

const STAGE_REASONS: Record<Ifrs9StageNum, string[]> = {
  1: ['performing', 'no SICR triggers', 'PD within 12-month range'],
  2: [
    'DPD 30+ but <90',
    'PD increased > 50% since origination',
    'watchlist flag raised',
    'restructuring under negotiation',
  ],
  3: [
    'DPD 90+ — credit-impaired',
    'restructured with concession',
    'bankruptcy filed',
    'forbearance applied',
  ],
};

function buildStage(tenant_id: string, customer_id: string, asOf: Date): Ifrs9Stage {
  const seed = seedFrom('ifrs9', tenant_id, customer_id, dayOf(asOf));
  const r = rng(seed);

  // Stage distribution: 80% S1, 15% S2, 5% S3 — realistic banking book.
  const stageRoll = r();
  const stage: Ifrs9StageNum = stageRoll < 0.8 ? 1 : stageRoll < 0.95 ? 2 : 3;

  // Per-stage parameter ranges.
  const pd_12m =
    stage === 1
      ? round(0.005 + r() * 0.045, 4) // 0.5%-5%
      : stage === 2
        ? round(0.06 + r() * 0.14, 4) // 6%-20%
        : round(0.25 + r() * 0.65, 4); // 25%-90%

  const pd_lifetime =
    stage === 1
      ? round(pd_12m + r() * 0.03, 4) // a touch above 12m
      : stage === 2
        ? round(0.15 + r() * 0.35, 4) // 15%-50%
        : round(Math.min(1, pd_12m + r() * 0.1), 4); // bounded by 1

  const lgd = round(0.25 + r() * 0.5, 3); // 25%-75% — typical secured-to-unsecured spread

  const ead_kes = Math.round(50_000 + r() * 4_950_000); // 50k-5M

  const driver = stage === 1 ? pd_12m : pd_lifetime;
  const ecl_kes = Math.round(driver * lgd * ead_kes);

  const dpd_days =
    stage === 1
      ? 0
      : stage === 2
        ? 30 + Math.floor(r() * 60) // 30-89
        : 90 + Math.floor(r() * 270); // 90-360

  const reasonPool = STAGE_REASONS[stage];
  const stage_reason = reasonPool[Math.floor(r() * reasonPool.length)]!;

  // Evaluation 0-7 days ago.
  const evaluation_date = daysBefore(asOf, Math.floor(r() * 8));

  return {
    customer_id,
    stage,
    pd_12m,
    pd_lifetime,
    lgd,
    ead_kes,
    ecl_kes,
    dpd_days,
    stage_reason,
    evaluation_date,
  };
}

export class StubIfrs9Adapter implements Ifrs9Adapter {
  async getStage(
    tenant_id: string,
    customer_id: string,
    asOf: Date,
  ): Promise<Ifrs9Stage | null> {
    if (!tenant_id || !customer_id) return null;
    return buildStage(tenant_id, customer_id, asOf);
  }

  async listStages(
    tenant_id: string,
    opts: { stage?: Ifrs9StageNum; page?: number; page_size?: number },
    asOf: Date,
  ): Promise<Ifrs9StageListPage> {
    const page = Math.max(1, opts.page ?? 1);
    const page_size = Math.max(1, Math.min(200, opts.page_size ?? 50));
    const stage_filter = opts.stage ?? null;

    // Synthesise the whole book deterministically — 200 customers per
    // tenant. The stub does this in-memory; production hits the IFRS 9
    // engine with a paginated query.
    const all: Ifrs9Stage[] = [];
    for (let i = 0; i < BOOK_SIZE; i++) {
      const customer_id = `c-${tenant_id.toLowerCase()}-${i.toString().padStart(4, '0')}`;
      all.push(buildStage(tenant_id, customer_id, asOf));
    }

    const filtered =
      stage_filter === null ? all : all.filter((s) => s.stage === stage_filter);

    // Sort: highest-ECL first — gives ops the worst exposures up top.
    filtered.sort((a, b) => b.ecl_kes - a.ecl_kes);

    const start = (page - 1) * page_size;
    const items = filtered.slice(start, start + page_size);

    return {
      items,
      page,
      page_size,
      total: filtered.length,
      stage_filter,
    };
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultIfrs9Adapter: Ifrs9Adapter = new StubIfrs9Adapter();
