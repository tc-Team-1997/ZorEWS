// Enterprise Demo Foundation — Insurance Engine (additive overlay slice)
// Pure, read-mostly, deterministic synthesis (FNV-1a + Mulberry32).
// No I/O, no external deps. Indian flavour: INR, PAN ids, Indian names + cities.

/** Local clock helper — wraps Date constructor for deterministic test override. */
function currentTime(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export const POLICY_TYPES = [
  'health',
  'motor',
  'life',
  'travel',
  'commercial',
] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

export const POLICY_STATUSES = [
  'active',
  'high_risk',
  'lapse_risk',
  'lapsed',
] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export const CLAIM_STATUSES = [
  'submitted',
  'investigating',
  'approved',
  'rejected',
  'paid',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export type FraudType =
  | 'staged_accident'
  | 'inflated_billing'
  | 'identity_fraud'
  | 'fake_documents'
  | 'collusion';

export type FraudStatus = 'open' | 'investigating' | 'confirmed' | 'cleared';

export type CustomerSegment = 'retail' | 'sme' | 'corporate';

// ---------------------------------------------------------------------------
// Reference catalogs
// ---------------------------------------------------------------------------

export interface InsurerCatalogEntry {
  insurer_id: string;
  name: string;
  code: string;
  hq_city: string;
}

export const INSURER_CATALOG: readonly InsurerCatalogEntry[] = [
  { insurer_id: 'INS-ICICIL', name: 'ICICI Lombard', code: 'ICICIL', hq_city: 'Mumbai' },
  { insurer_id: 'INS-HDFCE', name: 'HDFC Ergo', code: 'HDFCE', hq_city: 'Mumbai' },
  { insurer_id: 'INS-SBIG', name: 'SBI General', code: 'SBIG', hq_city: 'Mumbai' },
] as const;

const STATE_CITY_PAIRS: ReadonlyArray<[string, string]> = [
  ['Maharashtra', 'Mumbai'],
  ['Maharashtra', 'Pune'],
  ['Karnataka', 'Bengaluru'],
  ['Tamil Nadu', 'Chennai'],
  ['Telangana', 'Hyderabad'],
  ['Delhi', 'New Delhi'],
  ['West Bengal', 'Kolkata'],
  ['Gujarat', 'Ahmedabad'],
  ['Rajasthan', 'Jaipur'],
  ['Punjab', 'Chandigarh'],
];

const FIRST_NAMES: readonly string[] = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Mohammed', 'Ayaan',
  'Krishna', 'Ishaan', 'Saanvi', 'Aanya', 'Aaradhya', 'Pari', 'Diya',
];

const LAST_NAMES: readonly string[] = [
  'Sharma', 'Patel', 'Kumar', 'Singh', 'Gupta', 'Mehta', 'Shah', 'Khan',
  'Reddy', 'Iyer', 'Verma', 'Rao', 'Joshi', 'Nair', 'Menon',
];

const FRAUD_TYPES: readonly FraudType[] = [
  'staged_accident',
  'inflated_billing',
  'identity_fraud',
  'fake_documents',
  'collusion',
];

const REASON_CODES: readonly string[] = [
  'accident',
  'medical_expenses',
  'theft',
  'natural_disaster',
  'fire',
  'death_benefit',
  'critical_illness',
  'third_party_liability',
];

const BRANCH_CITIES: readonly string[] = [
  'Mumbai', 'Pune', 'Bengaluru', 'Chennai', 'Hyderabad',
  'New Delhi', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Chandigarh',
];

// ---------------------------------------------------------------------------
// Virtual book sizes
// ---------------------------------------------------------------------------

const CUSTOMER_BOOK_SIZE = 20000;
const POLICY_BOOK_SIZE = 5000;
const CLAIM_BOOK_SIZE = 3000;
const FRAUD_BOOK_SIZE = 500;
const AGENT_BOOK_SIZE = 200;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface InsuranceCustomer {
  customer_id: string;
  insurer_id: string;
  pan: string;
  full_name: string;
  dob: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  segment: CustomerSegment;
}

export interface Policy {
  policy_id: string;
  customer_id: string;
  insurer_id: string;
  policy_type: PolicyType;
  status: PolicyStatus;
  sum_assured_inr: number;
  annual_premium_inr: number;
  tenure_years: number;
  issued_at: string;
  expires_at: string;
  agent_id: string;
  underwriting_score: number;
  persistency_pct: number;
  missed_premiums_count: number;
}

export interface Claim {
  claim_id: string;
  policy_id: string;
  customer_id: string;
  insurer_id: string;
  status: ClaimStatus;
  claim_amount_inr: number;
  approved_amount_inr: number;
  filed_at: string;
  closed_at_or_null: string | null;
  reason_code: string;
  investigator_username_or_null: string | null;
  fraud_score: number;
  is_fraud_flagged: boolean;
}

export interface FraudCase {
  fraud_id: string;
  claim_id: string;
  policy_id: string;
  customer_id: string;
  insurer_id: string;
  fraud_type: FraudType;
  evidence_score: number;
  investigator_username: string;
  reported_at: string;
  status: FraudStatus;
  estimated_loss_inr: number;
}

export interface Agent {
  agent_id: string;
  insurer_id: string;
  full_name: string;
  branch_city: string;
  joined_at: string;
  policies_sold: number;
  persistency_pct: number;
  complaints_count: number;
  performance_score: number;
}

// ---------------------------------------------------------------------------
// Deterministic RNG — FNV-1a + Mulberry32
// ---------------------------------------------------------------------------

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function asOfKey(asOf: Date): string {
  return asOf.toISOString().slice(0, 10);
}

function seedRng(...parts: string[]): () => number {
  return mulberry32(fnv1a(parts.join('|')));
}

function pickFrom<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function floatBetween(rng: () => number, lo: number, hi: number, decimals = 2): number {
  const v = lo + rng() * (hi - lo);
  const k = Math.pow(10, decimals);
  return Math.round(v * k) / k;
}

function daysAgo(asOf: Date, days: number): string {
  const d = new Date(asOf.getTime() - days * 86400000);
  return d.toISOString();
}

function daysFromNow(asOf: Date, days: number): string {
  const d = new Date(asOf.getTime() + days * 86400000);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// ID helpers (PAN-like + zero-padded)
// ---------------------------------------------------------------------------

function pad(n: number, width: number): string {
  const s = String(n);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function synthPan(rng: () => number): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let prefix = '';
  for (let i = 0; i < 5; i += 1) prefix += letters[Math.floor(rng() * letters.length)];
  const digits = pad(intBetween(rng, 1000, 9999), 4);
  const suffix = letters[Math.floor(rng() * letters.length)];
  return `${prefix}${digits}${suffix}`;
}

function synthPhone(rng: () => number): string {
  const first = intBetween(rng, 6, 9);
  let rest = '';
  for (let i = 0; i < 9; i += 1) rest += String(intBetween(rng, 0, 9));
  return `+91${first}${rest}`;
}

function slugifyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '.');
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function generateCustomerAt(
  tenant_id: string,
  asOf: Date,
  index: number,
): InsuranceCustomer {
  const rng = seedRng(tenant_id, asOfKey(asOf), 'ins-cust', String(index));
  const customer_id = `INSC-${pad(index, 7)}`;
  const insurer = pickFrom(rng, INSURER_CATALOG);
  const first = pickFrom(rng, FIRST_NAMES);
  const last = pickFrom(rng, LAST_NAMES);
  const full_name = `${first} ${last}`;
  const [state, city] = pickFrom(rng, STATE_CITY_PAIRS);
  const segmentRoll = rng();
  const segment: CustomerSegment =
    segmentRoll < 0.75 ? 'retail' : segmentRoll < 0.95 ? 'sme' : 'corporate';
  const dobYear = intBetween(rng, 1955, 2002);
  const dobMonth = pad(intBetween(rng, 1, 12), 2);
  const dobDay = pad(intBetween(rng, 1, 28), 2);
  return {
    customer_id,
    insurer_id: insurer.insurer_id,
    pan: synthPan(rng),
    full_name,
    dob: `${dobYear}-${dobMonth}-${dobDay}`,
    city,
    state,
    phone: synthPhone(rng),
    email: `${slugifyName(first)}.${slugifyName(last)}${index}@example.in`,
    segment,
  };
}

function generatePolicyAt(
  tenant_id: string,
  asOf: Date,
  index: number,
): Policy {
  const rng = seedRng(tenant_id, asOfKey(asOf), 'ins-policy', String(index));
  const policy_id = `POL-${pad(index, 7)}`;
  const customerIdx = 1 + Math.floor(rng() * CUSTOMER_BOOK_SIZE);
  const customer_id = `INSC-${pad(customerIdx, 7)}`;
  const insurer = pickFrom(rng, INSURER_CATALOG);
  const policy_type = pickFrom(rng, POLICY_TYPES);
  const statusRoll = rng();
  const status: PolicyStatus =
    statusRoll < 0.70
      ? 'active'
      : statusRoll < 0.82
        ? 'high_risk'
        : statusRoll < 0.92
          ? 'lapse_risk'
          : 'lapsed';
  const tenure_years = intBetween(rng, 1, 20);
  const sum_assured_inr = intBetween(rng, 100000, 50000000);
  const annual_premium_inr = Math.round(sum_assured_inr * floatBetween(rng, 0.005, 0.04, 4));
  const issuedDaysAgo = intBetween(rng, 30, tenure_years * 365);
  const expiresInDays = tenure_years * 365 - issuedDaysAgo;
  const agentIdx = 1 + Math.floor(rng() * AGENT_BOOK_SIZE);
  const agent_id = `AGT-${pad(agentIdx, 5)}`;
  const underwriting_score = intBetween(rng, 40, 100);
  const persistency_pct = floatBetween(rng, 35, 99, 1);
  const missed_premiums_count =
    status === 'lapsed' ? intBetween(rng, 2, 6) : status === 'active' ? intBetween(rng, 0, 1) : intBetween(rng, 0, 3);
  return {
    policy_id,
    customer_id,
    insurer_id: insurer.insurer_id,
    policy_type,
    status,
    sum_assured_inr,
    annual_premium_inr,
    tenure_years,
    issued_at: daysAgo(asOf, issuedDaysAgo),
    expires_at: daysFromNow(asOf, Math.max(0, expiresInDays)),
    agent_id,
    underwriting_score,
    persistency_pct,
    missed_premiums_count,
  };
}

function generateClaimAt(
  tenant_id: string,
  asOf: Date,
  index: number,
): Claim {
  const rng = seedRng(tenant_id, asOfKey(asOf), 'ins-claim', String(index));
  const claim_id = `CLM-${pad(index, 7)}`;
  const policyIdx = 1 + Math.floor(rng() * POLICY_BOOK_SIZE);
  const policy_id = `POL-${pad(policyIdx, 7)}`;
  const customerIdx = 1 + Math.floor(rng() * CUSTOMER_BOOK_SIZE);
  const customer_id = `INSC-${pad(customerIdx, 7)}`;
  const insurer = pickFrom(rng, INSURER_CATALOG);
  const status = pickFrom(rng, CLAIM_STATUSES);
  const claim_amount_inr = intBetween(rng, 5000, 2500000);
  const isPaid = status === 'paid';
  const isApproved = status === 'approved' || isPaid;
  const approved_amount_inr = isApproved
    ? Math.round(claim_amount_inr * floatBetween(rng, 0.6, 1.0, 2))
    : 0;
  const filedDaysAgo = intBetween(rng, 1, 365);
  const closedDaysAgo =
    status === 'paid' || status === 'rejected'
      ? Math.max(0, filedDaysAgo - intBetween(rng, 1, 30))
      : -1;
  const fraud_score = intBetween(rng, 0, 100);
  const is_fraud_flagged = fraud_score >= 70;
  return {
    claim_id,
    policy_id,
    customer_id,
    insurer_id: insurer.insurer_id,
    status,
    claim_amount_inr,
    approved_amount_inr,
    filed_at: daysAgo(asOf, filedDaysAgo),
    closed_at_or_null: closedDaysAgo >= 0 ? daysAgo(asOf, closedDaysAgo) : null,
    reason_code: pickFrom(rng, REASON_CODES),
    investigator_username_or_null:
      status === 'investigating' || is_fraud_flagged
        ? `inv.${pickFrom(rng, FIRST_NAMES).toLowerCase()}${intBetween(rng, 10, 99)}`
        : null,
    fraud_score,
    is_fraud_flagged,
  };
}

function generateFraudCaseAt(
  tenant_id: string,
  asOf: Date,
  index: number,
): FraudCase {
  const rng = seedRng(tenant_id, asOfKey(asOf), 'ins-fraud', String(index));
  const fraud_id = `FRD-${pad(index, 6)}`;
  const claimIdx = 1 + Math.floor(rng() * CLAIM_BOOK_SIZE);
  const claim_id = `CLM-${pad(claimIdx, 7)}`;
  const policyIdx = 1 + Math.floor(rng() * POLICY_BOOK_SIZE);
  const policy_id = `POL-${pad(policyIdx, 7)}`;
  const customerIdx = 1 + Math.floor(rng() * CUSTOMER_BOOK_SIZE);
  const customer_id = `INSC-${pad(customerIdx, 7)}`;
  const insurer = pickFrom(rng, INSURER_CATALOG);
  const fraud_type = pickFrom(rng, FRAUD_TYPES);
  const evidence_score = intBetween(rng, 40, 100);
  const statusRoll = rng();
  const status: FraudStatus =
    statusRoll < 0.35
      ? 'investigating'
      : statusRoll < 0.6
        ? 'open'
        : statusRoll < 0.85
          ? 'confirmed'
          : 'cleared';
  const investigator_username = `inv.${pickFrom(rng, FIRST_NAMES).toLowerCase()}${intBetween(rng, 10, 99)}`;
  const estimated_loss_inr = intBetween(rng, 25000, 5000000);
  return {
    fraud_id,
    claim_id,
    policy_id,
    customer_id,
    insurer_id: insurer.insurer_id,
    fraud_type,
    evidence_score,
    investigator_username,
    reported_at: daysAgo(asOf, intBetween(rng, 1, 180)),
    status,
    estimated_loss_inr,
  };
}

function generateAgentAt(
  tenant_id: string,
  asOf: Date,
  index: number,
): Agent {
  const rng = seedRng(tenant_id, asOfKey(asOf), 'ins-agent', String(index));
  const agent_id = `AGT-${pad(index, 5)}`;
  const insurer = pickFrom(rng, INSURER_CATALOG);
  const first = pickFrom(rng, FIRST_NAMES);
  const last = pickFrom(rng, LAST_NAMES);
  const branch_city = pickFrom(rng, BRANCH_CITIES);
  const joinedDaysAgo = intBetween(rng, 60, 365 * 10);
  const policies_sold = intBetween(rng, 10, 800);
  const persistency_pct = floatBetween(rng, 40, 98, 1);
  const complaints_count = intBetween(rng, 0, 12);
  const performance_score = Math.max(
    0,
    Math.min(100, Math.round(persistency_pct * 0.7 + (100 - complaints_count * 4) * 0.3)),
  );
  return {
    agent_id,
    insurer_id: insurer.insurer_id,
    full_name: `${first} ${last}`,
    branch_city,
    joined_at: daysAgo(asOf, joinedDaysAgo),
    policies_sold,
    persistency_pct,
    complaints_count,
    performance_score,
  };
}

// ---------------------------------------------------------------------------
// Index parsing helpers (id → index)
// ---------------------------------------------------------------------------

function parseIndexFromId(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) return null;
  const tail = id.slice(prefix.length);
  if (!/^\d+$/.test(tail)) return null;
  const n = Number(tail);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clampLimit(limit: number, max = 1000): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), max);
}

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.floor(offset);
}

