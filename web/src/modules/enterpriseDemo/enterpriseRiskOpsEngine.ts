/**
 * Enterprise Demo Foundation — Risk Ops Engine (alerts + cases overlay).
 *
 * Pure, deterministic synthesis layer over a virtual 2000-alert / 800-case
 * fleet. Indian banking + insurance flavour. No I/O.
 */

// ---------- local time helper -------------------------------------------------

/** Return the current wall-clock Date (single sanctioned no-arg Date use). */
function currentTime(): Date {
  return new Date();
}

// ---------- deterministic RNG (FNV-1a + Mulberry32) --------------------------

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(tenant_id: string, asOf: Date, ...axes: string[]): () => number {
  const day = asOf.toISOString().slice(0, 10);
  return mulberry32(fnv1a([tenant_id, day, ...axes].join('|')));
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function pickWeighted<T extends string>(rng: () => number, weights: Record<T, number>): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [k, w] of entries) {
    roll -= w;
    if (roll <= 0) return k;
  }
  return entries[0][0];
}

function intInRange(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---------- reference catalogs -----------------------------------------------

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Reyansh', 'Mohammed', 'Ayaan',
  'Krishna', 'Ishaan', 'Saanvi', 'Aanya', 'Aaradhya', 'Pari', 'Diya',
] as const;

const LAST_NAMES = [
  'Sharma', 'Patel', 'Kumar', 'Singh', 'Gupta', 'Mehta', 'Shah', 'Khan',
  'Reddy', 'Iyer', 'Verma', 'Rao', 'Joshi', 'Nair', 'Menon',
] as const;

const TEAMS_BANKING = [
  'risk-ops-mumbai', 'risk-ops-bengaluru', 'fraud-cell-delhi', 'collections-pune', 'credit-review-chennai',
] as const;

const TEAMS_INSURANCE = [
  'claims-investigation-mumbai', 'underwriting-review-pune', 'persistency-cell-hyderabad', 'fraud-cell-bengaluru',
] as const;

const TRIGGER_SOURCES_BANKING = [
  'rule-engine', 'ml-pd-model', 'fraud-model', 'sma-monitor', 'sector-watch',
] as const;

const TRIGGER_SOURCES_INSURANCE = [
  'rule-engine', 'claims-anomaly-model', 'persistency-monitor', 'uw-deviation-check',
] as const;

const BANKING_TAGS = [
  'priority', 'large-exposure', 'msme', 'retail', 'corporate', 'restructured', 'watch-list',
] as const;

const INSURANCE_TAGS = [
  'high-sum-assured', 'health', 'motor', 'life', 'agent-cluster', 'repeat-claimant', 'early-claim',
] as const;

// ---------- closed enums ------------------------------------------------------

export const BANKING_ALERT_KINDS = [
  'sma_breach', 'npa_risk', 'fraud_signal', 'collections_risk', 'sector_risk',
] as const;
export type BankingAlertKind = typeof BANKING_ALERT_KINDS[number];

export const INSURANCE_ALERT_KINDS = [
  'policy_lapse_risk', 'claims_anomaly', 'fraud_detection', 'underwriting_deviation', 'persistency_breach',
] as const;
export type InsuranceAlertKind = typeof INSURANCE_ALERT_KINDS[number];

export const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AlertSeverity = typeof ALERT_SEVERITIES[number];

export const CASE_STATUSES = ['open', 'in_progress', 'escalated', 'closed'] as const;
export type CaseStatus = typeof CASE_STATUSES[number];

export const BANKING_CASE_TYPES = ['credit_risk', 'fraud_investigation', 'collections_review'] as const;
export type BankingCaseType = typeof BANKING_CASE_TYPES[number];

export const INSURANCE_CASE_TYPES = ['claim_fraud', 'policy_review', 'underwriting_investigation'] as const;
export type InsuranceCaseType = typeof INSURANCE_CASE_TYPES[number];

export const ESCALATION_STATUSES = [
  'none', 'sla_warning', 'sla_breached', 'escalated_l1', 'escalated_l2', 'escalated_exec',
] as const;
export type EscalationStatus = typeof ESCALATION_STATUSES[number];

const ALERT_STATUSES = ['open', 'acknowledged', 'in_investigation', 'closed'] as const;
type AlertStatus = typeof ALERT_STATUSES[number];

const CLOSURE_REASONS = [
  'fraud_confirmed', 'risk_remediated', 'false_positive', 'no_action_needed',
] as const;
type ClosureReason = typeof CLOSURE_REASONS[number];

