// services/bff/src/reports/history.ts
//
// Synthetic alert + case history backing the reports module. Deterministic
// (Mulberry32) — same seed always produces the same history. In production
// this comes from regulatory-svc/{alerts,cases} event streams.

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type CaseOutcome = 'cured' | 'cured_temp' | 'defaulted';

export interface AlertEvent {
  alert_id: string;
  rule_id: string;
  rule_name: string;
  severity: Severity;
  customer_id: string;
  raised_at: string;
  acked_at?: string | null;
  closed_at?: string | null;
}

export interface CaseEvent {
  case_id: string;
  alert_id: string;
  customer_id: string;
  product: 'mortgage' | 'auto' | 'personal' | 'sme';
  officer_id: string;
  opened_at: string;
  closed_at?: string | null;
  outcome?: CaseOutcome | null;
}

const RULES: { rule_id: string; rule_name: string }[] = [
  { rule_id: 'r-22', rule_name: 'Salary inflow stopped 60d' },
  { rule_id: 'r-09', rule_name: 'DPD ≥ 30 + utilisation > 95%' },
  { rule_id: 'r-14', rule_name: 'Cheque return 2× in 30d' },
  { rule_id: 'r-15', rule_name: 'Net flow drop 30d > 40%' },
  { rule_id: 'r-03', rule_name: 'Bureau score drop > 50 pts' },
  { rule_id: 'r-11', rule_name: 'EMI bounce 3× in 90d' },
  { rule_id: 'r-18', rule_name: 'Withdrawal velocity z-score > 3' },
];

const OFFICERS = ['officer.alpha', 'officer.beta', 'officer.gamma', 'officer.delta', 'officer.epsilon'];
const PRODUCTS: CaseEvent['product'][] = ['mortgage', 'auto', 'personal', 'sme'];

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEV_WEIGHTS: { sev: Severity; w: number }[] = [
  { sev: 'low', w: 0.45 },
  { sev: 'medium', w: 0.30 },
  { sev: 'high', w: 0.18 },
  { sev: 'critical', w: 0.07 },
];

function pickSeverity(rnd: () => number): Severity {
  const r = rnd();
  let acc = 0;
  for (const { sev, w } of SEV_WEIGHTS) {
    acc += w;
    if (r <= acc) return sev;
  }
  return 'low';
}

const OUTCOME_WEIGHTS: { o: CaseOutcome; w: number }[] = [
  { o: 'cured', w: 0.55 },
  { o: 'cured_temp', w: 0.25 },
  { o: 'defaulted', w: 0.20 },
];

function pickOutcome(rnd: () => number): CaseOutcome {
  const r = rnd();
  let acc = 0;
  for (const { o, w } of OUTCOME_WEIGHTS) {
    acc += w;
    if (r <= acc) return o;
  }
  return 'cured';
}

interface GenerateOptions {
  /** Inclusive ISO date — alerts raised from this day forward. */
  startISO: string;
  /** Exclusive ISO date — alerts raised before this day. */
  endISO: string;
  /** Approximate alerts/day to generate. */
  alertsPerDay?: number;
  /** Fraction of alerts that become cases (0–1). */
  caseFraction?: number;
  /** Seed for the PRNG so tests are deterministic. */
  seed?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface History {
  alerts: AlertEvent[];
  cases: CaseEvent[];
}

export function generateHistory(opts: GenerateOptions): History {
  const start = new Date(opts.startISO).getTime();
  const end = new Date(opts.endISO).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`invalid date range: ${opts.startISO} → ${opts.endISO}`);
  }
  const alertsPerDay = opts.alertsPerDay ?? 6;
  const caseFraction = opts.caseFraction ?? 0.4;
  const seed = opts.seed ?? 99;
  const rnd = mulberry32(seed);

  const alerts: AlertEvent[] = [];
  const cases: CaseEvent[] = [];
  let alertCounter = 0;
  let caseCounter = 0;

  for (let t = start; t < end; t += DAY_MS) {
    const todayCount = Math.max(0, Math.round(alertsPerDay + (rnd() - 0.5) * alertsPerDay * 0.6));
    for (let i = 0; i < todayCount; i++) {
      const raisedAt = new Date(t + Math.floor(rnd() * DAY_MS));
      const rule = RULES[Math.floor(rnd() * RULES.length)];
      const severity = pickSeverity(rnd);
      const ackDelayMin = Math.round(2 + rnd() * 180);
      const ackedAt = new Date(raisedAt.getTime() + ackDelayMin * 60 * 1000);
      // 75% of alerts close inside the window; the rest stay open.
      const willClose = rnd() < 0.75;
      const closeDelayMin = Math.round(60 + rnd() * 60 * 24 * 5);
      const closedAt = willClose
        ? new Date(ackedAt.getTime() + closeDelayMin * 60 * 1000)
        : null;
      const customer_id = `c-${1000 + Math.floor(rnd() * 240)}`;
      alertCounter++;
      const alert: AlertEvent = {
        alert_id: `a-${alertCounter}`,
        rule_id: rule.rule_id,
        rule_name: rule.rule_name,
        severity,
        customer_id,
        raised_at: raisedAt.toISOString(),
        acked_at: ackedAt.toISOString(),
        closed_at: closedAt ? closedAt.toISOString() : null,
      };
      alerts.push(alert);

      if (rnd() < caseFraction) {
        const product = PRODUCTS[Math.floor(rnd() * PRODUCTS.length)];
        const officer_id = OFFICERS[Math.floor(rnd() * OFFICERS.length)];
        const caseClosed = closedAt && rnd() < 0.85;
        caseCounter++;
        cases.push({
          case_id: `case-${caseCounter}`,
          alert_id: alert.alert_id,
          customer_id,
          product,
          officer_id,
          opened_at: ackedAt.toISOString(),
          closed_at: caseClosed ? closedAt!.toISOString() : null,
          outcome: caseClosed ? pickOutcome(rnd) : null,
        });
      }
    }
  }

  return { alerts, cases };
}

/** Compute period bounds for a given anchor date (defaults to "now"). */
export function periodBounds(period: 'week' | 'month' | 'quarter', now: Date = new Date()): {
  start: Date;
  end: Date;
} {
  const end = new Date(now);
  const start = new Date(now);
  if (period === 'week') start.setUTCDate(start.getUTCDate() - 7);
  else if (period === 'month') start.setUTCMonth(start.getUTCMonth() - 1);
  else start.setUTCMonth(start.getUTCMonth() - 3);
  return { start, end };
}
