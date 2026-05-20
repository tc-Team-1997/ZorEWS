// services/bff/src/fraud/fraud_dashboard.ts
//
// PHASE C.3 — Fraud Monitoring dashboard (PDF §12 Fraud Monitoring item 4).
//
// Pure composer endpoint that surfaces fraud-relevant signals from:
//   - T2.11 fraud-family indicators (FRD-001..004)
//   - RULE-031..033 fraud-suspicion seed rules
//   - AlertEntry stream filtered to fraud-tagged alerts
//   - Investigation cohort filtered to fraud_confirmed / partial_fraud
//     decisions (M9.12)
//
// Architecture (per execution rules):
//   - Pure function — no I/O state in the composer itself.
//   - Additive — no changes to T2.11 indicators, rules engine,
//     alerts, or investigations runtime.
//   - RBAC: audit:read admin-only.

/** Compact alert sample for the dashboard "recent fraud alerts" tile. */
export interface FraudAlertSample {
  alert_id: string;
  customer_id: string;
  rule_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  created_at: string;
  indicator_id: string | null;
}

/** Compact investigation sample for the "active fraud investigations" tile. */
export interface FraudInvestigationSample {
  investigation_id: string;
  case_id: string;
  status: string;
  decision: string | null;
  opened_at: string;
  age_hours: number;
}

/** Outcome breakdown bucket. */
export interface FraudOutcomeBucket {
  fraud_confirmed: number;
  partial_fraud: number;
  fraud_unsubstantiated: number;
  data_quality: number;
  unresolved: number;
}

/** Required input shape from the caller (route handler queries the
 *  underlying stores and assembles these slices). Keeps the composer
 *  pure + cheap to test. */
export interface FraudDashboardInput {
  tenant_id: string;
  /** Counters across the 4 fraud indicator IDs (FRD-001..004) over
   *  the lookback window. */
  fraud_indicator_signals: Array<{
    indicator_id: string;
    name: string;
    fires_24h: number;
    fires_7d: number;
  }>;
  /** Recent fraud-tagged alerts (newest-first). */
  fraud_alerts: FraudAlertSample[];
  /** Active investigations with decision in {fraud_confirmed,
   *  partial_fraud, fraud_unsubstantiated, data_quality} OR still open. */
  fraud_investigations: FraudInvestigationSample[];
  /** Fraud-suspicion seed rules (RULE-031..033) — pre-resolved. */
  active_fraud_rule_ids: string[];
}

export interface FraudDashboardRollup {
  tenant_id: string;
  generated_at: string;
  /** Per-indicator fires in the trailing windows. */
  indicator_signals: Array<{
    indicator_id: string;
    name: string;
    fires_24h: number;
    fires_7d: number;
  }>;
  /** Recent alerts capped at FRAUD_ALERT_SAMPLE_CAP. */
  recent_alerts: FraudAlertSample[];
  /** Active fraud rules count + ids (for "ops can see what's gating fraud"). */
  active_fraud_rules: {
    count: number;
    rule_ids: string[];
  };
  /** Investigation roll-up by decision. */
  outcome_breakdown: FraudOutcomeBucket;
  /** Top investigations by age (oldest unresolved first). */
  oldest_open_investigations: FraudInvestigationSample[];
  /** Aggregate counts. */
  totals: {
    fraud_alerts_24h: number;
    fraud_alerts_7d: number;
    open_investigations: number;
    confirmed_fraud_count: number;
  };
  /** Attention indicator. */
  attention: {
    needs_action: boolean;
    reasons: string[];
  };
}

export const FRAUD_ALERT_SAMPLE_CAP = 10;
export const FRAUD_OPEN_INVESTIGATION_CAP = 10;

/** Canonical fraud-suspicion seed rule IDs (T2.11 RULE-031..033 +
 *  any future fraud rules following the RULE-NNN-FRAUD pattern). Used
 *  by filterFraudAlerts to tag alerts as fraud-related when their
 *  rule_id matches. Production ops can extend via configuration but
 *  the seed defaults match the shipped EWS rule catalog. */
export const FRAUD_SEED_RULE_IDS: ReadonlyArray<string> = [
  'RULE-031',
  'RULE-032',
  'RULE-033',
];

/** Canonical fraud indicator IDs (T2.11 family). Used to render the
 *  indicator-signals tile when the dashboard has no per-indicator
 *  fire-count data wired (placeholder fires_24h/_7d=0). */
