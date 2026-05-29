// services/bff/src/banking_collections.ts
//
// Collections Risk — closes §2.1.7 (Collections Risk / Recovery) of the
// Phase-5 Banking Risk Intelligence spec.
//
// 5 endpoints back the Collections Risk desk screen:
//   GET  /v1/banking/collections/summary                 — recovery KPIs + DPD funnel + stage funnel
//   GET  /v1/banking/collections/queue                   — work-queue rows (filterable + recovery-priority sorted)
//   GET  /v1/banking/collections/:account_id             — account collection 360 (contact + PTP history)
//   POST /v1/banking/collections/:account_id/ptp         — record a promise-to-pay
//   POST /v1/banking/collections/:account_id/log-contact — log a collection contact attempt
//
// Distinct from the collection-adapter service (auto case routing on
// apex.case.events) — this is the read/operate surface for the collections
// officer's daily work-queue. Deterministic synthesis (FNV-1a + Mulberry32
// per (tenant, account, day)) matches the other banking-EWS pages; PTP +
// contact-log mutations are held in an in-memory overlay (Map keyed by
// (tenant, account_id)) with a reset helper for tests.

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

// ── Closed enums ────────────────────────────────────────────────────────

export type DpdBucket = 'dpd_1_30' | 'dpd_31_60' | 'dpd_61_90' | 'dpd_90_plus';
export const ALL_DPD_BUCKETS: readonly DpdBucket[] = [
  'dpd_1_30',
  'dpd_31_60',
  'dpd_61_90',
  'dpd_90_plus',
];

// Recovery stages in escalation order (soft → legal).
export type RecoveryStage =
  | 'soft_reminder'
  | 'hard_reminder'
  | 'field_visit'
  | 'legal_notice'
  | 'settlement_offer';
export const ALL_RECOVERY_STAGES: readonly RecoveryStage[] = [
  'soft_reminder',
  'hard_reminder',
  'field_visit',
  'legal_notice',
  'settlement_offer',
];

export type PtpStatus = 'none' | 'active' | 'kept' | 'broken';
export const ALL_PTP_STATUSES: readonly PtpStatus[] = ['none', 'active', 'kept', 'broken'];

export type ContactChannel = 'call' | 'sms' | 'email' | 'field_visit';
export const ALL_CONTACT_CHANNELS: readonly ContactChannel[] = ['call', 'sms', 'email', 'field_visit'];

export const COLLECTION_SECTORS = [
  'Manufacturing',
  'Real_Estate',
  'Retail_Trade',
  'Textiles',
  'Hospitality',
  'Logistics',
  'Agro_Processing',
  'IT_Services',
] as const;
export type CollectionSector = (typeof COLLECTION_SECTORS)[number];

export class CollectionsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CollectionsError';
  }
}

// ── Row + envelope shapes ─────────────────────────────────────────────────

export interface CollectionAccount {
  account_id: string;
  customer_id: string;
  customer_name: string;
  sector: CollectionSector;
  dpd: number;
  dpd_bucket: DpdBucket;
  outstanding_kes: number;
  overdue_kes: number;
  recovery_stage: RecoveryStage;
  recovery_probability: number; // 0..1
  expected_recovery_kes: number; // overdue × recovery_probability
  ptp_status: PtpStatus;
  ptp_amount_kes: number | null;
  ptp_date: string | null; // YYYY-MM-DD
  assigned_collector: string;
  last_contact_at: string | null; // ISO
  contact_attempts_30d: number;
}

export interface PtpEntry {
  recorded_at: string;
  recorded_by: string;
  amount_kes: number;
  promised_date: string; // YYYY-MM-DD
  status: PtpStatus;
  notes: string | null;
}

export interface ContactEntry {
  contacted_at: string;
  contacted_by: string;
  channel: ContactChannel;
  outcome: string;
  notes: string | null;
}

export interface CollectionsSummary {
  tenant_id: string;
  generated_at: string;
  total_accounts: number;
  total_overdue_kes: number;
  total_expected_recovery_kes: number;
  recovery_rate_pct: number; // expected_recovery / overdue × 100
  by_dpd_bucket: Record<DpdBucket, { count: number; overdue_kes: number }>;
  by_stage: Record<RecoveryStage, number>;
  ptp_active_count: number;
  ptp_kept_rate_pct: number; // kept / (kept + broken) × 100; 0 when none resolved
  high_risk_count: number; // dpd_90_plus + recovery_probability < 0.3
}

