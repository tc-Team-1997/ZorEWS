// Investigation Engine — pure resolvers. 12th IA overlay (additive).
//
// Foundational module declaring shared closed enums, types, and deterministic
// synthesis primitives for the Investigation Center surface. Other modules in
// this family import from here. No I/O, no React, no async — production swap
// will replace resolver bodies with HTTP/pg calls but the surface contract
// stays stable.

// ----- Deterministic synthesis primitives ---------------------------------

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----- Closed enums --------------------------------------------------------

export const INVESTIGATION_STATUSES = [
  'open',
  'assigned',
  'in_review',
  'pending_approval',
  'escalated',
  'closed',
] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

export const INVESTIGATION_SEVERITIES = [
  'low',
  'moderate',
  'high',
  'severe',
  'critical',
] as const;
export type InvestigationSeverity = (typeof INVESTIGATION_SEVERITIES)[number];

export const INVESTIGATION_DOMAINS = ['banking', 'insurance'] as const;
export type InvestigationDomain = (typeof INVESTIGATION_DOMAINS)[number];

export const BANKING_INVESTIGATION_KINDS = [
  'borrower',
  'sma',
  'npa',
  'fraud',
  'collections',
  'sector_risk',
] as const;
export type BankingInvestigationKind = (typeof BANKING_INVESTIGATION_KINDS)[number];

export const INSURANCE_INVESTIGATION_KINDS = [
  'claim_fraud',
  'policy_risk',
  'underwriting',
  'agent',
  'channel',
  'solvency',
] as const;
export type InsuranceInvestigationKind = (typeof INSURANCE_INVESTIGATION_KINDS)[number];

export type InvestigationKind = BankingInvestigationKind | InsuranceInvestigationKind;

// ----- Role gating ---------------------------------------------------------

export const INVESTIGATION_ROLES = [
  'super_admin',
  'country_admin',
  'bank_admin',
  'insurance_admin',
  'risk_analyst',
  'fraud_analyst',
  'collection_manager',
  'investigator',
  'auditor',
  'cro',
  'ceo',
  'cfo',
  'coo',
  'board_member',
  'country_head',
  'admin',
  'supervisor',
  'executive',
] as const;
export type InvestigationRole = (typeof INVESTIGATION_ROLES)[number];

const INVESTIGATION_ROLE_SET: Set<string> = new Set(INVESTIGATION_ROLES);

export function canAccessInvestigationCenter(roles?: string[]): boolean {
  if (!roles || roles.length === 0) return false;
  for (const r of roles) {
    if (INVESTIGATION_ROLE_SET.has(r)) return true;
  }
  return false;
}

// ----- Investigation record ------------------------------------------------

export interface Investigation {
  investigation_id: string;
  tenant_id: string;
  case_id: string;
  alert_id: string | null;
  domain: InvestigationDomain;
  kind: InvestigationKind;
  status: InvestigationStatus;
  severity: InvestigationSeverity;
  title: string;
  summary: string;
  customer_id: string | null;
  policy_id: string | null;
  borrower_id: string | null;
  assignee_username: string | null;
  opened_at: string;
  due_at: string;
  closed_at: string | null;
  exposure_kes: number;
  fraud_indicator: boolean;
}

// ----- Workflow transitions ------------------------------------------------

export const WORKFLOW_TRANSITIONS: Record<InvestigationStatus, InvestigationStatus[]> = {
  open: ['assigned'],
  assigned: ['in_review', 'escalated', 'closed'],
  in_review: ['pending_approval', 'escalated', 'closed'],
  pending_approval: ['closed', 'escalated', 'in_review'],
  escalated: ['in_review', 'closed'],
  closed: ['assigned'],
};

export function canTransition(from: InvestigationStatus, to: InvestigationStatus): boolean {
  const allowed = WORKFLOW_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.indexOf(to) !== -1;
}

// ----- Investigation actions ----------------------------------------------

export type InvestigationAction =
  | 'assign'
  | 'reassign'
  | 'escalate'
  | 'approve'
  | 'reject'
  | 'close'
  | 'reopen';

export const INVESTIGATION_ACTIONS: readonly InvestigationAction[] = [
  'assign',
  'reassign',
  'escalate',
  'approve',
  'reject',
  'close',
  'reopen',
] as const;

