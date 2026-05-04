// web/src/lib/criticality.ts
//
// Pure scoring helpers for the alert queue (Task 6 — alert prioritization
// with AI). The "AI" framing in the spec refers to a learned ranking
// model that production would train on historical resolution patterns.
// For the prototype, the criticality formula below is the authoritative
// surrogate — same shape, same inputs, just hand-tuned weights instead
// of model coefficients. When a real model lands, swap computeScore()
// to invoke it; the rest of the alert pipeline stays put.
//
// Formula:
//   score = severityWeight × confidence × log10(max(exposure, 100k) / 100k) × ageBoost
//
// Component rationale:
//   - severityWeight steps from 1 (low) to 4 (critical) — the rule
//     engine already classified the underlying signal.
//   - confidence (0..1) scales the raw severity by how sure the model
//     is. A 0.5-confidence critical alert lands between a high (3) and
//     a critical (4).
//   - log10(exposure/100k) makes a 10x exposure jump add 1 unit to the
//     score. Caps the floor at 100k so single-loan retail customers
//     don't get a NEGATIVE multiplier.
//   - ageBoost biases older unresolved alerts up (1.0 → 1.2 → 1.5) so
//     they don't get permanently buried by new criticals.

import type { Alert, Severity } from './api';

const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Age-based multiplier — older alerts boost up so they don't get buried.
 * Bands chosen to match common "follow-up overdue" thresholds without
 * overweighting truly stale items (capped at 1.5x).
 */
export function ageBoost(age_min: number): number {
  if (age_min < 24 * 60) return 1.0;       // < 24h — fresh
  if (age_min < 72 * 60) return 1.2;       // 1–3 days — getting stale
  return 1.5;                                // > 3 days — needs attention now
}

/**
 * Authoritative criticality formula. Inputs are exactly the fields
 * present on the Alert wire shape after the join with customer exposure.
 * Returns a number ≥ 0; higher = more critical.
 */
export function computeScore(input: {
  severity: Severity;
  confidence: number;
  customer_exposure_kes: number;
  age_min: number;
}): number {
  const sw = SEVERITY_WEIGHT[input.severity];
  // Clamp confidence to [0, 1] so a stray value out of seed data can't
  // produce nonsense rankings.
  const conf = Math.min(1, Math.max(0, input.confidence));
  // Floor exposure at 100k KES (~$700) — below that the log goes negative.
  const expBase = Math.max(input.customer_exposure_kes, 100_000);
  const expMult = Math.log10(expBase / 100_000);
  // log10(100k/100k) = 0 — give those alerts a baseline 1.0 multiplier
  // so they aren't zeroed out entirely by a small exposure.
  const safeExpMult = expMult <= 0 ? 1 : 1 + expMult;
  const ab = ageBoost(input.age_min);
  // Round to 2 decimals so the wire shape is stable + small.
  return Math.round(sw * conf * safeExpMult * ab * 100) / 100;
}

/**
 * Score → display band, used by the UI to color the criticality badge.
 * Bands aren't symmetric: critical (>= 8) is rare, high (4–8) is the
 * working zone, medium/low cover the rest.
 */
export type ScoreBand = 'critical' | 'high' | 'medium' | 'low';

export function bandFor(score: number): ScoreBand {
  if (score >= 8) return 'critical';
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

/**
 * Group alerts by customer, keeping the highest-criticality alert per
 * customer as the "primary" and folding the rest into linked_alert_ids.
 * Stable sort: ties (e.g. two alerts with the same score) preserve
 * input order so the result is deterministic for tests.
 */
export function dedupByCustomer(alerts: Alert[]): Alert[] {
  const byCustomer = new Map<string, Alert[]>();
  for (const a of alerts) {
    const arr = byCustomer.get(a.customer.id) ?? [];
    arr.push(a);
    byCustomer.set(a.customer.id, arr);
  }
  const out: Alert[] = [];
  for (const arr of byCustomer.values()) {
    if (arr.length === 1) {
      out.push({ ...arr[0], linked_alert_ids: [] });
      continue;
    }
    // Highest criticality wins as primary. Stable tiebreaker = input order.
    let primaryIdx = 0;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].criticality_score > arr[primaryIdx].criticality_score) primaryIdx = i;
    }
    const primary = arr[primaryIdx];
    const linked = arr.filter((_, i) => i !== primaryIdx).map((a) => a.id);
    out.push({ ...primary, linked_alert_ids: linked });
  }
  return out;
}

export type SortKey = 'criticality' | 'severity' | 'age';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Stable sort by the given key. Criticality + severity sort descending
 * (most-critical first); age sorts descending too (oldest first) since
 * "what's been waiting longest" is the relevant question.
 */
export function sortBy(alerts: Alert[], key: SortKey): Alert[] {
  const indexed = alerts.map((a, i) => ({ a, i }));
  indexed.sort((x, y) => {
    let cmp = 0;
    if (key === 'criticality') cmp = y.a.criticality_score - x.a.criticality_score;
    else if (key === 'severity') cmp = SEVERITY_ORDER[y.a.severity] - SEVERITY_ORDER[x.a.severity];
    else if (key === 'age') cmp = y.a.age_min - x.a.age_min;
    if (cmp !== 0) return cmp;
    return x.i - y.i; // stable
  });
  return indexed.map((e) => e.a);
}