// ---------- interfaces --------------------------------------------------------

export interface EnterpriseAlert {
  alert_id: string;
  tenant_id: string;
  domain: 'banking' | 'insurance';
  kind: BankingAlertKind | InsuranceAlertKind;
  subject_id: string;
  subject_kind: 'loan' | 'policy' | 'claim' | 'customer';
  severity: AlertSeverity;
  risk_score: number;
  trigger_source: string;
  raised_at: string;
  owner_username: string;
  assigned_team: string;
  escalation_status: EscalationStatus;
  status: AlertStatus;
  sla_due_at: string;
  tags: string[];
  description: string;
}

export interface EnterpriseCase {
  case_id: string;
  tenant_id: string;
  alert_id: string;
  domain: 'banking' | 'insurance';
  case_type: BankingCaseType | InsuranceCaseType;
  subject_id: string;
  subject_kind: 'loan' | 'policy' | 'claim' | 'customer';
  status: CaseStatus;
  severity: AlertSeverity;
  opened_at: string;
  closed_at_or_null: string | null;
  assigned_investigator: string;
  closure_reason_or_null: ClosureReason | null;
  total_evidence_count: number;
}

export interface CaseTimelineEvent {
  event_id: string;
  case_id: string;
  ts: string;
  kind: 'opened' | 'assigned' | 'note_added' | 'evidence_added' | 'escalated' | 'state_change' | 'closed';
  actor: string;
  description: string;
}

export interface InvestigatorNote {
  note_id: string;
  case_id: string;
  ts: string;
  author: string;
  body: string;
  visibility: 'internal' | 'shared';
}

export interface EvidenceRecord {
  evidence_id: string;
  case_id: string;
  kind: 'document' | 'transaction_log' | 'comms' | 'image' | 'system_record';
  uri: string;
  collected_by: string;
  collected_at: string;
  description: string;
}

export interface AlertFilter {
  domain?: 'banking' | 'insurance';
  severity?: AlertSeverity;
  status?: AlertStatus;
  escalation_status?: EscalationStatus;
  kind?: string;
}

export interface CaseFilter {
  domain?: 'banking' | 'insurance';
  status?: CaseStatus;
  severity?: AlertSeverity;
  case_type?: string;
}

// ---------- virtual fleet sizing ---------------------------------------------

const TOTAL_ALERTS = 2000;
const TOTAL_BANKING_ALERTS = 1200;
const TOTAL_CASES = 800;

const SEVERITY_WEIGHTS: Record<AlertSeverity, number> = {
  low: 30,
  medium: 40,
  high: 20,
  critical: 10,
};

const ALERT_STATUS_WEIGHTS: Record<AlertStatus, number> = {
  open: 35,
  acknowledged: 20,
  in_investigation: 25,
  closed: 20,
};

const ESCALATION_WEIGHTS: Record<EscalationStatus, number> = {
  none: 55,
  sla_warning: 15,
  sla_breached: 10,
  escalated_l1: 10,
  escalated_l2: 7,
  escalated_exec: 3,
};

const CASE_STATUS_WEIGHTS: Record<CaseStatus, number> = {
  open: 30,
  in_progress: 35,
  escalated: 15,
  closed: 20,
};

// ---------- alert synthesis ---------------------------------------------------

function synthName(rng: () => number): string {
  return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
}

function synthUsername(rng: () => number): string {
  const first = pick(rng, FIRST_NAMES).toLowerCase();
  const last = pick(rng, LAST_NAMES).toLowerCase();
  return `${first}.${last}`;
}

function riskScoreFor(rng: () => number, severity: AlertSeverity): number {
  const base: Record<AlertSeverity, [number, number]> = {
    low: [10, 39],
    medium: [40, 64],
    high: [65, 84],
    critical: [85, 100],
  };
  const [lo, hi] = base[severity];
  return intInRange(rng, lo, hi);
}

