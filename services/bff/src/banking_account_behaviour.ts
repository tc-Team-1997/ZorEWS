// services/bff/src/banking_account_behaviour.ts
//
// Account Behaviour signals — closes §2.1.3 of
// ZorEWS_Pending_Gap_Analysis.md.
//
// 3 endpoints back the Account Behaviour wireframe screen:
//   GET  /v1/banking/accounts/signals?customer_id=&watchlist_only=
//   GET  /v1/banking/accounts/:account_id/patterns
//   POST /v1/banking/accounts/:account_id/block         (4-eyes maker-checker)
//
// Distinct from CBS account read-model — this is the BEHAVIOURAL surface
// (transaction patterns, salary-disappearance, cheque-bounce, branch-
// hopping etc.) that the EWS uses to score retail+SME accounts.

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export type SignalSeverity = 'low' | 'medium' | 'high' | 'critical';
export const ALL_SIGNAL_SEVERITIES: readonly SignalSeverity[] = ['low', 'medium', 'high', 'critical'];

export const ACCOUNT_SIGNAL_TYPES = [
  'salary_disappeared',
  'cash_withdrawal_spike',
  'multiple_account_open',
  'cheque_bounce_repeated',
  'min_balance_breach',
  'velocity_spike_24h',
  'inter_branch_transfer_pattern',
  'channel_anomaly',
  'unusual_atm_geo_velocity',
  'dormant_reactivation_high_value',
] as const;

export type AccountSignalType = (typeof ACCOUNT_SIGNAL_TYPES)[number];

export interface AccountSignal {
  signal_id: string;
  account_id: string;
  customer_id: string;
  customer_name: string;
  signal_type: AccountSignalType;
  severity: SignalSeverity;
  score: number;
  observed_at: string;
  description: string;
  is_watchlisted: boolean;
}

export interface AccountSignalsReport {
  tenant_id: string;
  generated_at: string;
  customer_id: string | null;
  watchlist_only: boolean;
  total: number;
  by_severity: Record<SignalSeverity, number>;
  by_type: Partial<Record<AccountSignalType, number>>;
  signals: AccountSignal[];
}

export class AccountBehaviourError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AccountBehaviourError';
  }
}

function tenantScale(t: string): number {
  return t === 'BIL' ? 0.6 : 1.0;
}

function customerCount(tenant_id: string): number {
  return Math.floor(200 * tenantScale(tenant_id));
}