// ---------------------------------------------------------------------------
// Public list/get APIs
// ---------------------------------------------------------------------------

/** List insurance customers from the virtual 20k book (paginated). */
export function listInsuranceCustomers(
  tenant_id: string,
  asOf: Date = currentTime(),
  offset = 0,
  limit = 100,
): InsuranceCustomer[] {
  const start = clampOffset(offset);
  const take = clampLimit(limit);
  const end = Math.min(CUSTOMER_BOOK_SIZE, start + take);
  const out: InsuranceCustomer[] = [];
  for (let i = start + 1; i <= end; i += 1) {
    out.push(generateCustomerAt(tenant_id, asOf, i));
  }
  return out;
}

/** Get a single insurance customer by id (or null when out of range). */
export function getInsuranceCustomer(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): InsuranceCustomer | null {
  const idx = parseIndexFromId(id, 'INSC-');
  if (idx === null || idx < 1 || idx > CUSTOMER_BOOK_SIZE) return null;
  return generateCustomerAt(tenant_id, asOf, idx);
}

/** List policies with optional status/type/insurer filter (paginated, post-filter). */
export function listPolicies(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: { status?: PolicyStatus; policy_type?: PolicyType; insurer_id?: string },
  offset = 0,
  limit = 100,
): Policy[] {
  const start = clampOffset(offset);
  const take = clampLimit(limit);
  const out: Policy[] = [];
  let skipped = 0;
  for (let i = 1; i <= POLICY_BOOK_SIZE && out.length < take; i += 1) {
    const row = generatePolicyAt(tenant_id, asOf, i);
    if (filter?.status && row.status !== filter.status) continue;
    if (filter?.policy_type && row.policy_type !== filter.policy_type) continue;
    if (filter?.insurer_id && row.insurer_id !== filter.insurer_id) continue;
    if (skipped < start) {
      skipped += 1;
      continue;
    }
    out.push(row);
  }
  return out;
}

