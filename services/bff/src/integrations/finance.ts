// services/bff/src/integrations/finance.ts
//
// T6 M14.7 — Finance / Treasury adapter (7th adapter in Module 14).
//
// The BIL pitch lists Finance as one of the 11 upstream systems.
// Finance holds:
//   - per-customer account summaries (savings / current / loan / credit_card)
//   - ledger entries for each account (credit/debit history with running
//     balance + narrative)
//
// This adapter is the read-side: the SPA + case-investigation workflow
// can pull a customer's accounts and walk the ledger to support the
// indicator engine + the AML investigation step.
//
// Production swap: HTTP/SOAP gateway to the Finance core (e.g. Oracle
// Flexcube / TCS BaNCS / a fintech equivalent). The stub holds an
// in-memory model — deterministic per (tenant, customer, asOf-day).

// ─── Public types ──────────────────────────────────────────────────────

export type AccountType = 'savings' | 'current' | 'loan' | 'credit_card';
export type AccountStatus = 'active' | 'frozen' | 'closed';
export type LedgerEntryType = 'credit' | 'debit';
export type Currency = 'KES' | 'USD' | 'EUR';

export interface FinanceAccount {
  account_id: string;
  customer_id: string;
  account_type: AccountType;
  currency: Currency;
  /** Latest balance. Negative on loan accounts (= principal owed)
   *  and credit cards (= utilised). */
  balance_kes: number;
  /** ISO timestamp of the most-recent ledger entry. */
  last_activity_at: string;
  status: AccountStatus;
}

export interface LedgerEntry {
  entry_id: string;
  account_id: string;
  type: LedgerEntryType;
  amount_kes: number;
  currency: Currency;
  narrative: string;
  posted_at: string;
  /** Running balance after this entry was applied. */
  balance_kes_after: number;
}

export interface LedgerPage {
  items: LedgerEntry[];
  account_id: string;
  page: number;
  page_size: number;
  total: number;
  /** ISO bounds applied to the query. null when not supplied. */
  since: string | null;
  until: string | null;
}

export interface FinanceAdapter {
  /** Single account by id. Tenant-scoped. */
  getAccount(tenant_id: string, account_id: string, asOf: Date): Promise<FinanceAccount | null>;
  /** Accounts attached to a customer. Empty array on empty inputs. */
  listAccountsForCustomer(tenant_id: string, customer_id: string, asOf: Date): Promise<FinanceAccount[]>;
  /** Paginated ledger; newest-first; optional ISO time-window. Throws
   *  FinanceError when account is unknown / cross-tenant. */
  listLedger(
    tenant_id: string,
    account_id: string,
    opts: { since?: string; until?: string; page?: number; page_size?: number },
    asOf: Date,
  ): Promise<LedgerPage>;
}

export class FinanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FinanceError';
  }
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
function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]!;
}
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function daysBefore(d: Date, n: number): string {
  return new Date(d.getTime() - n * 86_400_000).toISOString();
}

// ─── Stub data ─────────────────────────────────────────────────────────

const ACCOUNT_TYPES: AccountType[] = ['savings', 'current', 'loan', 'credit_card'];
const STATUSES: AccountStatus[] = ['active', 'active', 'active', 'active', 'frozen', 'closed'];

const NARRATIVES_CREDIT = [
  'Salary credit',
  'Funds transfer in',
  'Interest credit',
  'Dividend received',
  'Refund credit',
  'Cash deposit',
];
const NARRATIVES_DEBIT = [
  'POS purchase',
  'Funds transfer out',
  'Bill payment',
  'ATM withdrawal',
  'EMI debit',
  'Standing instruction',
  'Wire transfer out',
];

/** Account count per (tenant, customer): ~10% none, 35% 1-2, 40% 3-4,
 *  15% 5-7. */
function accountCountFor(seed: number): number {
  const r = rng(seed)();
  if (r < 0.1) return 0;
  if (r < 0.45) return 1 + Math.floor(rng(seed * 13)() * 2);
  if (r < 0.85) return 3 + Math.floor(rng(seed * 17)() * 2);
  return 5 + Math.floor(rng(seed * 19)() * 3);
}

function buildAccount(
  tenant_id: string,
  customer_id: string,
  index: number,
  asOf: Date,
): FinanceAccount {
  const seed = fnv1a(`acct|${tenant_id}|${customer_id}|${index}`);
  const r = rng(seed);
  const account_type = pick(r, ACCOUNT_TYPES);
  const status = pick(r, STATUSES);

  // Calibrated balance ranges per account type.
  let balance_kes: number;
  if (account_type === 'savings') {
    balance_kes = Math.round(20_000 + r() * 2_980_000); // 20k-3M
  } else if (account_type === 'current') {
    balance_kes = Math.round(-50_000 + r() * 5_050_000); // -50k to 5M (overdraft)
  } else if (account_type === 'loan') {
    balance_kes = -Math.round(100_000 + r() * 9_900_000); // -100k to -10M (always owed)
  } else {
    // credit_card — typical utilisation 0 to -limit
    const limit = Math.round(50_000 + r() * 950_000); // 50k - 1M limit
    balance_kes = -Math.round(r() * limit);
  }

  // Closed accounts have zero or near-zero activity.
  const last_activity_days = status === 'closed' ? 90 + Math.floor(r() * 1825) : Math.floor(r() * 90);
  const last_activity_at = daysBefore(asOf, last_activity_days);

  return {
    account_id: `ACC-${tenant_id.slice(0, 3).toUpperCase()}-${(seed % 10_000_000).toString().padStart(7, '0')}`,
    customer_id,
    account_type,
    currency: 'KES',
    balance_kes,
    last_activity_at,
    status,
  };
}

