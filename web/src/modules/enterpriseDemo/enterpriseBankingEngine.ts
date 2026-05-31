/**
 * Enterprise Demo Foundation — Banking Engine
 *
 * Read-only, pure, deterministic synthesis layer for an Indian retail + SME +
 * corporate banking book. Powers the 15th IA overlay on top of ZorEWS without
 * touching any persistence layer.
 */

// ---------------------------------------------------------------------------
// Local time helper (per spec rule 5 — no inline no-arg Date)
// ---------------------------------------------------------------------------

/** Return the current Date — wrapper that owns the single no-arg Date call. */
function currentTime(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// Closed enum string-literal unions + tuple constants
// ---------------------------------------------------------------------------

export const LOAN_TYPES = ['home', 'personal', 'vehicle', 'education', 'business'] as const;
export type LoanType = (typeof LOAN_TYPES)[number];

export const LOAN_STATUSES = ['active', 'watchlist', 'sma0', 'sma1', 'sma2', 'npa'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const DPD_BUCKETS = ['current', '1_30', '31_60', '61_90', '90_plus'] as const;
export type DpdBucket = (typeof DPD_BUCKETS)[number];

export const SECTORS = [
  'agriculture',
  'manufacturing',
  'services',
  'retail_trade',
  'real_estate',
  'infrastructure',
  'msme',
  'it_ites',
] as const;
export type SectorClassification = (typeof SECTORS)[number];

export const REGIONS = ['North', 'South', 'East', 'West', 'Central'] as const;
export type Region = (typeof REGIONS)[number];

// ---------------------------------------------------------------------------
// Reference catalogs
// ---------------------------------------------------------------------------

export interface BankCatalogEntry {
  bank_id: string;
  name: string;
  code: string;
  hq_city: string;
}

export const BANK_CATALOG: readonly BankCatalogEntry[] = [
  { bank_id: 'BANK_HDFC', name: 'HDFC Bank', code: 'HDFC', hq_city: 'Mumbai' },
  { bank_id: 'BANK_ICICI', name: 'ICICI Bank', code: 'ICIC', hq_city: 'Mumbai' },
  { bank_id: 'BANK_SBI', name: 'SBI', code: 'SBIN', hq_city: 'Mumbai' },
  { bank_id: 'BANK_AXIS', name: 'Axis Bank', code: 'UTIB', hq_city: 'Mumbai' },
  { bank_id: 'BANK_KOTAK', name: 'Kotak Mahindra', code: 'KKBK', hq_city: 'Mumbai' },
] as const;

const STATE_CITY_PAIRS: ReadonlyArray<{ state: string; city: string; region: Region }> = [
  { state: 'Maharashtra', city: 'Mumbai', region: 'West' },
  { state: 'Maharashtra', city: 'Pune', region: 'West' },
  { state: 'Karnataka', city: 'Bengaluru', region: 'South' },
  { state: 'Tamil Nadu', city: 'Chennai', region: 'South' },
  { state: 'Telangana', city: 'Hyderabad', region: 'South' },
  { state: 'Delhi', city: 'New Delhi', region: 'North' },
  { state: 'West Bengal', city: 'Kolkata', region: 'East' },
  { state: 'Gujarat', city: 'Ahmedabad', region: 'West' },
  { state: 'Rajasthan', city: 'Jaipur', region: 'North' },
  { state: 'Punjab', city: 'Chandigarh', region: 'North' },
  { state: 'Madhya Pradesh', city: 'Bhopal', region: 'Central' },
  { state: 'Uttar Pradesh', city: 'Lucknow', region: 'North' },
  { state: 'Kerala', city: 'Kochi', region: 'South' },
  { state: 'Odisha', city: 'Bhubaneswar', region: 'East' },
];

const FIRST_NAMES: readonly string[] = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Mohammed', 'Ayaan',
  'Krishna', 'Ishaan', 'Saanvi', 'Aanya', 'Aaradhya', 'Pari', 'Diya', 'Ananya',
  'Riya', 'Kavya', 'Anika', 'Myra',
];

const LAST_NAMES: readonly string[] = [
  'Sharma', 'Patel', 'Kumar', 'Singh', 'Gupta', 'Mehta', 'Shah', 'Khan',
  'Reddy', 'Iyer', 'Verma', 'Rao', 'Joshi', 'Nair', 'Menon', 'Agarwal',
  'Bhat', 'Pillai', 'Chatterjee', 'Banerjee',
];

const PAN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface Branch {
  branch_id: string;
  bank_id: string;
  name: string;
  region: Region;
  state: string;
  city: string;
  ifsc_prefix: string;
  opened_at: string;
}

export interface Customer {
  customer_id: string;
  bank_id: string;
  pan: string;
  full_name: string;
  gender: 'male' | 'female';
  dob: string;
  city: string;
  state: string;
  phone: string;
  email: string;
  segment: 'retail' | 'sme' | 'corporate';
}

export interface Account {
  account_id: string;
  customer_id: string;
  bank_id: string;
  branch_id: string;
  account_type: 'savings' | 'current' | 'overdraft';
  balance_inr: number;
  opened_at: string;
  status: 'active' | 'dormant' | 'frozen';
}

export interface Loan {
  loan_id: string;
  customer_id: string;
  bank_id: string;
  branch_id: string;
  loan_type: LoanType;
  sector: SectorClassification;
  principal_inr: number;
  outstanding_inr: number;
  emi_inr: number;
  dpd_days: number;
  dpd_bucket: DpdBucket;
  status: LoanStatus;
  sanctioned_at: string;
  tenure_months: number;
  credit_utilization_pct: number;
  sector_exposure_inr: number;
  missed_emi_count: number;
}

// ---------------------------------------------------------------------------
// Virtual book sizes
// ---------------------------------------------------------------------------

const TOTAL_BRANCHES = 50;
const TOTAL_CUSTOMERS = 10000;
const TOTAL_ACCOUNTS = 50000;
const TOTAL_LOANS = 20000;

// ---------------------------------------------------------------------------
// Currency helpers
// ---------------------------------------------------------------------------

/** Convert lakhs to rupees (1 lakh = 100,000). */
function lakhs(n: number): number {
  return Math.round(n * 100_000);
}

/** Convert crores to rupees (1 crore = 10,000,000). */
function crores(n: number): number {
  return Math.round(n * 10_000_000);
}

// ---------------------------------------------------------------------------
// Deterministic RNG — FNV-1a + Mulberry32
// ---------------------------------------------------------------------------

function fnv1a(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const str = String(part);
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function rng(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(...parts: Array<string | number>): () => number {
  return mulberry32(fnv1a(...parts));
}

function asOfDayKey(asOf: Date): string {
  return asOf.toISOString().slice(0, 10);
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function randIso(rng: () => number, yearsBack: number, asOf: Date): string {
  const ms = asOf.getTime() - Math.floor(rng() * yearsBack * 365 * 86_400_000);
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Synthetic primitives
// ---------------------------------------------------------------------------

function makePan(rng: () => number): string {
  let pan = '';
  for (let i = 0; i < 5; i++) pan += PAN_LETTERS.charAt(Math.floor(rng() * 26));
  for (let i = 0; i < 4; i++) pan += Math.floor(rng() * 10).toString();
  pan += PAN_LETTERS.charAt(Math.floor(rng() * 26));
  return pan;
}

function makePhone(rng: () => number): string {
  const head = randInt(rng, 6, 9);
  let tail = '';
  for (let i = 0; i < 9; i++) tail += Math.floor(rng() * 10).toString();
  return `+91${head}${tail}`;
}

function bankAtIndex(i: number): BankCatalogEntry {
  return BANK_CATALOG[(i - 1) % BANK_CATALOG.length] as BankCatalogEntry;
}

function segmentForCustomer(rng: () => number): 'retail' | 'sme' | 'corporate' {
  const r = rng();
  if (r < 0.7) return 'retail';
  if (r < 0.95) return 'sme';
  return 'corporate';
}

function loanTypeForLoan(rng: () => number): LoanType {
  const r = rng() * 100;
  if (r < 25) return 'home';
  if (r < 55) return 'personal';
  if (r < 75) return 'vehicle';
  if (r < 85) return 'education';
  return 'business';
}

function statusForLoan(rng: () => number): LoanStatus {
  const r = rng() * 100;
  if (r < 70) return 'active';
  if (r < 80) return 'watchlist';
  if (r < 86) return 'sma0';
  if (r < 91) return 'sma1';
  if (r < 96) return 'sma2';
  return 'npa';
}

function dpdDaysForStatus(rng: () => number, status: LoanStatus): number {
  switch (status) {
    case 'active':
      return 0;
    case 'watchlist':
      return randInt(rng, 1, 15);
    case 'sma0':
      return randInt(rng, 1, 30);
    case 'sma1':
      return randInt(rng, 31, 60);
    case 'sma2':
      return randInt(rng, 61, 90);
    case 'npa':
      return randInt(rng, 91, 540);
  }
}

function dpdBucketForDays(days: number): DpdBucket {
  if (days === 0) return 'current';
  if (days <= 30) return '1_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return '90_plus';
}

function sectorForLoan(rng: () => number, type: LoanType): SectorClassification {
  if (type === 'home') return rng() < 0.6 ? 'real_estate' : 'services';
  if (type === 'vehicle') return rng() < 0.5 ? 'services' : 'retail_trade';
  if (type === 'education') return 'services';
  if (type === 'business') {
    const r = rng();
    if (r < 0.3) return 'msme';
    if (r < 0.55) return 'manufacturing';
    if (r < 0.75) return 'retail_trade';
    if (r < 0.9) return 'it_ites';
    return 'infrastructure';
  }
  // personal
  return pick(rng, SECTORS);
}

function principalForLoanType(rng: () => number, type: LoanType): number {
  switch (type) {
    case 'home':
      return lakhs(randInt(rng, 25, 200));
    case 'personal':
      return lakhs(randInt(rng, 1, 25));
    case 'vehicle':
      return lakhs(randInt(rng, 3, 30));
    case 'education':
      return lakhs(randInt(rng, 2, 50));
    case 'business':
      return crores(randInt(rng, 1, 25));
  }
}

function tenureForLoanType(rng: () => number, type: LoanType): number {
  switch (type) {
    case 'home':
      return randInt(rng, 120, 360);
    case 'personal':
      return randInt(rng, 12, 60);
    case 'vehicle':
      return randInt(rng, 36, 84);
    case 'education':
      return randInt(rng, 60, 180);
    case 'business':
      return randInt(rng, 24, 120);
  }
}

function balanceForSegment(rng: () => number, segment: Customer['segment'], type: Account['account_type']): number {
  if (type === 'overdraft') {
    return -lakhs(randInt(rng, 1, segment === 'corporate' ? 500 : segment === 'sme' ? 50 : 5));
  }
  if (segment === 'corporate') return crores(randInt(rng, 1, 50));
  if (segment === 'sme') return lakhs(randInt(rng, 5, 200));
  return lakhs(randInt(rng, 0, 25));
}

function accountTypeFor(rng: () => number): Account['account_type'] {
  const r = rng() * 100;
  if (r < 60) return 'savings';
  if (r < 90) return 'current';
  return 'overdraft';
}

// ---------------------------------------------------------------------------
// Branch generator
// ---------------------------------------------------------------------------

function generateBranch(tenant_id: string, dayKey: string, i: number, asOf: Date): Branch {
  const rng = makeRng(tenant_id, dayKey, 'branch', i);
  const bank = bankAtIndex(i);
  const place = pick(rng, STATE_CITY_PAIRS);
  return {
    branch_id: `BR-${bank.code}-${String(i).padStart(4, '0')}`,
    bank_id: bank.bank_id,
    name: `${bank.name} ${place.city} Branch ${i}`,
    region: place.region,
    state: place.state,
    city: place.city,
    ifsc_prefix: `${bank.code}0`,
    opened_at: randIso(rng, 25, asOf),
  };
}

/** Return all 50 synthetic branches deterministically. */
export function listBranches(tenant_id: string, asOf: Date = currentTime()): Branch[] {
  const dayKey = asOfDayKey(asOf);
  const out: Branch[] = [];
  for (let i = 1; i <= TOTAL_BRANCHES; i++) out.push(generateBranch(tenant_id, dayKey, i, asOf));
  return out;
}

/** Lookup a single branch by id; returns null when not in the virtual book. */
export function getBranch(branch_id: string, tenant_id: string, asOf: Date = currentTime()): Branch | null {
  const dayKey = asOfDayKey(asOf);
  const match = branch_id.match(/^BR-([A-Z]+)-(\d{4})$/);
  if (!match) return null;
  const i = parseInt(match[2] as string, 10);
  if (!Number.isFinite(i) || i < 1 || i > TOTAL_BRANCHES) return null;
  const candidate = generateBranch(tenant_id, dayKey, i, asOf);
  return candidate.branch_id === branch_id ? candidate : null;
}

// ---------------------------------------------------------------------------
// Customer generator
// ---------------------------------------------------------------------------

function generateCustomer(tenant_id: string, dayKey: string, i: number, asOf: Date): Customer {
  const rng = makeRng(tenant_id, dayKey, 'customer', i);
  const bank = bankAtIndex(i);
  const gender: Customer['gender'] = rng() < 0.5 ? 'male' : 'female';
  const first = pick(rng, FIRST_NAMES);
  const last = pick(rng, LAST_NAMES);
  const place = pick(rng, STATE_CITY_PAIRS);
  const dobYearsBack = randInt(rng, 22, 70);
  const dob = new Date(asOf.getTime() - dobYearsBack * 365 * 86_400_000).toISOString().slice(0, 10);
  const segment = segmentForCustomer(rng);
  return {
    customer_id: `CUST-${String(i).padStart(6, '0')}`,
    bank_id: bank.bank_id,
    pan: makePan(rng),
    full_name: `${first} ${last}`,
    gender,
    dob,
    city: place.city,
    state: place.state,
    phone: makePhone(rng),
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.in`,
    segment,
  };
}

/** Paginated slice over the 10000-customer virtual book. */
export function listCustomers(
  tenant_id: string,
  asOf: Date = currentTime(),
  offset = 0,
  limit = 100,
): Customer[] {
  const dayKey = asOfDayKey(asOf);
  const start = Math.max(0, offset) + 1;
  const end = Math.min(TOTAL_CUSTOMERS, Math.max(0, offset) + Math.max(0, limit));
  const out: Customer[] = [];
  for (let i = start; i <= end; i++) out.push(generateCustomer(tenant_id, dayKey, i, asOf));
  return out;
}

/** Lookup a single customer by id; returns null when out of range. */
export function getCustomer(customer_id: string, tenant_id: string, asOf: Date = currentTime()): Customer | null {
  const dayKey = asOfDayKey(asOf);
  const match = customer_id.match(/^CUST-(\d{6})$/);
  if (!match) return null;
  const i = parseInt(match[1] as string, 10);
  if (!Number.isFinite(i) || i < 1 || i > TOTAL_CUSTOMERS) return null;
  return generateCustomer(tenant_id, dayKey, i, asOf);
}

// ---------------------------------------------------------------------------
// Account generator
// ---------------------------------------------------------------------------

function generateAccount(tenant_id: string, dayKey: string, j: number, asOf: Date): Account {
  const rng = makeRng(tenant_id, dayKey, 'account', j);
  const customerIndex = ((j - 1) % TOTAL_CUSTOMERS) + 1;
  const customer = generateCustomer(tenant_id, dayKey, customerIndex, asOf);
  const accountType = accountTypeFor(rng);
  const branchIdx = ((j - 1) % TOTAL_BRANCHES) + 1;
  const branch = generateBranch(tenant_id, dayKey, branchIdx, asOf);
  const statusRoll = rng();
  const status: Account['status'] =
    statusRoll < 0.85 ? 'active' : statusRoll < 0.97 ? 'dormant' : 'frozen';
  return {
    account_id: `ACC-${String(j).padStart(7, '0')}`,
    customer_id: customer.customer_id,
    bank_id: customer.bank_id,
    branch_id: branch.branch_id,
    account_type: accountType,
    balance_inr: balanceForSegment(rng, customer.segment, accountType),
    opened_at: randIso(rng, 10, asOf),
    status,
  };
}

/** Paginated slice over the 50000-account virtual book. */
export function listAccounts(
  tenant_id: string,
  asOf: Date = currentTime(),
  offset = 0,
  limit = 100,
): Account[] {
  const dayKey = asOfDayKey(asOf);
  const start = Math.max(0, offset) + 1;
  const end = Math.min(TOTAL_ACCOUNTS, Math.max(0, offset) + Math.max(0, limit));
  const out: Account[] = [];
  for (let j = start; j <= end; j++) out.push(generateAccount(tenant_id, dayKey, j, asOf));
  return out;
}

/** Lookup a single account by id; returns null when out of range. */
export function getAccount(account_id: string, tenant_id: string, asOf: Date = currentTime()): Account | null {
  const dayKey = asOfDayKey(asOf);
  const match = account_id.match(/^ACC-(\d{7})$/);
  if (!match) return null;
  const j = parseInt(match[1] as string, 10);
  if (!Number.isFinite(j) || j < 1 || j > TOTAL_ACCOUNTS) return null;
  return generateAccount(tenant_id, dayKey, j, asOf);
}

// ---------------------------------------------------------------------------
// Loan generator
// ---------------------------------------------------------------------------

function generateLoan(tenant_id: string, dayKey: string, k: number, asOf: Date): Loan {
  const rng = makeRng(tenant_id, dayKey, 'loan', k);
  const customerIndex = ((k - 1) % TOTAL_CUSTOMERS) + 1;
  const customer = generateCustomer(tenant_id, dayKey, customerIndex, asOf);
  const branchIdx = ((k - 1) % TOTAL_BRANCHES) + 1;
  const branch = generateBranch(tenant_id, dayKey, branchIdx, asOf);
  const loanType = loanTypeForLoan(rng);
  const sector = sectorForLoan(rng, loanType);
  const principal = principalForLoanType(rng, loanType);
  const tenure = tenureForLoanType(rng, loanType);
  const status = statusForLoan(rng);
  const dpdDays = dpdDaysForStatus(rng, status);
  const dpdBucket = dpdBucketForDays(dpdDays);
  const utilization = Math.round((0.3 + rng() * 0.7) * 100);
  const outstanding = Math.round(principal * (0.4 + rng() * 0.55));
  const emi = Math.max(1000, Math.round(principal / Math.max(tenure, 1)));
  const missed = status === 'active' ? 0 : status === 'watchlist' ? randInt(rng, 0, 1) : randInt(rng, 1, 6);
  return {
    loan_id: `LOAN-${String(k).padStart(7, '0')}`,
    customer_id: customer.customer_id,
    bank_id: customer.bank_id,
    branch_id: branch.branch_id,
    loan_type: loanType,
    sector,
    principal_inr: principal,
    outstanding_inr: outstanding,
    emi_inr: emi,
    dpd_days: dpdDays,
    dpd_bucket: dpdBucket,
    status,
    sanctioned_at: randIso(rng, 8, asOf),
    tenure_months: tenure,
    credit_utilization_pct: utilization,
    sector_exposure_inr: outstanding,
    missed_emi_count: missed,
  };
}

function loanMatches(
  loan: Loan,
  filter?: { status?: LoanStatus; sector?: SectorClassification; bank_id?: string },
): boolean {
  if (!filter) return true;
  if (filter.status && loan.status !== filter.status) return false;
  if (filter.sector && loan.sector !== filter.sector) return false;
  if (filter.bank_id && loan.bank_id !== filter.bank_id) return false;
  return true;
}

/** Paginated, optionally filtered slice over the 20000-loan virtual book. */
export function listLoans(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: { status?: LoanStatus; sector?: SectorClassification; bank_id?: string },
  offset = 0,
  limit = 100,
): Loan[] {
  const dayKey = asOfDayKey(asOf);
  const out: Loan[] = [];
  const want = Math.max(0, limit);
  let skipped = 0;
  const skipTarget = Math.max(0, offset);
  for (let k = 1; k <= TOTAL_LOANS && out.length < want; k++) {
    const loan = generateLoan(tenant_id, dayKey, k, asOf);
    if (!loanMatches(loan, filter)) continue;
    if (skipped < skipTarget) {
      skipped++;
      continue;
    }
    out.push(loan);
  }
  return out;
}

/** Lookup a single loan by id; returns null when out of range. */
export function getLoan(loan_id: string, tenant_id: string, asOf: Date = currentTime()): Loan | null {
  const dayKey = asOfDayKey(asOf);
  const match = loan_id.match(/^LOAN-(\d{7})$/);
  if (!match) return null;
  const k = parseInt(match[1] as string, 10);
  if (!Number.isFinite(k) || k < 1 || k > TOTAL_LOANS) return null;
  return generateLoan(tenant_id, dayKey, k, asOf);
}

// ---------------------------------------------------------------------------
// Portfolio analytics (sampled — virtual book is too large to fully enumerate)
// ---------------------------------------------------------------------------

const PORTFOLIO_SAMPLE_SIZE = 2000;

function emptyLoanTypeRecord(): Record<LoanType, number> {
  const r = {} as Record<LoanType, number>;
  for (const t of LOAN_TYPES) r[t] = 0;
  return r;
}

function emptyLoanStatusRecord(): Record<LoanStatus, number> {
  const r = {} as Record<LoanStatus, number>;
  for (const s of LOAN_STATUSES) r[s] = 0;
  return r;
}

function emptySectorRecord(): Record<SectorClassification, number> {
  const r = {} as Record<SectorClassification, number>;
  for (const s of SECTORS) r[s] = 0;
  return r;
}

function emptyDpdRecord(): Record<DpdBucket, number> {
  const r = {} as Record<DpdBucket, number>;
  for (const b of DPD_BUCKETS) r[b] = 0;
  return r;
}

/** Roll up portfolio totals + distributions across the loan book. */
export function summarizeBankingPortfolio(
  tenant_id: string,
  asOf: Date = currentTime(),
): {
  total_customers: number;
  total_accounts: number;
  total_loans: number;
  total_portfolio_inr: number;
  by_loan_type: Record<LoanType, number>;
  by_loan_status: Record<LoanStatus, number>;
  by_sector: Record<SectorClassification, number>;
  by_dpd_bucket: Record<DpdBucket, number>;
  npa_count: number;
  npa_outstanding_inr: number;
  sma_count: number;
  watchlist_count: number;
  top_sectors_by_exposure: Array<{ sector: SectorClassification; exposure_inr: number; share_pct: number }>;
} {
  const dayKey = asOfDayKey(asOf);
  const byLoanType = emptyLoanTypeRecord();
  const byLoanStatus = emptyLoanStatusRecord();
  const bySector = emptySectorRecord();
  const byDpd = emptyDpdRecord();
  const sectorExposure = emptySectorRecord();
  let sampledOutstanding = 0;
  let sampledNpaOutstanding = 0;
  let sampledNpaCount = 0;
  let sampledSmaCount = 0;
  let sampledWatchlistCount = 0;

  const sampleSize = Math.min(PORTFOLIO_SAMPLE_SIZE, TOTAL_LOANS);
  const step = Math.max(1, Math.floor(TOTAL_LOANS / sampleSize));
  let sampled = 0;
  for (let k = 1; k <= TOTAL_LOANS && sampled < sampleSize; k += step) {
    const loan = generateLoan(tenant_id, dayKey, k, asOf);
    byLoanType[loan.loan_type]++;
    byLoanStatus[loan.status]++;
    bySector[loan.sector]++;
    byDpd[loan.dpd_bucket]++;
    sectorExposure[loan.sector] += loan.outstanding_inr;
    sampledOutstanding += loan.outstanding_inr;
    if (loan.status === 'npa') {
      sampledNpaCount++;
      sampledNpaOutstanding += loan.outstanding_inr;
    } else if (loan.status === 'sma0' || loan.status === 'sma1' || loan.status === 'sma2') {
      sampledSmaCount++;
    } else if (loan.status === 'watchlist') {
      sampledWatchlistCount++;
    }
    sampled++;
  }

  const scale = TOTAL_LOANS / Math.max(sampled, 1);
  const scaledByType = emptyLoanTypeRecord();
  for (const t of LOAN_TYPES) scaledByType[t] = Math.round(byLoanType[t] * scale);
  const scaledByStatus = emptyLoanStatusRecord();
  for (const s of LOAN_STATUSES) scaledByStatus[s] = Math.round(byLoanStatus[s] * scale);
  const scaledBySector = emptySectorRecord();
  for (const s of SECTORS) scaledBySector[s] = Math.round(bySector[s] * scale);
  const scaledByDpd = emptyDpdRecord();
  for (const b of DPD_BUCKETS) scaledByDpd[b] = Math.round(byDpd[b] * scale);

  const totalPortfolioInr = Math.round(sampledOutstanding * scale);
  const npaOutstandingInr = Math.round(sampledNpaOutstanding * scale);

  const sectorExposureScaled: Array<{ sector: SectorClassification; exposure_inr: number }> = SECTORS.map((s) => ({
    sector: s,
    exposure_inr: Math.round(sectorExposure[s] * scale),
  }));
  sectorExposureScaled.sort((a, b) => b.exposure_inr - a.exposure_inr);
  const totalExposure = sectorExposureScaled.reduce((acc, row) => acc + row.exposure_inr, 0);
  const topSectors = sectorExposureScaled.slice(0, 5).map((row) => ({
    sector: row.sector,
    exposure_inr: row.exposure_inr,
    share_pct: totalExposure > 0 ? Math.round((row.exposure_inr / totalExposure) * 10000) / 100 : 0,
  }));

  return {
    total_customers: TOTAL_CUSTOMERS,
    total_accounts: TOTAL_ACCOUNTS,
    total_loans: TOTAL_LOANS,
    total_portfolio_inr: totalPortfolioInr,
    by_loan_type: scaledByType,
    by_loan_status: scaledByStatus,
    by_sector: scaledBySector,
    by_dpd_bucket: scaledByDpd,
    npa_count: Math.round(sampledNpaCount * scale),
    npa_outstanding_inr: npaOutstandingInr,
    sma_count: Math.round(sampledSmaCount * scale),
    watchlist_count: Math.round(sampledWatchlistCount * scale),
    top_sectors_by_exposure: topSectors,
  };
}

/** Bank-wise rollup — one row per BANK_CATALOG entry. */
export function summarizeBankWise(
  tenant_id: string,
  asOf: Date = currentTime(),
): Array<{
  bank_id: string;
  bank_name: string;
  customers: number;
  loans: number;
  total_outstanding_inr: number;
  npa_count: number;
  npa_pct: number;
}> {
  const dayKey = asOfDayKey(asOf);
  type Bucket = { customers: number; loans: number; outstanding: number; npa: number };
  const buckets = new Map<string, Bucket>();
  for (const b of BANK_CATALOG) {
    buckets.set(b.bank_id, { customers: 0, loans: 0, outstanding: 0, npa: 0 });
  }

  // Customer counts can be computed exactly because the rotation is fixed.
  for (let i = 1; i <= TOTAL_CUSTOMERS; i++) {
    const bank = bankAtIndex(i);
    const bucket = buckets.get(bank.bank_id);
    if (bucket) bucket.customers++;
  }

  const sampleSize = Math.min(PORTFOLIO_SAMPLE_SIZE, TOTAL_LOANS);
  const step = Math.max(1, Math.floor(TOTAL_LOANS / sampleSize));
  let sampled = 0;
  for (let k = 1; k <= TOTAL_LOANS && sampled < sampleSize; k += step) {
    const loan = generateLoan(tenant_id, dayKey, k, asOf);
    const bucket = buckets.get(loan.bank_id);
    if (!bucket) continue;
    bucket.loans++;
    bucket.outstanding += loan.outstanding_inr;
    if (loan.status === 'npa') bucket.npa++;
    sampled++;
  }

  const scale = TOTAL_LOANS / Math.max(sampled, 1);
  return BANK_CATALOG.map((b) => {
    const bucket = buckets.get(b.bank_id) ?? { customers: 0, loans: 0, outstanding: 0, npa: 0 };
    const loans = Math.round(bucket.loans * scale);
    const npa = Math.round(bucket.npa * scale);
    const outstanding = Math.round(bucket.outstanding * scale);
    return {
      bank_id: b.bank_id,
      bank_name: b.name,
      customers: bucket.customers,
      loans,
      total_outstanding_inr: outstanding,
      npa_count: npa,
      npa_pct: loans > 0 ? Math.round((npa / loans) * 10000) / 100 : 0,
    };
  });
}