export interface CollectionsQueue {
  tenant_id: string;
  generated_at: string;
  total: number;
  filters_applied: {
    dpd_bucket: DpdBucket | null;
    stage: RecoveryStage | null;
    ptp_status: PtpStatus | null;
    collector: string | null;
  };
  accounts: CollectionAccount[];
}

export interface CollectionAccountDetail extends CollectionAccount {
  ptp_history: PtpEntry[];
  contact_history: ContactEntry[];
  recovery_factors: { factor: string; weight: number; direction: 'positive' | 'negative' }[];
}

// ── Synthesis ──────────────────────────────────────────────────────────────

function tenantScale(t: string): number {
  return t === 'BIL' ? 0.6 : 1.0;
}

function dpdBucketFor(dpd: number): DpdBucket {
  if (dpd >= 91) return 'dpd_90_plus';
  if (dpd >= 61) return 'dpd_61_90';
  if (dpd >= 31) return 'dpd_31_60';
  return 'dpd_1_30';
}

// Recovery probability falls as DPD rises; jittered but deterministic.
function recoveryProbabilityFor(dpd: number, rng: () => number): number {
  const base =
    dpd >= 91 ? 0.18 : dpd >= 61 ? 0.38 : dpd >= 31 ? 0.58 : 0.78;
  const p = base + (rng() - 0.5) * 0.2;
  return Math.round(Math.min(0.95, Math.max(0.02, p)) * 100) / 100;
}

// Stage escalates with DPD (mostly) — soft for fresh, legal for deep arrears.
function stageFor(dpd: number, rng: () => number): RecoveryStage {
  if (dpd >= 91) return rng() < 0.5 ? 'legal_notice' : 'settlement_offer';
  if (dpd >= 61) return rng() < 0.5 ? 'field_visit' : 'legal_notice';
  if (dpd >= 31) return rng() < 0.5 ? 'hard_reminder' : 'field_visit';
  return rng() < 0.6 ? 'soft_reminder' : 'hard_reminder';
}

const FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya', 'Sunil', 'Deepa'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Bose'];
const COLLECTORS = ['ravi.collector', 'sara.recovery', 'amit.field', 'nina.legal', 'collection_officer'];

const ACCOUNT_COUNT = 42;

function buildAccount(tenant_id: string, idx: number, now: Date): CollectionAccount {
  const day = now.toISOString().slice(0, 10);
  const rng = mulberry32(fnv1a(`${tenant_id}|coll|${idx}|${day}`));
  const scale = tenantScale(tenant_id);

  // Skew DPD toward the lower buckets but keep a meaningful 90+ tail.
  const roll = rng();
  const dpd =
    roll < 0.4
      ? 1 + Math.floor(rng() * 30)
      : roll < 0.65
        ? 31 + Math.floor(rng() * 30)
        : roll < 0.82
          ? 61 + Math.floor(rng() * 30)
          : 91 + Math.floor(rng() * 270);

  const outstanding = Math.round((2_000_000 + rng() * 80_000_000) * scale);
  // Overdue is a fraction of outstanding that grows with DPD.
  const overdueFrac = Math.min(1, 0.15 + (dpd / 360) * 0.7 + rng() * 0.1);
  const overdue = Math.round(outstanding * overdueFrac);
  const recovery_probability = recoveryProbabilityFor(dpd, rng);
  const stage = stageFor(dpd, rng);

  const fname = FIRST[Math.floor(rng() * FIRST.length)];
  const lname = LAST[Math.floor(rng() * LAST.length)];
  const sector = COLLECTION_SECTORS[Math.floor(rng() * COLLECTION_SECTORS.length)];
  const collector = COLLECTORS[Math.floor(rng() * COLLECTORS.length)];

  // PTP: ~35% of accounts carry an active/resolved promise.
  const ptpRoll = rng();
  let ptp_status: PtpStatus = 'none';
  let ptp_amount_kes: number | null = null;
  let ptp_date: string | null = null;
  if (ptpRoll < 0.2) {
    ptp_status = 'active';
  } else if (ptpRoll < 0.3) {
    ptp_status = 'kept';
  } else if (ptpRoll < 0.38) {
    ptp_status = 'broken';
  }
  if (ptp_status !== 'none') {
    ptp_amount_kes = Math.round(overdue * (0.3 + rng() * 0.5));
    const pd = new Date(now);
    pd.setUTCDate(pd.getUTCDate() + (ptp_status === 'active' ? 1 + Math.floor(rng() * 20) : -(1 + Math.floor(rng() * 20))));
    ptp_date = pd.toISOString().slice(0, 10);
  }

  // Last contact 0-14 days ago; attempts 0-9 in last 30d.
  const contactAttempts = Math.floor(rng() * 10);
  let last_contact_at: string | null = null;
  if (contactAttempts > 0) {
    const lc = new Date(now);
    lc.setUTCDate(lc.getUTCDate() - Math.floor(rng() * 14));
    last_contact_at = lc.toISOString();
  }

  return {
    account_id: `acc-${tenant_id === 'BIL' ? 'bil' : 'bd'}-${String(700000 + idx)}`,
    customer_id: `c-${String(200000 + idx)}`,
    customer_name: `${fname} ${lname}`,
    sector,
    dpd,
    dpd_bucket: dpdBucketFor(dpd),
    outstanding_kes: outstanding,
    overdue_kes: overdue,
    recovery_stage: stage,
    recovery_probability,
    expected_recovery_kes: Math.round(overdue * recovery_probability),
    ptp_status,
    ptp_amount_kes,
    ptp_date,
    assigned_collector: collector,
    last_contact_at,
    contact_attempts_30d: contactAttempts,
  };
}