function severityFromScore(score: number): SignalSeverity {
  if (score >= 0.85) return 'critical';
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

const FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Mehta'];

function customerSeed(tenant_id: string, idx: number): { customer_id: string; name: string } {
  const cid = `c-${String(100000 + idx).slice(-6)}`;
  const rng = mulberry32(fnv1a(`${tenant_id}|${cid}|name`));
  const name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;
  return { customer_id: cid, name };
}

function descriptionFor(type: AccountSignalType, score: number): string {
  const pct = Math.round(score * 100);
  switch (type) {
    case 'salary_disappeared':
      return `Salary credit missing for 2 consecutive months (anomaly score ${pct}).`;
    case 'cash_withdrawal_spike':
      return `Cash withdrawals 3.2σ above 90-day baseline (score ${pct}).`;
    case 'multiple_account_open':
      return `4 new accounts opened in last 30 days at sibling branches (score ${pct}).`;
    case 'cheque_bounce_repeated':
      return `Cheque return ratio 12% over 60 days (score ${pct}).`;
    case 'min_balance_breach':
      return `Min-balance breached 8 days in last 30 (score ${pct}).`;
    case 'velocity_spike_24h':
      return `24h transaction volume 4.1σ above baseline (score ${pct}).`;
    case 'inter_branch_transfer_pattern':
      return `Funds round-tripping across 5 branches (score ${pct}).`;
    case 'channel_anomaly':
      return `Sudden shift from branch to mobile + new IP cluster (score ${pct}).`;
    case 'unusual_atm_geo_velocity':
      return `ATM withdrawals 800km apart within 4h (score ${pct}).`;
    case 'dormant_reactivation_high_value':
      return `2-yr-dormant account reactivated with INR 15L transfer (score ${pct}).`;
  }
}

export function buildAccountSignals(
  tenant_id: string,
  filter: { customer_id?: string; watchlist_only?: boolean },
  now: Date,
): AccountSignalsReport {
  if (!tenant_id) throw new AccountBehaviourError('invalid_input', 'tenant_id is required');

  const day = now.toISOString().slice(0, 10);
  const signals: AccountSignal[] = [];
  const byType: Partial<Record<AccountSignalType, number>> = {};
  const bySev: Record<SignalSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };

  const customerFilter = filter.customer_id ?? null;
  const watchlistOnly = !!filter.watchlist_only;

  for (let i = 0; i < customerCount(tenant_id); i++) {
    const { customer_id, name } = customerSeed(tenant_id, i);
    if (customerFilter && customer_id !== customerFilter) continue;
    const rng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|${day}|signals`));
    const numSignals = Math.floor(rng() * 3); // 0-2 signals per customer
    for (let s = 0; s < numSignals; s++) {
      const tRng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|${day}|s${s}`));
      const type = ACCOUNT_SIGNAL_TYPES[Math.floor(tRng() * ACCOUNT_SIGNAL_TYPES.length)];
      const score = Math.round((0.3 + tRng() * 0.65) * 100) / 100;
      const sev = severityFromScore(score);
      const isWl = tRng() < 0.35;
      if (watchlistOnly && !isWl) continue;
      const sig: AccountSignal = {
        signal_id: `sig-${tenant_id}-${customer_id}-${s}-${day}`,
        account_id: `a-${customer_id.slice(2)}-${String(s).padStart(2, '0')}`,
        customer_id,
        customer_name: name,
        signal_type: type,
        severity: sev,
        score,
        observed_at: new Date(now.getTime() - Math.floor(tRng() * 86_400_000)).toISOString(),
        description: descriptionFor(type, score),
        is_watchlisted: isWl,
      };
      signals.push(sig);
      bySev[sev]++;
      byType[type] = (byType[type] ?? 0) + 1;
    }
  }

  // Sort severity desc then score desc
  const sevRank: Record<SignalSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  signals.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.score - a.score);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    customer_id: customerFilter,
    watchlist_only: watchlistOnly,
    total: signals.length,
    by_severity: bySev,
    by_type: byType,
    signals: signals.slice(0, 200),
  };
}

export interface AccountPattern {
  pattern_type: 'monthly_balance' | 'channel_mix' | 'txn_velocity' | 'cheque_returns';
  label: string;
  series: { date: string; value: number }[];
  anomaly_score: number;
}

export interface AccountPatternsReport {
  tenant_id: string;
  generated_at: string;
  account_id: string;
  customer_id: string;
  patterns: AccountPattern[];
}

export function buildAccountPatterns(
  tenant_id: string,
  account_id: string,
  now: Date,
): AccountPatternsReport {
  if (!tenant_id) throw new AccountBehaviourError('invalid_input', 'tenant_id required');
  if (!account_id) throw new AccountBehaviourError('invalid_input', 'account_id required');

  // Derive customer_id from account_id (a-XXXXXX-NN → c-XXXXXX)
  const m = account_id.match(/^a-(\d+)-\d+$/);
  const customer_id = m ? `c-${m[1]}` : 'c-unknown';

  const patterns: AccountPattern[] = [];
  const labels: Record<AccountPattern['pattern_type'], string> = {
    monthly_balance: 'Monthly average balance (₹)',
    channel_mix: 'Mobile channel usage (% txns)',
    txn_velocity: 'Daily transaction count',
    cheque_returns: 'Cheque returns per 30 days',
  };
  for (const t of ['monthly_balance', 'channel_mix', 'txn_velocity', 'cheque_returns'] as const) {
    const rng = mulberry32(fnv1a(`${tenant_id}|${account_id}|${t}`));
    const series: { date: string; value: number }[] = [];
    let v = t === 'monthly_balance' ? 50000 + rng() * 200000 : t === 'channel_mix' ? 0.4 + rng() * 0.3 : t === 'txn_velocity' ? 5 + rng() * 15 : 0;
    for (let i = 11; i >= 0; i--) {
      const ts = new Date(now.getTime() - i * 30 * 86_400_000);
      // Inject anomaly in last 2 months for some types
      const anomalyMult = i < 2 && rng() < 0.5 ? 1 + rng() * 1.5 : 1;
      v = v * (0.85 + rng() * 0.3) * anomalyMult;
      series.push({
        date: ts.toISOString().slice(0, 10),
        value: t === 'channel_mix' ? Math.min(1, Math.max(0, Math.round(v * 100) / 100)) : Math.round(v),
      });
    }
    const lastVal = series[series.length - 1].value;
    const meanVal = series.reduce((a, p) => a + p.value, 0) / series.length;
    const anomaly = meanVal === 0 ? 0 : Math.min(1, Math.abs(lastVal - meanVal) / Math.abs(meanVal));
    patterns.push({
      pattern_type: t,
      label: labels[t],
      series,
      anomaly_score: Math.round(anomaly * 100) / 100,
    });
  }
  return {
    tenant_id,
    generated_at: now.toISOString(),
    account_id,
    customer_id,
    patterns,
  };
}