export const FRAUD_INDICATOR_CATALOG: ReadonlyArray<{ indicator_id: string; name: string }> = [
  { indicator_id: 'FRD-001', name: 'Sudden withdrawal spike' },
  { indicator_id: 'FRD-002', name: 'Salary credit disappeared' },
  { indicator_id: 'FRD-003', name: 'Channel anomaly score' },
  { indicator_id: 'FRD-004', name: 'Geo anomaly distance (km)' },
];

/** Count alerts touched by each fraud indicator across the lookback
 *  window. Pure helper used by the route layer. */
export function countFraudIndicatorSignals(
  alerts: ReadonlyArray<{
    raised_at?: string;
    created_at?: string;
    indicators_fired?: string[];
  }>,
  now: Date,
): Array<{ indicator_id: string; name: string; fires_24h: number; fires_7d: number }> {
  const horizon24h = now.getTime() - 24 * 3_600_000;
  const horizon7d = now.getTime() - 7 * 24 * 3_600_000;
  return FRAUD_INDICATOR_CATALOG.map(({ indicator_id, name }) => {
    let fires_24h = 0;
    let fires_7d = 0;
    for (const a of alerts) {
      if (!(a.indicators_fired ?? []).includes(indicator_id)) continue;
      const ts = Date.parse(a.created_at ?? a.raised_at ?? '');
      if (!Number.isFinite(ts)) continue;
      if (ts >= horizon24h) fires_24h++;
      if (ts >= horizon7d) fires_7d++;
    }
    return { indicator_id, name, fires_24h, fires_7d };
  });
}

/** Pure composer. Caller pre-fetches the slices it needs (the route
 *  layer is responsible for the actual store queries). */
export function buildFraudDashboard(
  input: FraudDashboardInput,
  now: Date,
): FraudDashboardRollup {
  if (!input || typeof input !== 'object') {
    throw new Error('input required');
  }
  if (typeof input.tenant_id !== 'string' || input.tenant_id.length === 0) {
    throw new Error('tenant_id required');
  }

  // Indicator signals — preserve order from input (caller decides).
  const indicator_signals = input.fraud_indicator_signals
    ? input.fraud_indicator_signals.map((s) => ({ ...s }))
    : [];

  // Recent alerts — newest-first sort + cap.
  const recent_alerts = (input.fraud_alerts ?? [])
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      if (tb !== ta) return tb - ta;
      return a.alert_id.localeCompare(b.alert_id);
    })
    .slice(0, FRAUD_ALERT_SAMPLE_CAP);

  // Time-windowed alert counts.
  const horizon24h = now.getTime() - 24 * 3_600_000;
  const horizon7d = now.getTime() - 7 * 24 * 3_600_000;
  let fraud_alerts_24h = 0;
  let fraud_alerts_7d = 0;
  for (const a of input.fraud_alerts ?? []) {
    const t = Date.parse(a.created_at);
    if (!Number.isFinite(t)) continue;
    if (t >= horizon24h) fraud_alerts_24h++;
    if (t >= horizon7d) fraud_alerts_7d++;
  }

  // Outcome breakdown — count by decision (null decision = unresolved).
  const outcome_breakdown: FraudOutcomeBucket = {
    fraud_confirmed: 0,
    partial_fraud: 0,
    fraud_unsubstantiated: 0,
    data_quality: 0,
    unresolved: 0,
  };
  let openCount = 0;
  for (const inv of input.fraud_investigations ?? []) {
    if (inv.status !== 'closed') openCount++;
    if (inv.decision === 'fraud_confirmed') outcome_breakdown.fraud_confirmed++;
    else if (inv.decision === 'partial_fraud') outcome_breakdown.partial_fraud++;
    else if (inv.decision === 'fraud_unsubstantiated') outcome_breakdown.fraud_unsubstantiated++;
    else if (inv.decision === 'data_quality') outcome_breakdown.data_quality++;
    else outcome_breakdown.unresolved++;
  }

  // Oldest open investigations sorted by opened_at asc (oldest first).
  const oldest_open_investigations = (input.fraud_investigations ?? [])
    .filter((i) => i.status !== 'closed')
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.opened_at);
      const tb = Date.parse(b.opened_at);
      if (ta !== tb) return ta - tb;
      return a.investigation_id.localeCompare(b.investigation_id);
    })
    .slice(0, FRAUD_OPEN_INVESTIGATION_CAP);

  const totals = {
    fraud_alerts_24h,
    fraud_alerts_7d,
    open_investigations: openCount,
    confirmed_fraud_count: outcome_breakdown.fraud_confirmed,
  };

  // Attention rollup.
  const reasons: string[] = [];
  if (fraud_alerts_24h > 0) {
    reasons.push(`${fraud_alerts_24h} fraud alert(s) in last 24h`);
  }
  if (outcome_breakdown.fraud_confirmed > 0) {
    reasons.push(
      `${outcome_breakdown.fraud_confirmed} confirmed-fraud investigation(s) — review for downstream action`,
    );
  }
  // Active rules ZERO is an operational red flag (fraud monitoring disabled).
  const activeRuleIds = (input.active_fraud_rule_ids ?? []).slice();
  if (activeRuleIds.length === 0) {
    reasons.push('No active fraud-suspicion rules deployed — fraud monitoring is OFF');
  }
  const attention = {
    needs_action: reasons.length > 0,
    reasons,
  };

  return {
    tenant_id: input.tenant_id,
    generated_at: now.toISOString(),
    indicator_signals,
    recent_alerts,
    active_fraud_rules: {
      count: activeRuleIds.length,
      rule_ids: activeRuleIds,
    },
    outcome_breakdown,
    oldest_open_investigations,
    totals,
    attention,
  };
}

