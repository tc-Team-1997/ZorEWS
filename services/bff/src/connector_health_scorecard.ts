// connector_health_scorecard.ts
//
// T6 M3.20 — Connector health scorecard.
// Composite 0-100 health score per connector based on:
//   1. Success rate (40% weight)
//   2. p95 latency vs expected (30% weight)
//   3. Data freshness (20% weight)
//   4. Schema violation rate (10% weight)
// Mirror of M14.26 (adapter SLA budget) but for ingestion connectors.

import type { ConnectorRun } from './ingestion';
import { linearPercentile } from './connector_run_analytics';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConnectorHealthTier = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export interface ConnectorHealthScore {
  connector_id:      string;
  name:              string;
  connector_type:    string;
  source_system:     string;
  score:             number;         // 0-100
  tier:              ConnectorHealthTier;
  components: {
    success_rate_score:   number;  // 0-100
    latency_score:        number;  // 0-100
    freshness_score:      number;  // 0-100
    schema_score:         number;  // 0-100
  };
  success_rate:      number | null;  // 0-1
  p95_latency_ms:    number | null;
  last_run_age_hours: number | null;
  schema_violations: number;
  run_count:         number;
  recommendations:   string[];
}

export interface ConnectorHealthScorecardEnvelope {
  tenant_id:       string;
  generated_at:    string;
  total_connectors: number;
  excellent_count: number;
  good_count:      number;
  fair_count:      number;
  poor_count:      number;
  critical_count:  number;
  fleet_avg_score: number;
  connectors:      ConnectorHealthScore[];  // sorted score asc (worst first)
  weakest_connector: { connector_id: string; name: string; score: number } | null;
  strongest_connector: { connector_id: string; name: string; score: number } | null;
}

// ─── Expected SLA per connector type ────────────────────────────────────────

const EXPECTED_P95_MS: Record<string, number> = {
  kafka_stream: 2_000,
  rest_api:     5_000,
  batch_csv:    30_000,
  soap_api:     8_000,
  sftp_drop:    60_000,
};

const EXPECTED_FRESHNESS_HOURS: Record<string, number> = {
  kafka_stream: 0.017,  // ~1 min
  rest_api:     1,
  batch_csv:    24,
  soap_api:     2,
  sftp_drop:    24,
};

// ─── Tier from score ────────────────────────────────────────────────────────

function tierFor(score: number): ConnectorHealthTier {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  if (score >= 35) return 'poor';
  return 'critical';
}

// ─── Score calculator ────────────────────────────────────────────────────────

export function scoreConnector(
  connectorId: string,
  connectorName: string,
  connectorType: string,
  sourceSystem: string,
  runs: ConnectorRun[],
  now: Date,
): ConnectorHealthScore {
  const window = runs.slice(-50);  // last 50 runs
  const total = window.length;

  // Success rate component (40%)
  const successes = window.filter(r => r.status === 'success').length;
  const successRate = total > 0 ? successes / total : null;
  const successRateScore = successRate !== null ? Math.round(successRate * 100) : 50;

  // p95 latency component (30%)
  const finishedMs = window
    .filter(r => r.status !== 'running' && r.started_at && r.finished_at)
    .map(r => new Date(r.finished_at!).getTime() - new Date(r.started_at!).getTime())
    .filter(ms => ms >= 0)
    .sort((a, b) => a - b);
  const _p95raw = finishedMs.length > 0 ? linearPercentile(finishedMs, 95) : null;
  const p95 = _p95raw !== null ? Math.round(_p95raw) : null;
  const expectedP95 = EXPECTED_P95_MS[connectorType] ?? 10_000;
  const latencyScore = p95 !== null
    ? Math.round(Math.max(0, Math.min(100, 100 - ((p95 - expectedP95) / expectedP95) * 50)))
    : 50;

  // Freshness component (20%)
  const lastRun = window.filter(r => r.status === 'success').sort((a, b) =>
    new Date(b.finished_at ?? b.started_at).getTime() - new Date(a.finished_at ?? a.started_at).getTime()
  )[0];
  const ageHours = lastRun
    ? (now.getTime() - new Date(lastRun.finished_at ?? lastRun.started_at).getTime()) / 3_600_000
    : null;
  const expectedFreshness = EXPECTED_FRESHNESS_HOURS[connectorType] ?? 24;
  const freshnessScore = ageHours !== null
    ? Math.round(Math.max(0, Math.min(100, 100 - ((ageHours - expectedFreshness) / expectedFreshness) * 50)))
    : 50;

  // Schema violations component (10%)
  const schemaViolations = window.filter(r => r.records_failed && r.records_failed > 0).length;
  const schemaScore = total > 0 ? Math.round((1 - schemaViolations / total) * 100) : 100;

  // Composite
  const score = Math.round(
    successRateScore * 0.40 +
    latencyScore     * 0.30 +
    freshnessScore   * 0.20 +
    schemaScore      * 0.10,
  );

  // Recommendations
  const recs: string[] = [];
  if (successRateScore < 60) recs.push(`Success rate ${successRate !== null ? Math.round(successRate * 100) : '?'}% — investigate recent failures`);
  if (latencyScore < 60 && p95 !== null) recs.push(`p95 latency ${p95}ms exceeds target ${expectedP95}ms — optimize connector`);
  if (freshnessScore < 50 && ageHours !== null) recs.push(`Data ${Math.round(ageHours)}h stale — expected refresh ${expectedFreshness}h`);
  if (schemaViolations > 0) recs.push(`${schemaViolations} runs with schema violations — review source schema changes`);

  return {
    connector_id:     connectorId,
    name:             connectorName,
    connector_type:   connectorType,
    source_system:    sourceSystem,
    score,
    tier:             tierFor(score),
    components: {
      success_rate_score:  successRateScore,
      latency_score:       latencyScore,
      freshness_score:     freshnessScore,
      schema_score:        schemaScore,
    },
    success_rate:         successRate,
    p95_latency_ms:       p95,
    last_run_age_hours:   ageHours !== null ? Math.round(ageHours * 100) / 100 : null,
    schema_violations:    schemaViolations,
    run_count:            total,
    recommendations:      recs,
  };
}

// ─── Fleet scorecard ────────────────────────────────────────────────────────

export function buildConnectorHealthScorecard(
  tenant_id: string,
  scores: ConnectorHealthScore[],
  now: Date,
): ConnectorHealthScorecardEnvelope {
  const sorted = [...scores].sort((a, b) => a.score - b.score);  // worst first
  const tierCount = (t: ConnectorHealthTier) => scores.filter(s => s.tier === t).length;
  const fleetAvg = scores.length > 0
    ? Math.round(scores.reduce((s, c) => s + c.score, 0) / scores.length)
    : 0;

  return {
    tenant_id,
    generated_at:        now.toISOString(),
    total_connectors:    scores.length,
    excellent_count:     tierCount('excellent'),
    good_count:          tierCount('good'),
    fair_count:          tierCount('fair'),
    poor_count:          tierCount('poor'),
    critical_count:      tierCount('critical'),
    fleet_avg_score:     fleetAvg,
    connectors:          sorted,
    weakest_connector:   sorted[0] ? { connector_id: sorted[0].connector_id, name: sorted[0].name, score: sorted[0].score } : null,
    strongest_connector: sorted[sorted.length - 1] ? { connector_id: sorted[sorted.length - 1]!.connector_id, name: sorted[sorted.length - 1]!.name, score: sorted[sorted.length - 1]!.score } : null,
  };
}