// ─── 4-eyes block workflow ─────────────────────────────────────────────

export interface AccountBlockRequest {
  request_id: string;
  tenant_id: string;
  account_id: string;
  customer_id: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

let _blockSeq = 0;

const blockStore = new Map<string, AccountBlockRequest>();

export function proposeAccountBlock(
  tenant_id: string,
  account_id: string,
  reason: string,
  requested_by: string,
  now: Date,
): AccountBlockRequest {
  if (!tenant_id) throw new AccountBehaviourError('invalid_input', 'tenant_id required');
  if (!account_id) throw new AccountBehaviourError('invalid_input', 'account_id required');
  if (!reason || reason.trim().length < 5)
    throw new AccountBehaviourError('invalid_input', 'reason must be ≥5 chars');
  if (!requested_by) throw new AccountBehaviourError('invalid_input', 'requested_by required');

  const m = account_id.match(/^a-(\d+)-\d+$/);
  const customer_id = m ? `c-${m[1]}` : 'c-unknown';
  _blockSeq++;
  const id = `blk-${tenant_id}-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${String(_blockSeq).padStart(4, '0')}`;
  const entry: AccountBlockRequest = {
    request_id: id,
    tenant_id,
    account_id,
    customer_id,
    reason: reason.trim(),
    status: 'pending',
    requested_by,
    requested_at: now.toISOString(),
    reviewed_by: null,
    reviewed_at: null,
  };
  blockStore.set(id, entry);
  return entry;
}

export function listBlockRequests(tenant_id: string, status?: 'pending' | 'approved' | 'rejected'): AccountBlockRequest[] {
  const out: AccountBlockRequest[] = [];
  for (const e of blockStore.values()) {
    if (e.tenant_id !== tenant_id) continue;
    if (status && e.status !== status) continue;
    out.push(e);
  }
  out.sort((a, b) => b.requested_at.localeCompare(a.requested_at));
  return out;
}

export function reviewBlockRequest(
  tenant_id: string,
  request_id: string,
  decision: 'approve' | 'reject',
  checker: string,
  now: Date,
): AccountBlockRequest {
  if (!checker) throw new AccountBehaviourError('invalid_input', 'checker required');
  const entry = blockStore.get(request_id);
  if (!entry || entry.tenant_id !== tenant_id)
    throw new AccountBehaviourError('unknown_request', `unknown block request ${request_id}`);
  if (entry.status !== 'pending')
    throw new AccountBehaviourError('already_decided', `request already ${entry.status}`);
  if (entry.requested_by === checker)
    throw new AccountBehaviourError('self_approval_forbidden', 'maker cannot be checker (4-eyes)');
  entry.status = decision === 'approve' ? 'approved' : 'rejected';
  entry.reviewed_by = checker;
  entry.reviewed_at = now.toISOString();
  return entry;
}

export function _resetBlockStore() {
  blockStore.clear();
  _blockSeq = 0;
}