function allAccounts(tenant_id: string, now: Date): CollectionAccount[] {
  const out: CollectionAccount[] = [];
  for (let i = 0; i < ACCOUNT_COUNT; i++) out.push(buildAccount(tenant_id, i, now));
  return out;
}

// ── Mutation overlay (PTP + contact log) ────────────────────────────────────

const ptpOverlay = new Map<string, PtpEntry[]>(); // key = `${tenant}|${account_id}`
const contactOverlay = new Map<string, ContactEntry[]>();

function key(tenant_id: string, account_id: string): string {
  return `${tenant_id}|${account_id}`;
}

// ── Public builders ─────────────────────────────────────────────────────────

export function buildCollectionsSummary(tenant_id: string, now: Date): CollectionsSummary {
  if (!tenant_id) throw new CollectionsError('invalid_input', 'tenant_id required');
  const accounts = allAccounts(tenant_id, now);

  const by_dpd_bucket: Record<DpdBucket, { count: number; overdue_kes: number }> = {
    dpd_1_30: { count: 0, overdue_kes: 0 },
    dpd_31_60: { count: 0, overdue_kes: 0 },
    dpd_61_90: { count: 0, overdue_kes: 0 },
    dpd_90_plus: { count: 0, overdue_kes: 0 },
  };
  const by_stage: Record<RecoveryStage, number> = {
    soft_reminder: 0,
    hard_reminder: 0,
    field_visit: 0,
    legal_notice: 0,
    settlement_offer: 0,
  };

  let total_overdue = 0;
  let total_expected = 0;
  let ptp_active = 0;
  let ptp_kept = 0;
  let ptp_broken = 0;
  let high_risk = 0;

  for (const a of accounts) {
    by_dpd_bucket[a.dpd_bucket].count++;
    by_dpd_bucket[a.dpd_bucket].overdue_kes += a.overdue_kes;
    by_stage[a.recovery_stage]++;
    total_overdue += a.overdue_kes;
    total_expected += a.expected_recovery_kes;
    if (a.ptp_status === 'active') ptp_active++;
    if (a.ptp_status === 'kept') ptp_kept++;
    if (a.ptp_status === 'broken') ptp_broken++;
    if (a.dpd_bucket === 'dpd_90_plus' && a.recovery_probability < 0.3) high_risk++;
  }

  const resolved = ptp_kept + ptp_broken;
  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_accounts: accounts.length,
    total_overdue_kes: total_overdue,
    total_expected_recovery_kes: total_expected,
    recovery_rate_pct: total_overdue > 0 ? Math.round((total_expected / total_overdue) * 1000) / 10 : 0,
    by_dpd_bucket,
    by_stage,
    ptp_active_count: ptp_active,
    ptp_kept_rate_pct: resolved > 0 ? Math.round((ptp_kept / resolved) * 1000) / 10 : 0,
    high_risk_count: high_risk,
  };
}

export interface CollectionsQueueFilters {
  dpd_bucket?: DpdBucket;
  stage?: RecoveryStage;
  ptp_status?: PtpStatus;
  collector?: string;
}