/** Get a single policy by id. */
export function getPolicy(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): Policy | null {
  const idx = parseIndexFromId(id, 'POL-');
  if (idx === null || idx < 1 || idx > POLICY_BOOK_SIZE) return null;
  return generatePolicyAt(tenant_id, asOf, idx);
}

/** List claims with optional status/insurer/fraud filter (paginated, post-filter). */
export function listClaims(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: { status?: ClaimStatus; insurer_id?: string; is_fraud_flagged?: boolean },
  offset = 0,
  limit = 100,
): Claim[] {
  const start = clampOffset(offset);
  const take = clampLimit(limit);
  const out: Claim[] = [];
  let skipped = 0;
  for (let i = 1; i <= CLAIM_BOOK_SIZE && out.length < take; i += 1) {
    const row = generateClaimAt(tenant_id, asOf, i);
    if (filter?.status && row.status !== filter.status) continue;
    if (filter?.insurer_id && row.insurer_id !== filter.insurer_id) continue;
    if (filter?.is_fraud_flagged !== undefined && row.is_fraud_flagged !== filter.is_fraud_flagged) continue;
    if (skipped < start) {
      skipped += 1;
      continue;
    }
    out.push(row);
  }
  return out;
}

/** Get a single claim by id. */
export function getClaim(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): Claim | null {
  const idx = parseIndexFromId(id, 'CLM-');
  if (idx === null || idx < 1 || idx > CLAIM_BOOK_SIZE) return null;
  return generateClaimAt(tenant_id, asOf, idx);
}

