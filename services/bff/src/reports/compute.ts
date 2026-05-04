// services/bff/src/reports/compute.ts
//
// Pure report computers. Each takes a History + portfolio snapshot and
// returns a typed Report payload. No IO, no globals — easy to unit-test.

import type { Account } from '../scenario/portfolio';
import { defaultPortfolio } from '../scenario/portfolio';
import { generateHistory, periodBounds, type History } from './history';
import type {
  AlertActivityReport,
  CaseOutcomesReport,
  PortfolioSnapshot,
  RbiSummaryReport,
  ReportPeriod,
} from './types';

// ── Helpers ───────────────────────────────────────────────────────────────

function bandFor(pd: number): 'low' | 'medium' | 'high' {
  if (pd < 0.05) return 'low';
  if (pd < 0.2) return 'medium';
  return 'high';
}

function ifrsStage(pd: number): 1 | 2 | 3 {
  if (pd < 0.08) return 1;
  if (pd < 0.25) return 2;
  return 3;
}

function inWindow(iso: string | null | undefined, start: Date, end: Date): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= start.getTime() && t < end.getTime();
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function topByCount<T>(rows: T[], key: (r: T) => string, limit: number): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ── Snapshot ──────────────────────────────────────────────────────────────

export function computeSnapshot(
  portfolio: Account[],
  history: History,
  period: ReportPeriod,
  now: Date,
): PortfolioSnapshot {
  const { start, end } = periodBounds(period, now);
  const customers_monitored = portfolio.length;
  const high_risk_customers = portfolio.filter((a) => bandFor(a.baseline_pd) === 'high').length;
  const total_exposure_kes = Math.round(portfolio.reduce((acc, a) => acc + a.ead_kes, 0));
  const expected_credit_loss_kes = Math.round(
    portfolio.reduce((acc, a) => acc + a.ead_kes * a.baseline_pd * a.lgd, 0),
  );

  const stage_counts = { stage_1: 0, stage_2: 0, stage_3: 0 };
  for (const a of portfolio) {
    if (ifrsStage(a.baseline_pd) === 1) stage_counts.stage_1++;
    else if (ifrsStage(a.baseline_pd) === 2) stage_counts.stage_2++;
    else stage_counts.stage_3++;
  }

  // Open alerts = raised in the window with no closed_at, OR raised earlier and still open at end.
  const alerts_open = history.alerts.filter(
    (a) => !a.closed_at || new Date(a.closed_at).getTime() > end.getTime(),
  ).length;
  const cases_in_progress = history.cases.filter(
    (c) => !c.closed_at || new Date(c.closed_at).getTime() > end.getTime(),
  ).length;

  return {
    type: 'snapshot',
    period,
    generated_at: now.toISOString(),
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    customers_monitored,
    high_risk_customers,
    high_risk_pct:
      customers_monitored > 0
        ? Math.round((high_risk_customers / customers_monitored) * 1000) / 10
        : 0,
    total_exposure_kes,
    alerts_open,
    cases_in_progress,
    stage_distribution: stage_counts,
    expected_credit_loss_kes,
    npa_pct:
      customers_monitored > 0
        ? Math.round((stage_counts.stage_3 / customers_monitored) * 1000) / 10
        : 0,
  };
}

// ── Alert activity ────────────────────────────────────────────────────────

export function computeAlertActivity(
  history: History,
  period: ReportPeriod,
  now: Date,
): AlertActivityReport {
  const { start, end } = periodBounds(period, now);
  const raisedInPeriod = history.alerts.filter((a) => inWindow(a.raised_at, start, end));
  const closedInPeriod = history.alerts.filter((a) => inWindow(a.closed_at, start, end));

  const raised_by_severity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const a of raisedInPeriod) raised_by_severity[a.severity]++;

  const ackMinutes: number[] = [];
  for (const a of raisedInPeriod) {
    if (a.acked_at) {
      const diff = new Date(a.acked_at).getTime() - new Date(a.raised_at).getTime();
      ackMinutes.push(Math.max(0, diff / 60000));
    }
  }

  const closeMinutes: number[] = [];
  for (const a of closedInPeriod) {
    const diff = new Date(a.closed_at!).getTime() - new Date(a.raised_at).getTime();
    closeMinutes.push(Math.max(0, diff / 60000));
  }

  const ruleCounts = topByCount(raisedInPeriod, (a) => a.rule_id, 5);
  const ruleNameById = new Map(history.alerts.map((a) => [a.rule_id, a.rule_name]));
  const top_rules = ruleCounts.map((r) => ({
    rule_id: r.key,
    rule_name: ruleNameById.get(r.key) ?? r.key,
    firings: r.count,
  }));

  const open_at_end = history.alerts.filter(
    (a) =>
      new Date(a.raised_at).getTime() < end.getTime() &&
      (!a.closed_at || new Date(a.closed_at).getTime() > end.getTime()),
  ).length;

  return {
    type: 'alerts',
    period,
    generated_at: now.toISOString(),
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    raised_by_severity,
    raised_total: raisedInPeriod.length,
    closed_total: closedInPeriod.length,
    avg_minutes_to_ack: Math.round(avg(ackMinutes) * 10) / 10,
    avg_minutes_to_close: Math.round(avg(closeMinutes) * 10) / 10,
    top_rules,
    open_at_end,
  };
}