export function buildCollectionsQueue(
  tenant_id: string,
  filters: CollectionsQueueFilters,
  now: Date,
): CollectionsQueue {
  if (!tenant_id) throw new CollectionsError('invalid_input', 'tenant_id required');
  if (filters.dpd_bucket && !ALL_DPD_BUCKETS.includes(filters.dpd_bucket))
    throw new CollectionsError('invalid_dpd_bucket', `unknown dpd_bucket ${filters.dpd_bucket}`);
  if (filters.stage && !ALL_RECOVERY_STAGES.includes(filters.stage))
    throw new CollectionsError('invalid_stage', `unknown stage ${filters.stage}`);
  if (filters.ptp_status && !ALL_PTP_STATUSES.includes(filters.ptp_status))
    throw new CollectionsError('invalid_ptp_status', `unknown ptp_status ${filters.ptp_status}`);

  let accounts = allAccounts(tenant_id, now);
  if (filters.dpd_bucket) accounts = accounts.filter((a) => a.dpd_bucket === filters.dpd_bucket);
  if (filters.stage) accounts = accounts.filter((a) => a.recovery_stage === filters.stage);
  if (filters.ptp_status) accounts = accounts.filter((a) => a.ptp_status === filters.ptp_status);
  if (filters.collector) accounts = accounts.filter((a) => a.assigned_collector === filters.collector);

  // Recovery priority — highest exposure-at-risk first.
  // exposure_at_risk = overdue × (1 - recovery_probability): bigger overdue
  // with lower recovery chance floats to the top of the desk.
  const priority = (a: CollectionAccount) => a.overdue_kes * (1 - a.recovery_probability);
  accounts.sort((a, b) => priority(b) - priority(a) || b.dpd - a.dpd || a.account_id.localeCompare(b.account_id));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total: accounts.length,
    filters_applied: {
      dpd_bucket: filters.dpd_bucket ?? null,
      stage: filters.stage ?? null,
      ptp_status: filters.ptp_status ?? null,
      collector: filters.collector ?? null,
    },
    accounts,
  };
}

export function buildCollectionAccountDetail(
  tenant_id: string,
  account_id: string,
  now: Date,
): CollectionAccountDetail {
  if (!tenant_id) throw new CollectionsError('invalid_input', 'tenant_id required');
  if (!account_id) throw new CollectionsError('invalid_input', 'account_id required');

  const accounts = allAccounts(tenant_id, now);
  const base = accounts.find((a) => a.account_id === account_id);
  if (!base) throw new CollectionsError('unknown_account', `unknown account ${account_id}`);

  // Seed history deterministically, then prepend any overlay mutations
  // (newest-first).
  const rng = mulberry32(fnv1a(`${tenant_id}|${account_id}|hist`));
  const seededContacts: ContactEntry[] = [];
  const nContacts = base.contact_attempts_30d;
  for (let i = 0; i < nContacts; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - (i * 3 + Math.floor(rng() * 3)));
    const ch = ALL_CONTACT_CHANNELS[Math.floor(rng() * ALL_CONTACT_CHANNELS.length)];
    const outcomes = ['no_answer', 'promised_payment', 'disputed', 'reachable_followup', 'wrong_number'];
    seededContacts.push({
      contacted_at: d.toISOString(),
      contacted_by: base.assigned_collector,
      channel: ch,
      outcome: outcomes[Math.floor(rng() * outcomes.length)],
      notes: null,
    });
  }

  const seededPtp: PtpEntry[] = [];
  if (base.ptp_status !== 'none' && base.ptp_amount_kes != null && base.ptp_date != null) {
    const rd = new Date(now);
    rd.setUTCDate(rd.getUTCDate() - (3 + Math.floor(rng() * 10)));
    seededPtp.push({
      recorded_at: rd.toISOString(),
      recorded_by: base.assigned_collector,
      amount_kes: base.ptp_amount_kes,
      promised_date: base.ptp_date,
      status: base.ptp_status,
      notes: null,
    });
  }

  const overlayPtp = ptpOverlay.get(key(tenant_id, account_id)) ?? [];
  const overlayContacts = contactOverlay.get(key(tenant_id, account_id)) ?? [];

  const ptp_history = [...overlayPtp, ...seededPtp].sort(
    (a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
  );
  const contact_history = [...overlayContacts, ...seededContacts].sort(
    (a, b) => new Date(b.contacted_at).getTime() - new Date(a.contacted_at).getTime(),
  );

  // Recovery-probability factor breakdown (explainability placeholder — the
  // production model swaps real SHAP-style attribution here).
  const recovery_factors: CollectionAccountDetail['recovery_factors'] = [
    {
      factor: `DPD ${base.dpd} days (${base.dpd_bucket.replace(/_/g, ' ')})`,
      weight: Math.round((base.dpd / 360) * 100) / 100,
      direction: 'negative',
    },
    {
      factor: base.ptp_status === 'kept' ? 'PTP kept previously' : base.ptp_status === 'broken' ? 'PTP broken' : 'No active PTP',
      weight: base.ptp_status === 'kept' ? 0.35 : base.ptp_status === 'broken' ? 0.4 : 0.1,
      direction: base.ptp_status === 'kept' ? 'positive' : 'negative',
    },
    {
      factor: `${base.contact_attempts_30d} contact attempts (30d)`,
      weight: Math.min(0.3, base.contact_attempts_30d * 0.04),
      direction: base.contact_attempts_30d >= 3 ? 'positive' : 'negative',
    },
    {
      factor: `Sector: ${base.sector.replace(/_/g, ' ')}`,
      weight: 0.15,
      direction: base.sector === 'Real_Estate' || base.sector === 'Hospitality' ? 'negative' : 'positive',
    },
  ];

  return { ...base, ptp_history, contact_history, recovery_factors };
}