// ----- Internal helpers ----------------------------------------------------

const MS_PER_DAY = 86_400_000;

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / MS_PER_DAY);
}

function pad(n: number, width: number): string {
  const s = String(n);
  if (s.length >= width) return s;
  return '0'.repeat(width - s.length) + s;
}

function toIso(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1, 2);
  const da = pad(d.getUTCDate(), 2);
  const h = pad(d.getUTCHours(), 2);
  const mi = pad(d.getUTCMinutes(), 2);
  const se = pad(d.getUTCSeconds(), 2);
  return `${y}-${mo}-${da}T${h}:${mi}-${se}Z`.replace(/-(\d{2})Z$/, ':$1Z');
}

// pickFrom helper intentionally omitted — distribution helpers cover all picks.

// Distribution helpers
function distributeStatus(index: number): InvestigationStatus {
  // ~10 open, 5 assigned, 8 in_review, 4 pending_approval, 2 escalated, 3 closed = 32 cycle
  const m = index % 32;
  if (m < 10) return 'open';
  if (m < 15) return 'assigned';
  if (m < 23) return 'in_review';
  if (m < 27) return 'pending_approval';
  if (m < 29) return 'escalated';
  return 'closed';
}

function distributeSeverity(rng: () => number): InvestigationSeverity {
  const r = rng();
  if (r < 0.25) return 'low';
  if (r < 0.5) return 'moderate';
  if (r < 0.75) return 'high';
  if (r < 0.92) return 'severe';
  return 'critical';
}

function kindLabel(kind: InvestigationKind): string {
  switch (kind) {
    case 'borrower':
      return 'Borrower watch';
    case 'sma':
      return 'SMA escalation';
    case 'npa':
      return 'NPA classification';
    case 'fraud':
      return 'Fraud signal';
    case 'collections':
      return 'Collections triage';
    case 'sector_risk':
      return 'Sector risk review';
    case 'claim_fraud':
      return 'Claim fraud review';
    case 'policy_risk':
      return 'Policy risk review';
    case 'underwriting':
      return 'Underwriting check';
    case 'agent':
      return 'Agent investigation';
    case 'channel':
      return 'Channel anomaly';
    case 'solvency':
      return 'Solvency stress';
  }
}

// ----- listInvestigations --------------------------------------------------

export interface InvestigationFilters {
  status?: InvestigationStatus;
  severity?: InvestigationSeverity;
  domain?: InvestigationDomain;
  kind?: InvestigationKind;
  sla_breached?: boolean;
}

interface SyntheticSeed {
  domain: InvestigationDomain;
  kind: InvestigationKind;
}

function buildSeedCycle(): SyntheticSeed[] {
  // banking (8): borrower×2, sma, npa, fraud×2, collections, sector_risk
  // insurance (8): claim_fraud×3, policy_risk, underwriting, agent, channel, solvency
  // 16 per cycle × 2 = 32
  const cycle: SyntheticSeed[] = [
    { domain: 'banking', kind: 'borrower' },
    { domain: 'banking', kind: 'borrower' },
    { domain: 'banking', kind: 'sma' },
    { domain: 'banking', kind: 'npa' },
    { domain: 'banking', kind: 'fraud' },
    { domain: 'banking', kind: 'fraud' },
    { domain: 'banking', kind: 'collections' },
    { domain: 'banking', kind: 'sector_risk' },
    { domain: 'insurance', kind: 'claim_fraud' },
    { domain: 'insurance', kind: 'claim_fraud' },
    { domain: 'insurance', kind: 'claim_fraud' },
    { domain: 'insurance', kind: 'policy_risk' },
    { domain: 'insurance', kind: 'underwriting' },
    { domain: 'insurance', kind: 'agent' },
    { domain: 'insurance', kind: 'channel' },
    { domain: 'insurance', kind: 'solvency' },
  ];
  return cycle.concat(cycle);
}