function synthAlertAt(tenant_id: string, asOf: Date, index: number): EnterpriseAlert {
  const rng = seedFor(tenant_id, asOf, 'alert', String(index));
  const isBanking = index <= TOTAL_BANKING_ALERTS;
  const domain: 'banking' | 'insurance' = isBanking ? 'banking' : 'insurance';
  const kind = isBanking
    ? pick(rng, BANKING_ALERT_KINDS)
    : pick(rng, INSURANCE_ALERT_KINDS);

  const severity = pickWeighted(rng, SEVERITY_WEIGHTS);
  const status = pickWeighted(rng, ALERT_STATUS_WEIGHTS);
  const escalation_status = pickWeighted(rng, ESCALATION_WEIGHTS);

  const subject_kind: EnterpriseAlert['subject_kind'] = isBanking
    ? pick(rng, ['loan', 'customer'] as const)
    : pick(rng, ['policy', 'claim', 'customer'] as const);

  const subjectPrefix = subject_kind === 'loan' ? 'LN' :
    subject_kind === 'policy' ? 'POL' :
    subject_kind === 'claim' ? 'CLM' : 'CUST';
  const subject_id = `${subjectPrefix}-${String(intInRange(rng, 100000, 999999))}`;

  const ageMinutes = intInRange(rng, 5, 60 * 24 * 14);
  const raised_at = new Date(asOf.getTime() - ageMinutes * 60_000).toISOString();

  const slaHours = severity === 'critical' ? 4 :
    severity === 'high' ? 12 :
    severity === 'medium' ? 48 : 120;
  const sla_due_at = new Date(asOf.getTime() + slaHours * 3_600_000).toISOString();

  const tagPool = isBanking ? BANKING_TAGS : INSURANCE_TAGS;
  const tagCount = intInRange(rng, 1, 3);
  const tags: string[] = [];
  for (let i = 0; i < tagCount; i++) {
    const t = pick(rng, tagPool);
    if (!tags.includes(t)) tags.push(t);
  }

  const owner_username = synthUsername(rng);
  const assigned_team = isBanking ? pick(rng, TEAMS_BANKING) : pick(rng, TEAMS_INSURANCE);
  const trigger_source = isBanking
    ? pick(rng, TRIGGER_SOURCES_BANKING)
    : pick(rng, TRIGGER_SOURCES_INSURANCE);

  const subjectName = synthName(rng);
  const description = `${kind.replace(/_/g, ' ')} on ${subject_kind} ${subject_id} (${subjectName}) — ${severity} severity`;

  return {
    alert_id: `EA-${String(index).padStart(6, '0')}`,
    tenant_id,
    domain,
    kind,
    subject_id,
    subject_kind,
    severity,
    risk_score: riskScoreFor(rng, severity),
    trigger_source,
    raised_at,
    owner_username,
    assigned_team,
    escalation_status,
    status,
    sla_due_at,
    tags,
    description,
  };
}

// ---------- case synthesis ----------------------------------------------------

function caseTypeFor(
  rng: () => number,
  domain: 'banking' | 'insurance',
  kind: string,
): BankingCaseType | InsuranceCaseType {
  if (domain === 'banking') {
    if (kind === 'fraud_signal') return 'fraud_investigation';
    if (kind === 'collections_risk') return 'collections_review';
    if (kind === 'npa_risk' || kind === 'sma_breach' || kind === 'sector_risk') return 'credit_risk';
    return pick(rng, BANKING_CASE_TYPES);
  }
  if (kind === 'fraud_detection' || kind === 'claims_anomaly') return 'claim_fraud';
  if (kind === 'underwriting_deviation') return 'underwriting_investigation';
  if (kind === 'policy_lapse_risk' || kind === 'persistency_breach') return 'policy_review';
  return pick(rng, INSURANCE_CASE_TYPES);
}

function synthCaseAt(tenant_id: string, asOf: Date, index: number): EnterpriseCase {
  // Every other alert spawns a case → case index i ↔ alert index (i*2 - 1).
  const alertIndex = Math.min(TOTAL_ALERTS, index * 2 - 1);
  const alert = synthAlertAt(tenant_id, asOf, alertIndex);

  const rng = seedFor(tenant_id, asOf, 'case', String(index));
  const status = pickWeighted(rng, CASE_STATUS_WEIGHTS);

  const openedAgeMin = intInRange(rng, 60, 60 * 24 * 21);
  const opened_at = new Date(asOf.getTime() - openedAgeMin * 60_000).toISOString();

  let closed_at_or_null: string | null = null;
  let closure_reason_or_null: ClosureReason | null = null;
  if (status === 'closed') {
    const closeAgeMin = Math.max(1, openedAgeMin - intInRange(rng, 30, openedAgeMin - 1));
    closed_at_or_null = new Date(asOf.getTime() - closeAgeMin * 60_000).toISOString();
    closure_reason_or_null = pick(rng, CLOSURE_REASONS);
  }

  const assigned_investigator = synthUsername(rng);
  const total_evidence_count = intInRange(rng, 2, 8);

  return {
    case_id: `EC-${String(index).padStart(6, '0')}`,
    tenant_id,
    alert_id: alert.alert_id,
    domain: alert.domain,
    case_type: caseTypeFor(rng, alert.domain, alert.kind),
    subject_id: alert.subject_id,
    subject_kind: alert.subject_kind,
    status,
    severity: alert.severity,
    opened_at,
    closed_at_or_null,
    assigned_investigator,
    closure_reason_or_null,
    total_evidence_count,
  };
}

