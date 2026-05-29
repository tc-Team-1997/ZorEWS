// services/bff/src/banking_borrower_timeline.ts
//
// Borrower Timeline (§2.1.9) — a per-borrower chronological RISK-event stream.
//
// 1 endpoint backs the Borrower Timeline screen:
//   GET /v1/banking/borrowers/:customer_id/timeline?event_type=&since=&limit=
//
// Distinct from the CMS case timelines (CaseActivityTimeline / M9.6
// reconstructCaseTimeline) which track a single CASE's state transitions.
// This is the borrower's whole RISK JOURNEY across products — DPD changes,
// SMA reclassifications, rule firings, alerts, ratio breaches, repayments,
// restructurings, bureau updates, case open/close — assembled into one
// chronological view for the credit-risk analyst.
//
// The timeline is TOTAL over customers: any non-empty customer_id yields a
// deterministic populated journey (FNV-1a + Mulberry32 per (tenant, customer))
// — matching the M9.6 "timeline is total over the entity" convention and the
// drill-through pattern (the analyst always arrives with a real borrower id).

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

export type TimelineEventType =
  | 'account_opened'
  | 'repayment'
  | 'dpd_change'
  | 'sma_reclassification'
  | 'rule_fired'
  | 'alert_raised'
  | 'ratio_breach'
  | 'bureau_update'
  | 'limit_change'
  | 'restructuring'
  | 'case_opened'
  | 'case_closed';

export const ALL_TIMELINE_EVENT_TYPES: readonly TimelineEventType[] = [
  'account_opened',
  'repayment',
  'dpd_change',
  'sma_reclassification',
  'rule_fired',
  'alert_raised',
  'ratio_breach',
  'bureau_update',
  'limit_change',
  'restructuring',
  'case_opened',
  'case_closed',
];

export type TimelineSeverity = 'info' | 'warning' | 'critical';
export const ALL_TIMELINE_SEVERITIES: readonly TimelineSeverity[] = ['info', 'warning', 'critical'];

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';
export type Trajectory = 'improving' | 'stable' | 'deteriorating';

export interface TimelineEvent {
  event_id: string;
  occurred_at: string; // ISO
  event_type: TimelineEventType;
  severity: TimelineSeverity;
  title: string;
  description: string;
  linked_ref: string | null; // alert_id / case_id / rule_id when applicable
  metadata: Record<string, string | number>;
}

export interface BorrowerTimeline {
  tenant_id: string;
  customer_id: string;
  customer_name: string;
  generated_at: string;
  current_risk_band: RiskBand;
  trajectory: Trajectory;
  peak_dpd: number;
  total_events: number;
  returned_count: number;
  by_type: Record<TimelineEventType, number>;
  by_severity: Record<TimelineSeverity, number>;
  first_event_at: string | null;
  last_event_at: string | null;
  filters_applied: { event_type: TimelineEventType | null; since: string | null; limit: number };
  events: TimelineEvent[]; // newest-first (already filtered)
}

export class BorrowerTimelineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BorrowerTimelineError';
  }
}

const FIRST = ['Alice', 'Rajesh', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya', 'Sunil', 'Deepa'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Bose'];
const RULES = ['DPD-cliff-30d', 'EMI-bounce-3-in-30', 'Cash-velocity-spike', 'Stock-statement-overdue', 'Utilisation>95%'];
const RATIOS = ['Current ratio', 'DSCR', 'Interest coverage', 'Leverage'];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DAY_MS = 86_400_000;

function bandForDpd(dpd: number): RiskBand {
  if (dpd >= 90) return 'critical';
  if (dpd >= 60) return 'high';
  if (dpd >= 30) return 'medium';
  return 'low';
}