export function listInvestigations(
  tenant_id: string,
  asOf?: Date,
  filters?: InvestigationFilters,
): Investigation[] {
  const ref = asOf ?? new Date();
  const day = dayIndex(ref);
  const seeds = buildSeedCycle();
  const out: Investigation[] = [];

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i] as SyntheticSeed;
    const rng = mulberry32(fnv1a(`${tenant_id}|inv|${day}|${i}`));

    const status = distributeStatus(i);
    const severity = distributeSeverity(rng);
    const fraud_indicator = rng() < 0.25 || seed.kind === 'fraud' || seed.kind === 'claim_fraud';

    // exposure: 50_000 to 5_000_000; closed cases trend higher
    const baseExposure = 50_000 + Math.floor(rng() * 4_950_000);
    const exposure_kes =
      status === 'closed' ? Math.min(5_000_000, baseExposure + 500_000) : baseExposure;

    // opened_at: 0-90 days before asOf
    const daysBack = Math.floor(rng() * 90);
    const opened_at_ms = ref.getTime() - daysBack * MS_PER_DAY;
    const due_at_ms = opened_at_ms + 7 * MS_PER_DAY;
    const closed_at_ms = status === 'closed' ? opened_at_ms + 5 * MS_PER_DAY : null;

    const investigation_id = `INV-${tenant_id}-${pad(i + 1, 5)}`;
    const case_id = `CASE-${pad(i * 7 + 1000, 4)}`;
    const alert_id = rng() < 0.85 ? `ALERT-${pad(i * 13 + 2000, 4)}` : null;

    const customer_id = seed.domain === 'banking' ? `CUST-${pad(i + 100, 5)}` : `CUST-${pad(i + 200, 5)}`;
    const policy_id = seed.domain === 'insurance' ? `POL-${pad(i + 5000, 5)}` : null;
    const borrower_id = seed.domain === 'banking' ? `BRW-${pad(i + 3000, 5)}` : null;

    const assignees = ['alice.analyst', 'bob.investigator', 'carol.fraud', 'dan.collections', 'eve.audit'];
    const assignee_username =
      status === 'open' ? null : (assignees[i % assignees.length] as string);

    const label = kindLabel(seed.kind);
    const title = `${label} — ${seed.domain === 'banking' ? (borrower_id as string) : (policy_id as string)}`;
    const summary = `Auto-generated ${seed.domain} investigation for ${seed.kind} (${severity}).`;

    out.push({
      investigation_id,
      tenant_id,
      case_id,
      alert_id,
      domain: seed.domain,
      kind: seed.kind,
      status,
      severity,
      title,
      summary,
      customer_id,
      policy_id,
      borrower_id,
      assignee_username,
      opened_at: toIso(opened_at_ms),
      due_at: toIso(due_at_ms),
      closed_at: closed_at_ms === null ? null : toIso(closed_at_ms),
      exposure_kes,
      fraud_indicator,
    });
  }

  // Sort newest-opened-first (descending opened_at)
  out.sort((a, b) => (a.opened_at < b.opened_at ? 1 : a.opened_at > b.opened_at ? -1 : 0));

  // Apply filters
  let filtered = out;
  if (filters) {
    if (filters.status) filtered = filtered.filter((x) => x.status === filters.status);
    if (filters.severity) filtered = filtered.filter((x) => x.severity === filters.severity);
    if (filters.domain) filtered = filtered.filter((x) => x.domain === filters.domain);
    if (filters.kind) filtered = filtered.filter((x) => x.kind === filters.kind);
    if (typeof filters.sla_breached === 'boolean') {
      const refIso = toIso(ref.getTime());
      filtered = filtered.filter((x) => {
        const breached = x.due_at < refIso && x.status !== 'closed';
        return breached === filters.sla_breached;
      });
    }
  }

  return filtered;
}

// ----- getInvestigation ----------------------------------------------------

export function getInvestigation(
  investigation_id: string,
  tenant_id: string,
  asOf?: Date,
): Investigation | null {
  const all = listInvestigations(tenant_id, asOf);
  for (const inv of all) {
    if (inv.investigation_id === investigation_id) return inv;
  }
  return null;
}

// ----- Case Command Center -------------------------------------------------

export interface CaseCommandCenter {
  total_cases: number;
  by_status: Record<InvestigationStatus, number>;
  by_severity: Record<InvestigationSeverity, number>;
  by_domain: Record<InvestigationDomain, number>;
  open_cases: number;
  critical_cases: number;
  high_risk_cases: number;
  escalated_cases: number;
  sla_breached_cases: number;
  fraud_cases: number;
  banking_cases: number;
  insurance_cases: number;
  resolution_rate: number;
  investigation_backlog: number;
}