function parseCaseIndex(case_id: string): number | null {
  const m = /^EC-(\d{6})$/.exec(case_id);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > TOTAL_CASES) return null;
  return n;
}

function parseAlertIndex(alert_id: string): number | null {
  const m = /^EA-(\d{6})$/.exec(alert_id);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > TOTAL_ALERTS) return null;
  return n;
}

// ---------- public listing + lookup ------------------------------------------

/** List enterprise alerts, optionally filtered + paginated, in deterministic order. */
export function listEnterpriseAlerts(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: AlertFilter,
  offset = 0,
  limit = 100,
): EnterpriseAlert[] {
  const out: EnterpriseAlert[] = [];
  let scanned = 0;
  let matched = 0;
  for (let i = 1; i <= TOTAL_ALERTS && out.length < limit; i++) {
    const a = synthAlertAt(tenant_id, asOf, i);
    if (filter) {
      if (filter.domain && a.domain !== filter.domain) continue;
      if (filter.severity && a.severity !== filter.severity) continue;
      if (filter.status && a.status !== filter.status) continue;
      if (filter.escalation_status && a.escalation_status !== filter.escalation_status) continue;
      if (filter.kind && a.kind !== filter.kind) continue;
    }
    if (matched++ < offset) {
      scanned++;
      continue;
    }
    out.push(a);
    scanned++;
  }
  return out;
}

/** Fetch a single enterprise alert by id, scoped to tenant. */
export function getEnterpriseAlert(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): EnterpriseAlert | null {
  const idx = parseAlertIndex(id);
  if (idx === null) return null;
  return synthAlertAt(tenant_id, asOf, idx);
}

/** List enterprise investigation cases, optionally filtered + paginated. */
export function listEnterpriseCases(
  tenant_id: string,
  asOf: Date = currentTime(),
  filter?: CaseFilter,
  offset = 0,
  limit = 100,
): EnterpriseCase[] {
  const out: EnterpriseCase[] = [];
  let matched = 0;
  for (let i = 1; i <= TOTAL_CASES && out.length < limit; i++) {
    const c = synthCaseAt(tenant_id, asOf, i);
    if (filter) {
      if (filter.domain && c.domain !== filter.domain) continue;
      if (filter.status && c.status !== filter.status) continue;
      if (filter.severity && c.severity !== filter.severity) continue;
      if (filter.case_type && c.case_type !== filter.case_type) continue;
    }
    if (matched++ < offset) continue;
    out.push(c);
  }
  return out;
}

/** Fetch a single enterprise case by id, scoped to tenant. */
export function getEnterpriseCase(
  id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): EnterpriseCase | null {
  const idx = parseCaseIndex(id);
  if (idx === null) return null;
  return synthCaseAt(tenant_id, asOf, idx);
}

// ---------- timeline / notes / evidence --------------------------------------

function timelineEventCountFor(status: CaseStatus, rng: () => number): number {
  const base: Record<CaseStatus, [number, number]> = {
    open: [5, 7],
    in_progress: [7, 11],
    escalated: [9, 13],
    closed: [10, 15],
  };
  const [lo, hi] = base[status];
  return intInRange(rng, lo, hi);
}

/** List the deterministic timeline for a case (5-15 events). */
export function listCaseTimeline(
  case_id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): CaseTimelineEvent[] {
  const idx = parseCaseIndex(case_id);
  if (idx === null) return [];
  const c = synthCaseAt(tenant_id, asOf, idx);
  const rng = seedFor(tenant_id, asOf, 'timeline', case_id);
  const count = timelineEventCountFor(c.status, rng);

  const openedAtMs = new Date(c.opened_at).getTime();
  const endMs = c.closed_at_or_null ? new Date(c.closed_at_or_null).getTime() : asOf.getTime();
  const span = Math.max(60_000, endMs - openedAtMs);

  const out: CaseTimelineEvent[] = [];
  for (let i = 0; i < count; i++) {
    let kind: CaseTimelineEvent['kind'];
    if (i === 0) kind = 'opened';
    else if (i === 1) kind = 'assigned';
    else if (i === count - 1 && c.status === 'closed') kind = 'closed';
    else {
      kind = pick(rng, [
        'note_added', 'evidence_added', 'state_change', 'escalated', 'note_added',
      ] as const);
    }
    const ratio = count === 1 ? 0 : i / (count - 1);
    const ts = new Date(openedAtMs + ratio * span).toISOString();
    out.push({
      event_id: `ETE-${idx.toString().padStart(6, '0')}-${String(i + 1).padStart(2, '0')}`,
      case_id,
      ts,
      kind,
      actor: kind === 'opened' ? 'system' : synthUsername(rng),
      description: `${kind.replace(/_/g, ' ')} on case ${case_id}`,
    });
  }
  return out;
}

