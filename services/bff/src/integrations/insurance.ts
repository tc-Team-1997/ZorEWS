// services/bff/src/integrations/insurance.ts
//
// T6 M14.1 — Core Insurance / Policy Master adapter (first BIL adapter
// in Module 14 — External Integration Layer).
//
// The existing /v1/integrations/health pings the four banking upstreams
// (CBS, AML, IFRS9, Collection) but never fetches data from them. The
// BIL deployment needs the inverse — concrete data adapters for the
// Core Insurance + Policy Master + Claims systems so the SPA can render
// per-customer policy + claim history alongside the indicator panel.
//
// Adapter shape mirrors the rest of the codebase:
//   - InsuranceAdapter interface (the contract a real SOAP/REST gateway
//     would satisfy)
//   - StubInsuranceAdapter: deterministic synthetic data keyed by
//     (tenant_id, customer_id, day) so the SPA renders the same
//     timeline across page loads within a day
//
// Why not call the integration-mocks service here? The mocks service
// owns *banking* CBS endpoints. Insurance has no mock yet. A future
// follow-up can add SOAP-style insurance endpoints to integration-mocks
// and swap StubInsuranceAdapter for a HTTP-backed implementation
// without touching the routes.

// ─── Types ─────────────────────────────────────────────────────────────

export type PolicyProduct = 'TERM_LIFE' | 'ENDOWMENT' | 'ULIP' | 'GENERAL_HEALTH';

export type PolicyStatus = 'in_force' | 'lapsed' | 'cancelled' | 'matured' | 'pending_uw';

export interface Policy {
  policy_id: string;
  customer_id: string;
  product: PolicyProduct;
  /** Sum assured in KES (rounded). Differs from premium — this is the
   *  payout cap, not what the customer pays in. */
  sum_assured_kes: number;
  /** Annualised premium in KES. */
  annual_premium_kes: number;
  /** Status as of the as-of date. */
  status: PolicyStatus;
  /** Inception date (ISO). */
  inception_date: string;
  /** Maturity / next-renewal date (ISO). */
  maturity_date: string;
  /** Optional rider names (e.g. 'CRITICAL_ILLNESS', 'ACCIDENT'). Empty
   *  array when no riders. */
  riders: string[];
  /** Agent who sold the policy. */
  agent_id: string;
  /** Has the latest premium been paid? */
  premium_paid_current_period: boolean;
}

export type ClaimStatus =
  | 'submitted'
  | 'under_investigation'
  | 'approved'
  | 'paid'
  | 'rejected'
  | 'withdrawn';

export interface Claim {
  claim_id: string;
  policy_id: string;
  customer_id: string;
  /** ISO date claim was filed. */
  filed_at: string;
  /** Amount claimed in KES. */
  claim_amount_kes: number;
  /** Amount paid (0 unless status === 'paid'). */
  paid_amount_kes: number;
  status: ClaimStatus;
  reason_code: string;
  /** Free-text description for SPA. */
  description: string;
  /** ISO date of last status change. */
  last_updated_at: string;
}

export interface InsuranceAdapter {
  listPolicies(tenant_id: string, customer_id: string, asOf: Date): Promise<Policy[]>;
  getPolicy(tenant_id: string, policy_id: string, asOf: Date): Promise<Policy | null>;
  listClaims(tenant_id: string, customer_id: string, asOf: Date): Promise<Claim[]>;
  getClaim(tenant_id: string, claim_id: string, asOf: Date): Promise<Claim | null>;
}

// ─── Deterministic PRNG (FNV-1a + Mulberry32) ──────────────────────────
//
// Same scheme as bil_dashboards.ts. Local copy keeps the integrations
// module self-contained — when the next adapter ships these helpers
// can hoist into a shared util without churning either call site.

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

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}

function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBefore(d: Date, n: number): string {
  const t = new Date(d.getTime() - n * 86_400_000);
  return t.toISOString();
}

// ─── Stub adapter ──────────────────────────────────────────────────────