// Build the borrower's full coherent risk journey (chronological, oldest-first
// internally; the public builder returns newest-first).
function buildFullJourney(tenant_id: string, customer_id: string, now: Date): TimelineEvent[] {
  const rng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|timeline`));
  const events: TimelineEvent[] = [];
  let seq = 0;
  const mk = (
    daysAgo: number,
    event_type: TimelineEventType,
    severity: TimelineSeverity,
    title: string,
    description: string,
    metadata: Record<string, string | number> = {},
    linked_ref: string | null = null,
  ) => {
    const occurred = new Date(now.getTime() - daysAgo * DAY_MS);
    events.push({
      event_id: `tl-${customer_id}-${String(seq).padStart(3, '0')}`,
      occurred_at: occurred.toISOString(),
      event_type,
      severity,
      title,
      description,
      linked_ref,
      metadata,
    });
    seq++;
  };

  // Journey spans ~18 months. Older → newer (we'll sort at the end anyway).
  const span = 540;

  // 1) Account opened at the start.
  mk(span, 'account_opened', 'info', 'Account opened', 'Working-capital facility sanctioned.', {
    facility_kes: Math.round((5_000_000 + rng() * 40_000_000)),
  });

  // 2) Monthly repayments — mostly on-time early, drifting late later.
  let dpd = 0;
  for (let m = 17; m >= 0; m--) {
    const daysAgo = m * 30 + Math.floor(rng() * 6);
    // Deterioration ramps in over the last ~8 months.
    const stress = m <= 8 ? (8 - m) / 8 : 0; // 0 → 1 as we approach now
    const late = rng() < 0.15 + stress * 0.5;
    if (late) {
      dpd = Math.min(180, dpd + Math.round(10 + stress * 40 + rng() * 20));
      mk(
        daysAgo,
        'repayment',
        dpd >= 60 ? 'critical' : 'warning',
        `Repayment delayed (${dpd} DPD)`,
        `EMI received late; days-past-due now ${dpd}.`,
        { dpd, amount_kes: Math.round(200_000 + rng() * 2_000_000) },
      );
    } else {
      dpd = Math.max(0, dpd - Math.round(rng() * 15));
      mk(daysAgo, 'repayment', 'info', 'Repayment on time', 'EMI received on schedule.', {
        dpd,
        amount_kes: Math.round(200_000 + rng() * 2_000_000),
      });
    }

    // Quarterly bureau refresh.
    if (m % 3 === 0) {
      const score = Math.round(820 - stress * 260 + (rng() - 0.5) * 40);
      mk(daysAgo + 1, 'bureau_update', 'info', 'Bureau score refreshed', `New bureau score ${score}.`, {
        bureau_score: score,
      });
    }
  }

  // 3) Peak-DPD event + SMA reclassification once DPD crosses thresholds.
  const peak = dpd;
  if (peak >= 30) {
    mk(60, 'dpd_change', peak >= 90 ? 'critical' : 'warning', `DPD crossed ${peak >= 90 ? 90 : 30}`, `Days-past-due reached ${peak}.`, { dpd: peak });
    const stage = peak >= 90 ? 'SMA-2' : peak >= 60 ? 'SMA-1' : 'SMA-0';
    mk(58, 'sma_reclassification', 'warning', `Reclassified ${stage}`, `Account moved to ${stage} per RBI norms.`, { sma_stage: stage, dpd: peak });
  }

  // 4) A ratio breach + rule firing + alert as stress builds.
  if (peak >= 30) {
    const ratio = RATIOS[Math.floor(rng() * RATIOS.length)];
    mk(72, 'ratio_breach', 'warning', `${ratio} breach`, `${ratio} fell below covenant threshold.`, { ratio });
    const rule = RULES[Math.floor(rng() * RULES.length)];
    mk(45, 'rule_fired', peak >= 90 ? 'critical' : 'warning', `Rule fired: ${rule}`, `Indicator rule ${rule} triggered.`, { rule }, `R-${100 + Math.floor(rng() * 5)}`);
    mk(40, 'alert_raised', peak >= 90 ? 'critical' : 'warning', 'EWS alert raised', 'Early-warning alert generated for review.', { severity_in: peak >= 90 ? 'CRITICAL' : 'HIGH' }, `a-${Math.floor(700000 + rng() * 9999)}`);
  }

  // 5) Limit change (precautionary cut) + maybe a restructuring/case for deep arrears.
  if (peak >= 60) {
    mk(30, 'limit_change', 'warning', 'Credit limit reduced', 'Sanctioned limit cut precautionarily.', { delta_pct: -(10 + Math.floor(rng() * 30)) });
  }
  if (peak >= 90) {
    mk(22, 'restructuring', 'warning', 'Restructuring proposed', 'Workout / restructuring under negotiation.', {});
    mk(14, 'case_opened', 'critical', 'Recovery case opened', 'Collections case opened for active recovery.', {}, `case-${Math.floor(600000 + rng() * 9999)}`);
    if (rng() < 0.3) {
      mk(3, 'case_closed', 'info', 'Case resolved (cured)', 'Borrower regularised; case closed.', { outcome: 'cured' });
    }
  }

  return events;
}

export interface TimelineFilters {
  event_type?: TimelineEventType;
  since?: string; // ISO; events strictly >= since
  limit?: number;
}

function deriveTrajectory(events: TimelineEvent[], now: Date): Trajectory {
  // Look at the net severity weight of the last 90 days vs the prior 90.
  const recentCut = now.getTime() - 90 * DAY_MS;
  const priorCut = now.getTime() - 180 * DAY_MS;
  const weight: Record<TimelineSeverity, number> = { info: -1, warning: 2, critical: 4 };
  let recent = 0;
  let prior = 0;
  for (const e of events) {
    const t = new Date(e.occurred_at).getTime();
    if (t >= recentCut) recent += weight[e.severity];
    else if (t >= priorCut) prior += weight[e.severity];
  }
  if (recent > prior + 2) return 'deteriorating';
  if (recent < prior - 2) return 'improving';
  return 'stable';
}

export function buildBorrowerTimeline(
  tenant_id: string,
  customer_id: string,
  filters: TimelineFilters,
  now: Date,
): BorrowerTimeline {
  if (!tenant_id) throw new BorrowerTimelineError('invalid_input', 'tenant_id required');
  if (!customer_id) throw new BorrowerTimelineError('invalid_input', 'customer_id required');
  if (filters.event_type && !ALL_TIMELINE_EVENT_TYPES.includes(filters.event_type))
    throw new BorrowerTimelineError('invalid_event_type', `unknown event_type ${filters.event_type}`);
  let sinceMs: number | null = null;
  if (filters.since) {
    const t = new Date(filters.since).getTime();
    if (!Number.isFinite(t)) throw new BorrowerTimelineError('invalid_since', `invalid since ${filters.since}`);
    sinceMs = t;
  }
  const limit =
    filters.limit == null
      ? DEFAULT_LIMIT
      : Math.max(1, Math.min(MAX_LIMIT, Math.floor(filters.limit)));

  const rng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|name`));
  const customer_name = `${FIRST[Math.floor(rng() * FIRST.length)]} ${LAST[Math.floor(rng() * LAST.length)]}`;

  const full = buildFullJourney(tenant_id, customer_id, now);
  // newest-first
  full.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

  // Full-timeline rollups (unfiltered — the analyst sees the complete picture).
  const by_type = Object.fromEntries(ALL_TIMELINE_EVENT_TYPES.map((t) => [t, 0])) as Record<TimelineEventType, number>;
  const by_severity: Record<TimelineSeverity, number> = { info: 0, warning: 0, critical: 0 };
  let peak_dpd = 0;
  for (const e of full) {
    by_type[e.event_type]++;
    by_severity[e.severity]++;
    const d = e.metadata.dpd;
    if (typeof d === 'number' && d > peak_dpd) peak_dpd = d;
  }

  // current_risk_band from the most-recent dpd-bearing event (else low).
  let current_risk_band: RiskBand = 'low';
  for (const e of full) {
    const d = e.metadata.dpd;
    if (typeof d === 'number') {
      current_risk_band = bandForDpd(d);
      break;
    }
  }

  // Filtered, capped events for the rendered list.
  let view = full;
  if (filters.event_type) view = view.filter((e) => e.event_type === filters.event_type);
  if (sinceMs != null) view = view.filter((e) => new Date(e.occurred_at).getTime() >= sinceMs!);
  const events = view.slice(0, limit);

  return {
    tenant_id,
    customer_id,
    customer_name,
    generated_at: now.toISOString(),
    current_risk_band,
    trajectory: deriveTrajectory(full, now),
    peak_dpd,
    total_events: full.length,
    returned_count: events.length,
    by_type,
    by_severity,
    first_event_at: full.length ? full[full.length - 1].occurred_at : null,
    last_event_at: full.length ? full[0].occurred_at : null,
    filters_applied: {
      event_type: filters.event_type ?? null,
      since: filters.since ?? null,
      limit,
    },
    events,
  };
}