/** List investigator notes for a case (2-6 notes). */
export function listInvestigatorNotes(
  case_id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): InvestigatorNote[] {
  const idx = parseCaseIndex(case_id);
  if (idx === null) return [];
  const c = synthCaseAt(tenant_id, asOf, idx);
  const rng = seedFor(tenant_id, asOf, 'notes', case_id);
  const count = intInRange(rng, 2, 6);
  const openedAtMs = new Date(c.opened_at).getTime();
  const endMs = c.closed_at_or_null ? new Date(c.closed_at_or_null).getTime() : asOf.getTime();
  const span = Math.max(60_000, endMs - openedAtMs);

  const snippets = [
    'Reviewed transaction trail; pattern consistent with prior incidents.',
    'Contacted branch manager for additional KYC documents.',
    'Cross-checked with bureau report — no new red flags.',
    'Customer responded to outreach; explanation under review.',
    'Escalating to L2 supervisor for sign-off.',
    'Closing pending evidence upload from field team.',
  ];

  const out: InvestigatorNote[] = [];
  for (let i = 0; i < count; i++) {
    const ratio = count === 1 ? 0 : i / (count - 1);
    const ts = new Date(openedAtMs + ratio * span).toISOString();
    out.push({
      note_id: `EN-${idx.toString().padStart(6, '0')}-${String(i + 1).padStart(2, '0')}`,
      case_id,
      ts,
      author: synthUsername(rng),
      body: pick(rng, snippets),
      visibility: rng() < 0.75 ? 'internal' : 'shared',
    });
  }
  return out;
}

/** List evidence records collected on a case (2-8 items). */
export function listEvidence(
  case_id: string,
  tenant_id: string,
  asOf: Date = currentTime(),
): EvidenceRecord[] {
  const idx = parseCaseIndex(case_id);
  if (idx === null) return [];
  const c = synthCaseAt(tenant_id, asOf, idx);
  const rng = seedFor(tenant_id, asOf, 'evidence', case_id);
  const count = c.total_evidence_count;
  const openedAtMs = new Date(c.opened_at).getTime();
  const endMs = c.closed_at_or_null ? new Date(c.closed_at_or_null).getTime() : asOf.getTime();
  const span = Math.max(60_000, endMs - openedAtMs);
  const kinds: EvidenceRecord['kind'][] = [
    'document', 'transaction_log', 'comms', 'image', 'system_record',
  ];

  const out: EvidenceRecord[] = [];
  for (let i = 0; i < count; i++) {
    const ratio = count === 1 ? 0 : i / (count - 1);
    const ts = new Date(openedAtMs + ratio * span).toISOString();
    const kind = pick(rng, kinds);
    out.push({
      evidence_id: `EV-${idx.toString().padStart(6, '0')}-${String(i + 1).padStart(2, '0')}`,
      case_id,
      kind,
      uri: `evidence://${tenant_id.toLowerCase()}/${case_id}/${kind}-${i + 1}`,
      collected_by: synthUsername(rng),
      collected_at: ts,
      description: `${kind.replace(/_/g, ' ')} captured for ${case_id}`,
    });
  }
  return out;
}

// ---------- summaries ---------------------------------------------------------

function emptySeverityRecord(): Record<AlertSeverity, number> {
  return { low: 0, medium: 0, high: 0, critical: 0 };
}

function emptyAlertStatusRecord(): Record<AlertStatus, number> {
  return { open: 0, acknowledged: 0, in_investigation: 0, closed: 0 };
}

function emptyEscalationRecord(): Record<EscalationStatus, number> {
  return {
    none: 0,
    sla_warning: 0,
    sla_breached: 0,
    escalated_l1: 0,
    escalated_l2: 0,
    escalated_exec: 0,
  };
}