const PRODUCTS: PolicyProduct[] = ['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'GENERAL_HEALTH'];
const POLICY_STATUSES: PolicyStatus[] = [
  'in_force',
  'in_force',
  'in_force',
  'in_force',
  'lapsed',
  'pending_uw',
  'matured',
  'cancelled',
];
const RIDER_POOL = ['CRITICAL_ILLNESS', 'ACCIDENT', 'WAIVER_OF_PREMIUM', 'HOSPITAL_CASH', 'TERMINAL_ILLNESS'];
const CLAIM_STATUSES: ClaimStatus[] = [
  'submitted',
  'under_investigation',
  'approved',
  'paid',
  'paid',
  'rejected',
  'withdrawn',
];
const CLAIM_REASON_CODES = [
  'NATURAL_DEATH',
  'ACCIDENT',
  'CRITICAL_ILLNESS',
  'HOSPITALISATION',
  'MATURITY',
  'SURRENDER',
  'PARTIAL_DISABILITY',
];

/** How many policies + claims a given customer has, deterministically. */
function policyCountFor(seed: number): number {
  // 1-4 policies. Most customers have 1-2; a few have 3-4 (cross-sell).
  return 1 + (seed % 4);
}

function claimsPerPolicy(seed: number): number {
  // 0-3 claims per policy. Most policies have 0; some have 1-2; rare
  // customers go up to 3 (high-risk profile).
  const r = rng(seed)();
  if (r < 0.55) return 0;
  if (r < 0.85) return 1;
  if (r < 0.97) return 2;
  return 3;
}

function buildPolicy(
  tenant_id: string,
  customer_id: string,
  index: number,
  asOf: Date,
): Policy {
  const seed = seedFrom('policy', tenant_id, customer_id, index, dayOf(asOf));
  const r = rng(seed);
  const product = pick(r, PRODUCTS);
  const status = pick(r, POLICY_STATUSES);
  // Inception 30-3650 days ago.
  const inceptionAgeDays = 30 + Math.floor(r() * 3620);
  const inception_date = daysBefore(asOf, inceptionAgeDays);
  // Term 5-25 years.
  const termYears = 5 + Math.floor(r() * 20);
  const maturity_date = daysBefore(asOf, inceptionAgeDays - termYears * 365);

  const sum_assured_kes =
    product === 'TERM_LIFE'
      ? 5_000_000 + Math.floor(r() * 45_000_000) // 5M-50M
      : product === 'ENDOWMENT'
        ? 1_000_000 + Math.floor(r() * 9_000_000) // 1M-10M
        : product === 'ULIP'
          ? 2_000_000 + Math.floor(r() * 18_000_000) // 2M-20M
          : 500_000 + Math.floor(r() * 4_500_000); // GENERAL_HEALTH 500k-5M

  // Rough premium: 1-3% of sum assured per annum.
  const annual_premium_kes = Math.round((sum_assured_kes * (0.01 + r() * 0.02)) / 1000) * 1000;

  // 0-2 riders.
  const riderCount = Math.floor(r() * 3);
  const riders: string[] = [];
  for (let i = 0; i < riderCount; i++) {
    const cand = pick(r, RIDER_POOL);
    if (!riders.includes(cand)) riders.push(cand);
  }

  return {
    policy_id: `POL-${tenant_id.slice(0, 3).toUpperCase()}-${(seed % 1_000_000).toString().padStart(6, '0')}`,
    customer_id,
    product,
    sum_assured_kes,
    annual_premium_kes,
    status,
    inception_date,
    maturity_date,
    riders,
    agent_id: `AGT-${(seed % 200).toString().padStart(4, '0')}`,
    premium_paid_current_period: status === 'in_force' ? r() > 0.15 : false,
  };
}

function buildClaim(
  tenant_id: string,
  customer_id: string,
  policy_id: string,
  index: number,
  asOf: Date,
): Claim {
  const seed = seedFrom('claim', tenant_id, customer_id, policy_id, index, dayOf(asOf));
  const r = rng(seed);
  const status = pick(r, CLAIM_STATUSES);
  const reason_code = pick(r, CLAIM_REASON_CODES);
  // Filed 1-1825 days ago.
  const filedAgeDays = 1 + Math.floor(r() * 1824);
  const filed_at = daysBefore(asOf, filedAgeDays);
  const claim_amount_kes = 50_000 + Math.floor(r() * 4_950_000); // 50k-5M
  const paid_amount_kes =
    status === 'paid'
      ? Math.round(claim_amount_kes * (0.7 + r() * 0.3)) // 70-100% of claim
      : 0;
  // Last update 0 to filedAgeDays days ago.
  const lastUpdateAgeDays = Math.floor(r() * (filedAgeDays + 1));
  const last_updated_at = daysBefore(asOf, lastUpdateAgeDays);

  const description =
    `${reason_code.replace(/_/g, ' ').toLowerCase()} claim, ` +
    `${(claim_amount_kes / 1000).toFixed(0)}k KES — ${status.replace(/_/g, ' ')}`;

  return {
    claim_id: `CLM-${tenant_id.slice(0, 3).toUpperCase()}-${(seed % 1_000_000).toString().padStart(6, '0')}`,
    policy_id,
    customer_id,
    filed_at,
    claim_amount_kes,
    paid_amount_kes,
    status,
    reason_code,
    description,
    last_updated_at,
  };
}

export class StubInsuranceAdapter implements InsuranceAdapter {
  async listPolicies(tenant_id: string, customer_id: string, asOf: Date): Promise<Policy[]> {
    if (!tenant_id || !customer_id) return [];
    const seed = seedFrom('count', tenant_id, customer_id);
    const n = policyCountFor(seed);
    const policies: Policy[] = [];
    for (let i = 0; i < n; i++) {
      policies.push(buildPolicy(tenant_id, customer_id, i, asOf));
    }
    // Newest-inception-first.
    return policies.sort((a, b) => b.inception_date.localeCompare(a.inception_date));
  }

  async getPolicy(tenant_id: string, policy_id: string, asOf: Date): Promise<Policy | null> {
    if (!tenant_id || !policy_id) return null;
    // Stub model: a policy_id of POL-<TEN>-<6 digits> identifies the
    // customer who owns it via a deterministic decode. Production: hit
    // the Policy Master by id directly. For the stub we synthesise from
    // the id without needing the customer key — so we synthesise a
    // self-consistent shape from the id alone.
    if (!/^POL-[A-Z]{3}-\d{6}$/.test(policy_id)) return null;
    const customer_id = `c-${policy_id.slice(-6)}`;
    const seed = seedFrom('lookup', tenant_id, policy_id, dayOf(asOf));
    const r = rng(seed);
    const product = pick(r, PRODUCTS);
    const status = pick(r, POLICY_STATUSES);
    const inceptionAgeDays = 30 + Math.floor(r() * 3620);
    const sum_assured_kes = 1_000_000 + Math.floor(r() * 49_000_000);
    return {
      policy_id,
      customer_id,
      product,
      sum_assured_kes,
      annual_premium_kes: Math.round((sum_assured_kes * (0.01 + r() * 0.02)) / 1000) * 1000,
      status,
      inception_date: daysBefore(asOf, inceptionAgeDays),
      maturity_date: daysBefore(asOf, inceptionAgeDays - 365 * (5 + Math.floor(r() * 20))),
      riders: r() > 0.4 ? [pick(r, RIDER_POOL)] : [],
      agent_id: `AGT-${(seed % 200).toString().padStart(4, '0')}`,
      premium_paid_current_period: status === 'in_force' ? r() > 0.15 : false,
    };
  }

  async listClaims(tenant_id: string, customer_id: string, asOf: Date): Promise<Claim[]> {
    const policies = await this.listPolicies(tenant_id, customer_id, asOf);
    const claims: Claim[] = [];
    for (const p of policies) {
      const seed = seedFrom('claim_count', tenant_id, customer_id, p.policy_id);
      const n = claimsPerPolicy(seed);
      for (let i = 0; i < n; i++) {
        claims.push(buildClaim(tenant_id, customer_id, p.policy_id, i, asOf));
      }
    }
    return claims.sort((a, b) => b.filed_at.localeCompare(a.filed_at));
  }

  async getClaim(tenant_id: string, claim_id: string, asOf: Date): Promise<Claim | null> {
    if (!tenant_id || !claim_id) return null;
    if (!/^CLM-[A-Z]{3}-\d{6}$/.test(claim_id)) return null;
    const customer_id = `c-${claim_id.slice(-6)}`;
    const policy_id = `POL-${claim_id.slice(4, 7)}-${claim_id.slice(-6)}`;
    // buildClaim synthesises its own id from a fresh seed; we fix it to
    // the requested id after the fact so callers see what they asked for.
    const synth = buildClaim(tenant_id, customer_id, policy_id, 0, asOf);
    return { ...synth, claim_id };
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultInsuranceAdapter: InsuranceAdapter = new StubInsuranceAdapter();