// ─── Helpers to feed the composer from route-layer data ───────────────

/** Filter alert events to fraud-tagged ones. Pure helper.
 *  An alert is considered fraud-tagged when its indicators_fired array
 *  contains any FRD-NNN id, OR when its rule_id is in the
 *  fraud_rule_ids set.
 *
 *  Input shape matches the canonical alert (raised_at + uppercase
 *  severity per the wire schema); output is normalised to the
 *  dashboard's FraudAlertSample shape (created_at + lowercase
 *  severity). */
export function filterFraudAlerts(
  alerts: ReadonlyArray<{
    alert_id: string;
    customer_id: string;
    rule_id: string;
    severity: string;
    raised_at?: string;
    created_at?: string;
    indicators_fired?: string[];
  }>,
  fraud_rule_ids: ReadonlyArray<string>,
): FraudAlertSample[] {
  const ruleSet = new Set(fraud_rule_ids);
  const out: FraudAlertSample[] = [];
  for (const a of alerts) {
    const hasFrdIndicator = (a.indicators_fired ?? []).some((id) => id.startsWith('FRD-'));
    const ruleMatch = ruleSet.has(a.rule_id);
    if (!hasFrdIndicator && !ruleMatch) continue;
    const sev = String(a.severity ?? '').toLowerCase();
    if (sev !== 'critical' && sev !== 'high' && sev !== 'medium' && sev !== 'low') {
      continue;
    }
    const primaryIndicator =
      (a.indicators_fired ?? []).find((id) => id.startsWith('FRD-')) ?? null;
    out.push({
      alert_id: a.alert_id,
      customer_id: a.customer_id,
      rule_id: a.rule_id,
      severity: sev as 'critical' | 'high' | 'medium' | 'low',
      created_at: a.created_at ?? a.raised_at ?? new Date(0).toISOString(),
      indicator_id: primaryIndicator,
    });
  }
  return out;
}

/** Project a generic investigation list to the FraudInvestigationSample
 *  shape used by the composer. Pure helper. */
export function projectFraudInvestigations(
  investigations: ReadonlyArray<{
    investigation_id: string;
    case_id: string;
    status: string;
    decision: string | null;
    opened_at: string;
  }>,
  now: Date,
): FraudInvestigationSample[] {
  return investigations
    .filter((i) => {
      // Include either: still-open investigations (any status != closed),
      // or closed investigations whose decision is one of the 4 we
      // surface in the breakdown.
      if (i.status !== 'closed') return true;
      return (
        i.decision === 'fraud_confirmed' ||
        i.decision === 'partial_fraud' ||
        i.decision === 'fraud_unsubstantiated' ||
        i.decision === 'data_quality'
      );
    })
    .map((i) => {
      const opened = Date.parse(i.opened_at);
      const ageHours = Number.isFinite(opened)
        ? Math.round(((now.getTime() - opened) / 3_600_000) * 10) / 10
        : 0;
      return {
        investigation_id: i.investigation_id,
        case_id: i.case_id,
        status: i.status,
        decision: i.decision,
        opened_at: i.opened_at,
        age_hours: ageHours,
      };
    });
}