function emptyCaseStatusRecord(): Record<CaseStatus, number> {
  return { open: 0, in_progress: 0, escalated: 0, closed: 0 };
}

function emptyClosureRecord(): Record<ClosureReason | 'unresolved', number> {
  return {
    fraud_confirmed: 0,
    risk_remediated: 0,
    false_positive: 0,
    no_action_needed: 0,
    unresolved: 0,
  };
}

/** Roll up alert ops counts across the virtual 2000-alert fleet. */
export function summarizeAlertOps(
  tenant_id: string,
  asOf: Date = currentTime(),
): {
  total_alerts: number;
  by_domain: Record<'banking' | 'insurance', number>;
  by_severity: Record<AlertSeverity, number>;
  by_status: Record<AlertStatus, number>;
  by_escalation_status: Record<EscalationStatus, number>;
  top_kinds: { kind: string; count: number }[];
  open_count: number;
  critical_open_count: number;
} {
  const by_domain: Record<'banking' | 'insurance', number> = { banking: 0, insurance: 0 };
  const by_severity = emptySeverityRecord();
  const by_status = emptyAlertStatusRecord();
  const by_escalation_status = emptyEscalationRecord();
  const kindCounts = new Map<string, number>();
  let open_count = 0;
  let critical_open_count = 0;

  for (let i = 1; i <= TOTAL_ALERTS; i++) {
    const a = synthAlertAt(tenant_id, asOf, i);
    by_domain[a.domain] += 1;
    by_severity[a.severity] += 1;
    by_status[a.status] += 1;
    by_escalation_status[a.escalation_status] += 1;
    kindCounts.set(a.kind, (kindCounts.get(a.kind) ?? 0) + 1);
    if (a.status !== 'closed') {
      open_count += 1;
      if (a.severity === 'critical') critical_open_count += 1;
    }
  }

  const top_kinds = Array.from(kindCounts.entries())
    .map(([kind, count]) => ({ kind, count }))
    .sort((x, y) => (y.count - x.count) || x.kind.localeCompare(y.kind))
    .slice(0, 10);

  return {
    total_alerts: TOTAL_ALERTS,
    by_domain,
    by_severity,
    by_status,
    by_escalation_status,
    top_kinds,
    open_count,
    critical_open_count,
  };
}

/** Roll up investigation ops counts across the virtual 800-case fleet. */
export function summarizeInvestigationOps(
  tenant_id: string,
  asOf: Date = currentTime(),
): {
  total_cases: number;
  by_status: Record<CaseStatus, number>;
  by_domain: Record<'banking' | 'insurance', number>;
  by_case_type: Record<string, number>;
  open_count: number;
  in_progress_count: number;
  escalated_count: number;
  closed_count: number;
  closure_breakdown: Record<ClosureReason | 'unresolved', number>;
  total_evidence: number;
  mean_age_open_days: number;
} {
  const by_status = emptyCaseStatusRecord();
  const by_domain: Record<'banking' | 'insurance', number> = { banking: 0, insurance: 0 };
  const by_case_type: Record<string, number> = {};
  const closure_breakdown = emptyClosureRecord();
  let total_evidence = 0;
  let openAgeSumMs = 0;
  let openConsidered = 0;
  const nowMs = asOf.getTime();

  for (let i = 1; i <= TOTAL_CASES; i++) {
    const c = synthCaseAt(tenant_id, asOf, i);
    by_status[c.status] += 1;
    by_domain[c.domain] += 1;
    by_case_type[c.case_type] = (by_case_type[c.case_type] ?? 0) + 1;
    total_evidence += c.total_evidence_count;
    if (c.status === 'closed' && c.closure_reason_or_null) {
      closure_breakdown[c.closure_reason_or_null] += 1;
    } else if (c.status !== 'closed') {
      closure_breakdown.unresolved += 1;
      openAgeSumMs += Math.max(0, nowMs - new Date(c.opened_at).getTime());
      openConsidered += 1;
    }
  }

  const mean_age_open_days = openConsidered === 0
    ? 0
    : Math.round((openAgeSumMs / openConsidered) / 86_400_000 * 10) / 10;

  return {
    total_cases: TOTAL_CASES,
    by_status,
    by_domain,
    by_case_type,
    open_count: by_status.open,
    in_progress_count: by_status.in_progress,
    escalated_count: by_status.escalated,
    closed_count: by_status.closed,
    closure_breakdown,
    total_evidence,
    mean_age_open_days,
  };
}