// ── Case outcomes ─────────────────────────────────────────────────────────

export function computeCaseOutcomes(
  history: History,
  period: ReportPeriod,
  now: Date,
): CaseOutcomesReport {
  const { start, end } = periodBounds(period, now);
  const openedInPeriod = history.cases.filter((c) => inWindow(c.opened_at, start, end));
  const closedInPeriod = history.cases.filter((c) => inWindow(c.closed_at, start, end));

  const outcomes = { cured: 0, cured_temp: 0, defaulted: 0 };
  for (const c of closedInPeriod) {
    if (c.outcome) outcomes[c.outcome]++;
  }

  const days: number[] = [];
  for (const c of closedInPeriod) {
    if (c.closed_at) {
      const diff = new Date(c.closed_at).getTime() - new Date(c.opened_at).getTime();
      days.push(Math.max(0, diff / (24 * 60 * 60 * 1000)));
    }
  }

  const officerCounts = topByCount(closedInPeriod, (c) => c.officer_id, 5);
  const top_officers = officerCounts.map((o) => ({
    officer_id: o.key,
    cases_closed: o.count,
  }));

  const productCounts = topByCount(closedInPeriod, (c) => c.product, 4);
  const product_breakdown = productCounts.map((p) => ({
    product: p.key,
    cases_closed: p.count,
  }));

  return {
    type: 'cases',
    period,
    generated_at: now.toISOString(),
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    cases_opened: openedInPeriod.length,
    cases_closed: closedInPeriod.length,
    outcomes,
    avg_days_to_close: Math.round(avg(days) * 10) / 10,
    top_officers,
    product_breakdown,
  };
}

// ── RBI-style summary ─────────────────────────────────────────────────────

export function computeRbiSummary(
  portfolio: Account[],
  history: History,
  period: ReportPeriod,
  now: Date,
): RbiSummaryReport {
  const { start, end } = periodBounds(period, now);
  const total_exposure = portfolio.reduce((acc, a) => acc + a.ead_kes, 0);
  const productMap = new Map<string, number>();
  for (const a of portfolio) {
    productMap.set(a.product, (productMap.get(a.product) ?? 0) + a.ead_kes);
  }
  const sector_exposure = [...productMap.entries()]
    .map(([sector, exposure_kes]) => ({
      sector,
      exposure_kes: Math.round(exposure_kes),
      share_pct:
        total_exposure > 0 ? Math.round((exposure_kes / total_exposure) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.exposure_kes - a.exposure_kes);

  const bandCounts = { low: 0, medium: 0, high: 0 };
  for (const a of portfolio) bandCounts[bandFor(a.baseline_pd)]++;
  const totalAccounts = portfolio.length;
  const risk_band_distribution: RbiSummaryReport['risk_band_distribution'] = (
    ['low', 'medium', 'high'] as const
  ).map((band) => ({
    band,
    accounts: bandCounts[band],
    share_pct:
      totalAccounts > 0 ? Math.round((bandCounts[band] / totalAccounts) * 1000) / 10 : 0,
  }));

  const ecl = portfolio.reduce((acc, a) => acc + a.ead_kes * a.baseline_pd * a.lgd, 0);
  // Rough QoQ delta — assume previous quarter was 4% higher (synthetic).
  const ecl_qoq_delta_kes = Math.round(ecl - ecl * 1.04);

  const stage_3 = portfolio.filter((a) => ifrsStage(a.baseline_pd) === 3).length;
  const npa_pct = totalAccounts > 0 ? Math.round((stage_3 / totalAccounts) * 1000) / 10 : 0;

  const top_concentrations = [...portfolio]
    .sort((a, b) => b.ead_kes - a.ead_kes)
    .slice(0, 5)
    .map((a) => ({ customer_id: a.customer_id, name: a.name, exposure_kes: a.ead_kes }));

  return {
    type: 'rbi',
    period,
    generated_at: now.toISOString(),
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    sector_exposure,
    risk_band_distribution,
    ecl_kes: Math.round(ecl),
    ecl_qoq_delta_kes,
    npa_pct,
    top_concentrations,
  };
}

/**
 * Convenience wrapper used by the route handler. Re-uses the cached scenario
 * portfolio + a deterministic 6-month synthetic history. The history range
 * is anchored on `now` so reports always cover the trailing window.
 */
export function reportFor(
  type: 'snapshot' | 'alerts' | 'cases' | 'rbi',
  period: ReportPeriod,
  now: Date,
) {
  const portfolio = defaultPortfolio();
  const historyStart = new Date(now);
  historyStart.setUTCMonth(historyStart.getUTCMonth() - 6);
  const history = generateHistory({
    startISO: historyStart.toISOString(),
    endISO: now.toISOString(),
  });
  switch (type) {
    case 'snapshot':
      return computeSnapshot(portfolio, history, period, now);
    case 'alerts':
      return computeAlertActivity(history, period, now);
    case 'cases':
      return computeCaseOutcomes(history, period, now);
    case 'rbi':
      return computeRbiSummary(portfolio, history, period, now);
  }
}
