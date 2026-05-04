// services/regulatory-svc/alerts/src/alert.ts
//
// Build the canonical alert envelope from a rule firing + (optional) score.
//
// Idempotency: the same (firing_id | rule+customer+indicators+severity) input
// must yield the same alert_id, so re-deliveries don't create duplicate cases.
// We derive alert_id as a deterministic UUIDv5-ish hash over a content key.

import { createHash } from 'node:crypto';
import { mergeSeverity, toWireSeverity } from './severity';
import type {
  CanonicalAlert,
  RuleFiring,
  ScoreResponse,
  Severity,
} from './types';

/**
 * Deterministic UUID-ish from arbitrary content. We don't pull a uuidv5
 * dependency — sha256 + RFC-4122 v5-style formatting is enough for an
 * idempotency key and is still globally unique across firings.
 */
export function deterministicAlertId(contentKey: string): string {
  const h = createHash('sha256').update(contentKey).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    // version 5 nibble
    '5' + h.slice(13, 16),
    // variant nibble (RFC 4122)
    ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Stable content key for idempotency. */
export function contentKeyFor(firing: RuleFiring, finalSeverity: Severity): string {
  const indicators = [...firing.indicators_fired].sort().join(',');
  return [
    'apex.alert.v2',
    firing.firing_id,
    firing.rule_id,
    String(firing.rule_version),
    firing.customer_id,
    finalSeverity,
    indicators,
  ].join('|');
}

/** Compose a one-line human-readable summary used by SMS / email subject. */
export function reasonSummary(
  firing: RuleFiring,
  finalSeverity: Severity,
  pd: number | null,
): string {
  const head = firing.reason ?? `Rule ${firing.rule_id} fired`;
  const indicators = firing.indicators_fired.length
    ? ` (${firing.indicators_fired.join(', ')})`
    : '';
  const pdPart = pd !== null ? ` PD ${(pd * 100).toFixed(1)}%.` : '';
  return `[${finalSeverity.toUpperCase()}] ${head}${indicators} for customer ${firing.customer_id}.${pdPart}`.trim();
}

export interface BuildAlertInput {
  firing: RuleFiring;
  score: ScoreResponse | null;
  /** Override the timestamp (tests). Defaults to now. */
  now?: () => Date;
}

/**
 * Build the canonical alert. This is the **pure** core of the producer:
 * no IO, no Kafka, no validation — caller wraps with AJV + producer.
 */
export function buildAlert({ firing, score, now }: BuildAlertInput): CanonicalAlert {
  const finalSeverity = mergeSeverity(firing.rule_severity, score?.level ?? null);
  const wireSeverity = toWireSeverity(finalSeverity);

  const ts = (now ? now() : new Date()).toISOString();
  const matchedAt = firing.ts ?? ts;

  const alertId = deterministicAlertId(contentKeyFor(firing, finalSeverity));
  const pd = score?.pd ?? null;
  const summary = reasonSummary(firing, finalSeverity, pd);

  // shap_top has a stricter shape (numeric value only) under v1 scoring{} —
  // coerce: if value isn't a number, drop it from the v1-shape projection
  // but keep the full top_reasons in the v2 add-on.
  const shapTop = (score?.top_reasons ?? [])
    .filter((r) => typeof r.value === 'number')
    .map((r) => ({ feature: r.feature, value: r.value as number }));

  return {
    alert_id: alertId,
    raised_at: ts,
    ts,
    customer_id: firing.customer_id,
    loan_id: firing.loan_id ?? null,
    severity: wireSeverity,
    rule_id: firing.rule_id,
    indicators_fired: [...firing.indicators_fired].sort(),
    pd,
    risk_level: score?.level ?? null,
    top_reasons: score?.top_reasons ?? [],
    reason_summary: summary,
    rule_firings: [
      {
        rule_id: firing.rule_id,
        rule_version: firing.rule_version,
        matched_at: matchedAt,
        // indicator_value_ids would come from agent-indicator's value-store;
        // until then we leave it empty — v2 schema makes it optional.
        indicator_value_ids: [],
      },
    ],
    scoring: {
      pd: pd,
      risk_band:
        score?.level === 'High'
          ? 'HIGH'
          : score?.level === 'Medium'
            ? 'MEDIUM'
            : score?.level === 'Low'
              ? 'LOW'
              : null,
      shap_top: shapTop,
    },
    trace_id: firing.trace_id,
  };
}