/** How many ledger entries an account has, deterministically. Caps at 50
 *  for the prototype; production stores have full history. */
function ledgerCountFor(seed: number, status: AccountStatus): number {
  if (status === 'closed') return Math.min(10, 1 + (seed % 10));
  if (status === 'frozen') return Math.min(20, 5 + (seed % 16));
  // active
  return 20 + (seed % 31); // 20-50
}

function buildLedger(
  tenant_id: string,
  account: FinanceAccount,
  asOf: Date,
): LedgerEntry[] {
  const seed = fnv1a(`ledger|${tenant_id}|${account.account_id}|${dayOf(asOf)}`);
  const r = rng(seed);
  const n = ledgerCountFor(seed, account.status);

  // Walk back from current balance, picking debits/credits, building
  // the sequence in posted_at-asc order then reverse for newest-first.
  // We assign each entry a random delta + opposite sign such that the
  // final running balance matches account.balance_kes.
  const entries: LedgerEntry[] = [];
  let runningBalance = account.balance_kes;

  for (let i = 0; i < n; i++) {
    const isCredit = r() < 0.5;
    const delta = Math.round(500 + r() * 49_500); // 500 - 50k KES
    const type: LedgerEntryType = isCredit ? 'credit' : 'debit';
    const narrative = pick(r, isCredit ? NARRATIVES_CREDIT : NARRATIVES_DEBIT);
    // Each entry posted up to 365 days back; spaced.
    const daysBack = Math.floor((i / n) * 365 + r() * 5);
    const posted_at = daysBefore(asOf, daysBack);
    const amount_kes = delta;

    entries.push({
      entry_id: `LE-${tenant_id.slice(0, 3).toUpperCase()}-${((seed + i) % 100_000_000).toString().padStart(8, '0')}`,
      account_id: account.account_id,
      type,
      amount_kes,
      currency: 'KES',
      narrative,
      posted_at,
      balance_kes_after: runningBalance,
    });

    // Walk the running balance backwards: applying this entry's INVERSE
    // (since we're going back in time) gives the prior balance.
    runningBalance += isCredit ? -delta : delta;
  }

  // Newest-first
  entries.sort((a, b) => b.posted_at.localeCompare(a.posted_at));
  return entries;
}

// ─── Stub adapter ──────────────────────────────────────────────────────

export class StubFinanceAdapter implements FinanceAdapter {
  /** tenant_id → customer_id → account_id[] (cache to keep accounts list
   *  + by-id consistent). */
  private readonly byCustomer = new Map<string, Map<string, FinanceAccount[]>>();
  /** tenant_id → account_id → FinanceAccount (reverse index). */
  private readonly byId = new Map<string, Map<string, FinanceAccount>>();

  async getAccount(
    tenant_id: string,
    account_id: string,
    _asOf: Date,
  ): Promise<FinanceAccount | null> {
    return this.byId.get(tenant_id)?.get(account_id) ?? null;
  }

  async listAccountsForCustomer(
    tenant_id: string,
    customer_id: string,
    asOf: Date,
  ): Promise<FinanceAccount[]> {
    if (!tenant_id || !customer_id) return [];
    let custMap = this.byCustomer.get(tenant_id);
    if (!custMap) {
      custMap = new Map();
      this.byCustomer.set(tenant_id, custMap);
    }
    let accounts = custMap.get(customer_id);
    if (!accounts) {
      const seed = fnv1a(`count|${tenant_id}|${customer_id}`);
      const n = accountCountFor(seed);
      accounts = [];
      for (let i = 0; i < n; i++) {
        accounts.push(buildAccount(tenant_id, customer_id, i, asOf));
      }
      custMap.set(customer_id, accounts);
      let idMap = this.byId.get(tenant_id);
      if (!idMap) {
        idMap = new Map();
        this.byId.set(tenant_id, idMap);
      }
      for (const a of accounts) idMap.set(a.account_id, a);
    }
    return [...accounts].sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  }

  async listLedger(
    tenant_id: string,
    account_id: string,
    opts: { since?: string; until?: string; page?: number; page_size?: number },
    asOf: Date,
  ): Promise<LedgerPage> {
    const account = this.byId.get(tenant_id)?.get(account_id);
    if (!account) {
      throw new FinanceError('unknown_account', `unknown account: ${account_id}`);
    }
    if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since))) {
      throw new FinanceError('invalid_since', `since must be an ISO timestamp: ${opts.since}`);
    }
    if (opts.until !== undefined && Number.isNaN(Date.parse(opts.until))) {
      throw new FinanceError('invalid_until', `until must be an ISO timestamp: ${opts.until}`);
    }
    const all = buildLedger(tenant_id, account, asOf);
    const filtered = all.filter((e) => {
      if (opts.since !== undefined && e.posted_at < opts.since) return false;
      if (opts.until !== undefined && e.posted_at > opts.until) return false;
      return true;
    });
    const page = Math.max(1, opts.page ?? 1);
    const page_size = Math.max(1, Math.min(200, opts.page_size ?? 50));
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size),
      account_id,
      page,
      page_size,
      total: filtered.length,
      since: opts.since ?? null,
      until: opts.until ?? null,
    };
  }

  /** Test helper. */
  reset(): void {
    this.byCustomer.clear();
    this.byId.clear();
  }
}

/** Module-level singleton. */
export const defaultFinanceAdapter: FinanceAdapter = new StubFinanceAdapter();