export interface RecordPtpInput {
  amount_kes: number;
  promised_date: string; // YYYY-MM-DD
  notes?: string;
  recorded_by: string;
}

export function recordPtp(
  tenant_id: string,
  account_id: string,
  input: RecordPtpInput,
  now: Date,
): PtpEntry {
  if (!tenant_id) throw new CollectionsError('invalid_input', 'tenant_id required');
  // Validate the account exists in the synthesised book.
  const exists = allAccounts(tenant_id, now).some((a) => a.account_id === account_id);
  if (!exists) throw new CollectionsError('unknown_account', `unknown account ${account_id}`);
  if (!Number.isFinite(input.amount_kes) || input.amount_kes <= 0)
    throw new CollectionsError('invalid_amount', 'amount_kes must be a positive number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.promised_date))
    throw new CollectionsError('invalid_date', 'promised_date must be YYYY-MM-DD');
  if (!input.recorded_by) throw new CollectionsError('invalid_input', 'recorded_by required');
  if (input.notes != null && input.notes.length > 2000)
    throw new CollectionsError('invalid_input', 'notes too long (max 2000)');

  const entry: PtpEntry = {
    recorded_at: now.toISOString(),
    recorded_by: input.recorded_by,
    amount_kes: Math.round(input.amount_kes),
    promised_date: input.promised_date,
    status: 'active',
    notes: input.notes?.trim() || null,
  };
  const k = key(tenant_id, account_id);
  if (!ptpOverlay.has(k)) ptpOverlay.set(k, []);
  ptpOverlay.get(k)!.unshift(entry);
  return entry;
}

export interface LogContactInput {
  channel: ContactChannel;
  outcome: string;
  notes?: string;
  contacted_by: string;
}

export function logContact(
  tenant_id: string,
  account_id: string,
  input: LogContactInput,
  now: Date,
): ContactEntry {
  if (!tenant_id) throw new CollectionsError('invalid_input', 'tenant_id required');
  const exists = allAccounts(tenant_id, now).some((a) => a.account_id === account_id);
  if (!exists) throw new CollectionsError('unknown_account', `unknown account ${account_id}`);
  if (!ALL_CONTACT_CHANNELS.includes(input.channel))
    throw new CollectionsError('invalid_channel', `unknown channel ${input.channel}`);
  if (!input.outcome || input.outcome.trim().length === 0)
    throw new CollectionsError('invalid_input', 'outcome required');
  if (!input.contacted_by) throw new CollectionsError('invalid_input', 'contacted_by required');
  if (input.notes != null && input.notes.length > 2000)
    throw new CollectionsError('invalid_input', 'notes too long (max 2000)');

  const entry: ContactEntry = {
    contacted_at: now.toISOString(),
    contacted_by: input.contacted_by,
    channel: input.channel,
    outcome: input.outcome.trim(),
    notes: input.notes?.trim() || null,
  };
  const k = key(tenant_id, account_id);
  if (!contactOverlay.has(k)) contactOverlay.set(k, []);
  contactOverlay.get(k)!.unshift(entry);
  return entry;
}

export function _resetCollectionsOverlay() {
  ptpOverlay.clear();
  contactOverlay.clear();
}