export function buildCaseCommandCenter(tenant_id: string, asOf?: Date): CaseCommandCenter {
  const ref = asOf ?? new Date();
  const all = listInvestigations(tenant_id, ref);
  const refIso = toIso(ref.getTime());

  const by_status: Record<InvestigationStatus, number> = {
    open: 0,
    assigned: 0,
    in_review: 0,
    pending_approval: 0,
    escalated: 0,
    closed: 0,
  };
  const by_severity: Record<InvestigationSeverity, number> = {
    low: 0,
    moderate: 0,
    high: 0,
    severe: 0,
    critical: 0,
  };
  const by_domain: Record<InvestigationDomain, number> = {
    banking: 0,
    insurance: 0,
  };

  let critical_cases = 0;
  let high_risk_cases = 0;
  let sla_breached_cases = 0;
  let fraud_cases = 0;

  for (const inv of all) {
    by_status[inv.status]++;
    by_severity[inv.severity]++;
    by_domain[inv.domain]++;

    if (inv.severity === 'critical') critical_cases++;
    if (inv.severity === 'high' || inv.severity === 'severe' || inv.severity === 'critical') {
      high_risk_cases++;
    }
    if (inv.due_at < refIso && inv.status !== 'closed') sla_breached_cases++;
    if (inv.fraud_indicator) fraud_cases++;
  }

  const total_cases = all.length;
  const open_cases = by_status.open;
  const escalated_cases = by_status.escalated;
  const closed_cases = by_status.closed;
  const banking_cases = by_domain.banking;
  const insurance_cases = by_domain.insurance;
  const investigation_backlog = by_status.open + by_status.assigned + by_status.in_review;
  const resolution_rate = total_cases === 0 ? 0 : closed_cases / total_cases;

  return {
    total_cases,
    by_status,
    by_severity,
    by_domain,
    open_cases,
    critical_cases,
    high_risk_cases,
    escalated_cases,
    sla_breached_cases,
    fraud_cases,
    banking_cases,
    insurance_cases,
    resolution_rate,
    investigation_backlog,
  };
}

// ----- applyAction ---------------------------------------------------------

function targetStatusFor(action: InvestigationAction): InvestigationStatus | null {
  switch (action) {
    case 'assign':
    case 'reassign':
      return 'assigned';
    case 'escalate':
      return 'escalated';
    case 'approve':
    case 'reject':
    case 'close':
      return 'closed';
    case 'reopen':
      return 'assigned';
  }
}

export function applyAction(
  inv: Investigation,
  action: InvestigationAction,
  actor: string,
): Investigation {
  if (action === 'reopen' && inv.status !== 'closed') {
    throw new Error('invalid_transition');
  }

  const target = targetStatusFor(action);
  if (target === null) {
    throw new Error('invalid_transition');
  }

  // Same-status no-op transitions are still allowed for assign/reassign when
  // already assigned (the workflow table forbids self-loops, so we guard
  // against the strict transition table only when from !== to).
  if (inv.status !== target) {
    if (!canTransition(inv.status, target)) {
      throw new Error('invalid_transition');
    }
  }

  const next: Investigation = {
    investigation_id: inv.investigation_id,
    tenant_id: inv.tenant_id,
    case_id: inv.case_id,
    alert_id: inv.alert_id,
    domain: inv.domain,
    kind: inv.kind,
    status: target,
    severity: inv.severity,
    title: inv.title,
    summary: inv.summary,
    customer_id: inv.customer_id,
    policy_id: inv.policy_id,
    borrower_id: inv.borrower_id,
    assignee_username: inv.assignee_username,
    opened_at: inv.opened_at,
    due_at: inv.due_at,
    closed_at: inv.closed_at,
    exposure_kes: inv.exposure_kes,
    fraud_indicator: inv.fraud_indicator,
  };

  if (action === 'assign' || action === 'reassign') {
    next.assignee_username = actor;
  }

  if (action === 'approve' || action === 'reject' || action === 'close') {
    const opened_ms = Date.parse(inv.opened_at);
    const closed_ms = Number.isFinite(opened_ms) ? opened_ms + 5 * MS_PER_DAY : opened_ms;
    next.closed_at = toIso(closed_ms);
  }

  if (action === 'reopen') {
    next.closed_at = null;
  }

  return next;
}