/** List fraud cases (paginated). */
export function listFraudCases(
  tenant_id: string,
  asOf: Date = currentTime(),
  offset = 0,
  limit = 100,
): FraudCase[] {
  const start = clampOffset(offset);
  const take = clampLimit(limit);
  const end = Math.min(FRAUD_BOOK_SIZE, start + take);
  const out: FraudCase[] = [];
  for (let i = start + 1; i <= end; i += 1) {
    out.push(generateFraudCaseAt(tenant_id, asOf, i));
  }
  return out;
}

/** Get a single fraud case by id. */
export function getFraudCase(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): FraudCase | null {
  const idx = parseIndexFromId(id, 'FRD-');
  if (idx === null || idx < 1 || idx > FRAUD_BOOK_SIZE) return null;
  return generateFraudCaseAt(tenant_id, asOf, idx);
}

/** List agents (capped at full book size of 200). */
export function listAgents(
  tenant_id: string,
  asOf: Date = currentTime(),
  limit = 200,
): Agent[] {
  const take = Math.min(clampLimit(limit, AGENT_BOOK_SIZE), AGENT_BOOK_SIZE);
  const out: Agent[] = [];
  for (let i = 1; i <= take; i += 1) {
    out.push(generateAgentAt(tenant_id, asOf, i));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export interface TopFraudType {
  fraud_type: FraudType;
  count: number;
  estimated_loss_inr: number;
}

export interface InsurancePortfolioSummary {
  total_customers: number;
  total_policies: number;
  total_claims: number;
  total_fraud_cases: number;
  by_policy_type: Record<PolicyType, number>;
  by_policy_status: Record<PolicyStatus, number>;
  by_claim_status: Record<ClaimStatus, number>;
  active_policies: number;
  high_risk_count: number;
  lapse_risk_count: number;
  lapsed_count: number;
  fraud_claim_count: number;
  total_premium_inr: number;
  total_claims_paid_inr: number;
  claim_ratio: number;
  persistency_avg_pct: number;
  top_fraud_types: TopFraudType[];
}

function emptyPolicyTypeMap(): Record<PolicyType, number> {
  const m = {} as Record<PolicyType, number>;
  for (const t of POLICY_TYPES) m[t] = 0;
  return m;
}

function emptyPolicyStatusMap(): Record<PolicyStatus, number> {
  const m = {} as Record<PolicyStatus, number>;
  for (const s of POLICY_STATUSES) m[s] = 0;
  return m;
}

function emptyClaimStatusMap(): Record<ClaimStatus, number> {
  const m = {} as Record<ClaimStatus, number>;
  for (const s of CLAIM_STATUSES) m[s] = 0;
  return m;
}

/** Aggregate insurance portfolio snapshot across the full virtual book. */
export function summarizeInsurancePortfolio(
  tenant_id: string,
  asOf: Date = currentTime(),
): InsurancePortfolioSummary {
  const by_policy_type = emptyPolicyTypeMap();
  const by_policy_status = emptyPolicyStatusMap();
  const by_claim_status = emptyClaimStatusMap();

  let active_policies = 0;
  let high_risk_count = 0;
  let lapse_risk_count = 0;
  let lapsed_count = 0;
  let total_premium_inr = 0;
  let persistency_sum = 0;

  for (let i = 1; i <= POLICY_BOOK_SIZE; i += 1) {
    const p = generatePolicyAt(tenant_id, asOf, i);
    by_policy_type[p.policy_type] += 1;
    by_policy_status[p.status] += 1;
    total_premium_inr += p.annual_premium_inr;
    persistency_sum += p.persistency_pct;
    if (p.status === 'active') active_policies += 1;
    if (p.status === 'lapsed') lapsed_count += 1;
    if (p.underwriting_score < 55) high_risk_count += 1;
    if (p.status === 'active' && (p.missed_premiums_count >= 1 || p.persistency_pct < 60)) {
      lapse_risk_count += 1;
    }
  }

  let total_claims_paid_inr = 0;
  let fraud_claim_count = 0;
  for (let i = 1; i <= CLAIM_BOOK_SIZE; i += 1) {
    const c = generateClaimAt(tenant_id, asOf, i);
    by_claim_status[c.status] += 1;
    if (c.status === 'paid') total_claims_paid_inr += c.approved_amount_inr;
    if (c.is_fraud_flagged) fraud_claim_count += 1;
  }

  const fraudAgg = new Map<FraudType, { count: number; estimated_loss_inr: number }>();
  for (const t of FRAUD_TYPES) fraudAgg.set(t, { count: 0, estimated_loss_inr: 0 });
  for (let i = 1; i <= FRAUD_BOOK_SIZE; i += 1) {
    const f = generateFraudCaseAt(tenant_id, asOf, i);
    const slot = fraudAgg.get(f.fraud_type);
    if (slot) {
      slot.count += 1;
      slot.estimated_loss_inr += f.estimated_loss_inr;
    }
  }
  const top_fraud_types: TopFraudType[] = Array.from(fraudAgg.entries())
    .map(([fraud_type, v]) => ({
      fraud_type,
      count: v.count,
      estimated_loss_inr: v.estimated_loss_inr,
    }))
    .sort((a, b) => b.count - a.count || b.estimated_loss_inr - a.estimated_loss_inr);

  const claim_ratio =
    total_premium_inr > 0
      ? Math.round((total_claims_paid_inr / total_premium_inr) * 10000) / 10000
      : 0;
  const persistency_avg_pct =
    POLICY_BOOK_SIZE > 0
      ? Math.round((persistency_sum / POLICY_BOOK_SIZE) * 100) / 100
      : 0;

  return {
    total_customers: CUSTOMER_BOOK_SIZE,
    total_policies: POLICY_BOOK_SIZE,
    total_claims: CLAIM_BOOK_SIZE,
    total_fraud_cases: FRAUD_BOOK_SIZE,
    by_policy_type,
    by_policy_status,
    by_claim_status,
    active_policies,
    high_risk_count,
    lapse_risk_count,
    lapsed_count,
    fraud_claim_count,
    total_premium_inr,
    total_claims_paid_inr,
    claim_ratio,
    persistency_avg_pct,
    top_fraud_types,
  };
}

export interface InsurerSummaryRow {
  insurer_id: string;
  insurer_name: string;
  policies: number;
  claims: number;
  total_premium_inr: number;
  claim_ratio: number;
  fraud_count: number;
}

/** Per-insurer rollup across the full virtual book. */
export function summarizeInsurerWise(
  tenant_id: string,
  asOf: Date = currentTime(),
): InsurerSummaryRow[] {
  const agg = new Map<
    string,
    {
      insurer_name: string;
      policies: number;
      claims: number;
      total_premium_inr: number;
      total_claims_paid_inr: number;
      fraud_count: number;
    }
  >();
  for (const entry of INSURER_CATALOG) {
    agg.set(entry.insurer_id, {
      insurer_name: entry.name,
      policies: 0,
      claims: 0,
      total_premium_inr: 0,
      total_claims_paid_inr: 0,
      fraud_count: 0,
    });
  }

  for (let i = 1; i <= POLICY_BOOK_SIZE; i += 1) {
    const p = generatePolicyAt(tenant_id, asOf, i);
    const slot = agg.get(p.insurer_id);
    if (!slot) continue;
    slot.policies += 1;
    slot.total_premium_inr += p.annual_premium_inr;
  }

  for (let i = 1; i <= CLAIM_BOOK_SIZE; i += 1) {
    const c = generateClaimAt(tenant_id, asOf, i);
    const slot = agg.get(c.insurer_id);
    if (!slot) continue;
    slot.claims += 1;
    if (c.status === 'paid') slot.total_claims_paid_inr += c.approved_amount_inr;
    if (c.is_fraud_flagged) slot.fraud_count += 1;
  }

  const out: InsurerSummaryRow[] = [];
  for (const [insurer_id, v] of agg.entries()) {
    const claim_ratio =
      v.total_premium_inr > 0
        ? Math.round((v.total_claims_paid_inr / v.total_premium_inr) * 10000) / 10000
        : 0;
    out.push({
      insurer_id,
      insurer_name: v.insurer_name,
      policies: v.policies,
      claims: v.claims,
      total_premium_inr: v.total_premium_inr,
      claim_ratio,
      fraud_count: v.fraud_count,
    });
  }
  return out;
}
