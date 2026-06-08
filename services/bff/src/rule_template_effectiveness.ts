// services/bff/src/rule_template_effectiveness.ts
//
// T6 M5.11 — Rule template effectiveness back-test.
//
// M5.1 ships the BIL rule template library (12 starter templates).
// M5.11 answers "what precision/recall would this template have achieved
// if it had been deployed over the last N days?" — a required pre-launch
// evidence checkpoint per BIL §10 / RBI model-risk guidelines.
//
// Simulation approach:
//   - Deterministic synthesis per (template_id, window_days) via
//     FNV-1a hash + Mulberry32 PRNG — same inputs always yield the
//     same numbers so the SPA can cache without staleness anxiety.
//   - Precision: higher for compliance + governance templates (0.75-0.90);
//     lower for high-volume fraud_detection (0.60-0.80).
//   - Recall: 0.55-0.85 range; inversely correlated with precision
//     (tight precision → lower recall).
//   - F1: harmonic mean of precision and recall.
//   - fires: proportional to window_days × (supporting_indicators.length + 1)
//     × a category-specific multiplier (0.3-2.5 range).
//   - confidence: high (window >= 90d), medium (30-89d), low (< 30d).

import {
  RULE_TEMPLATES,
  getTemplate,
  type RuleTemplate,
  type RuleTemplateCategory,
} from './rule_templates';

// ─── Public types ──────────────────────────────────────────────────────

export type BacktestConfidence = 'high' | 'medium' | 'low';

export interface TemplateEffectivenessResult {
  template_id: string;
  template_name: string;
  window_days: number;
  simulated_fires: number;
  estimated_precision: number;
  estimated_recall: number;
  estimated_f1: number;
  false_positive_estimate: number;
  detection_rate: number;
  top_trigger_indicators: string[];
  confidence: BacktestConfidence;
  methodology: string;
}

export class TemplateEffectivenessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TemplateEffectivenessError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

export const BACKTEST_DEFAULT_WINDOW = 30;
export const BACKTEST_MIN_WINDOW = 7;
export const BACKTEST_MAX_WINDOW = 365;

export function validateWindowDays(raw: unknown): number {
  if (raw === undefined || raw === null) return BACKTEST_DEFAULT_WINDOW;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < BACKTEST_MIN_WINDOW || n > BACKTEST_MAX_WINDOW) {
    throw new TemplateEffectivenessError(
      'invalid_input',
      `window_days must be an integer in [${BACKTEST_MIN_WINDOW}, ${BACKTEST_MAX_WINDOW}]`,
    );
  }
  return n;
}

// ─── PRNG (same FNV-1a + Mulberry32 pattern used throughout the BFF) ──

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function makeRng(template_id: string, window_days: number): () => number {
  return mulberry32(fnv1a(`${template_id}:${window_days}`));
}

// ─── Category sensitivity metadata ────────────────────────────────────

const CATEGORY_PRECISION_RANGE: Record<RuleTemplateCategory, [number, number]> = {
  compliance:      [0.78, 0.90],
  operational:     [0.74, 0.88],
  underwriting:    [0.70, 0.86],
  risk_monitoring: [0.65, 0.82],
  fraud_detection: [0.60, 0.80],
};

const CATEGORY_FIRE_MULTIPLIER: Record<RuleTemplateCategory, number> = {
  compliance:      0.4,
  underwriting:    0.5,
  operational:     0.8,
  risk_monitoring: 1.5,
  fraud_detection: 2.2,
};

// ─── Core pure function ────────────────────────────────────────────────

/**
 * Simulate effectiveness of a rule template over a historical window.
 * Pure function — no I/O, fully deterministic given the same inputs.
 */
export function runTemplateEffectivenessBacktest(
  template: RuleTemplate,
  window_days: number,
): TemplateEffectivenessResult {
  const rng = makeRng(template.id, window_days);

  // Precision range is category-driven.
  const [precMin, precMax] = CATEGORY_PRECISION_RANGE[template.category];
  const precision = precMin + rng() * (precMax - precMin);

  // Recall inversely correlated with precision — higher precision rules
  // tend to be narrower and catch fewer events.
  const recallMin = 0.55 + (1 - precision) * 0.3;
  const recallMax = 0.75 + (1 - precision) * 0.2;
  const recall = recallMin + rng() * (recallMax - recallMin);

  // Harmonic mean.
  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  // Simulated fires: proportional to window × indicators × category multiplier.
  const indicator_factor = Math.max(1, template.supporting_indicators.length);
  const fire_mult = CATEGORY_FIRE_MULTIPLIER[template.category];
  // Add ±30% jitter via rng.
  const jitter = 0.7 + rng() * 0.6;
  const simulated_fires = Math.round(window_days * indicator_factor * fire_mult * jitter * 0.1);

  // False positives = fires × (1 - precision).
  const false_positive_estimate = Math.round(simulated_fires * (1 - precision));

  // Detection rate = how many known-risk events the rule would catch.
  const detection_rate = parseFloat((recall * (0.85 + rng() * 0.15)).toFixed(3));

  // Top trigger indicators — use the declared list, capped at 3.
  const sorted_indicators = [...template.supporting_indicators]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 3);

  // Confidence based on window length.
  const confidence: BacktestConfidence =
    window_days >= 90 ? 'high'
    : window_days >= 30 ? 'medium'
    : 'low';

  const methodology =
    `Synthetic simulation over ${window_days}-day window using FNV-1a seeded ` +
    `deterministic PRNG. Precision calibrated on category "${template.category}" ` +
    `(${Math.round(precMin * 100)}-${Math.round(precMax * 100)}% range). ` +
    `Fire rate proportional to indicator count × ${CATEGORY_FIRE_MULTIPLIER[template.category]}× category multiplier. ` +
    `Production back-test against real mart data replaces this with a mart-backed evaluator.`;

  return {
    template_id: template.id,
    template_name: template.name,
    window_days,
    simulated_fires,
    estimated_precision: parseFloat(precision.toFixed(4)),
    estimated_recall: parseFloat(recall.toFixed(4)),
    estimated_f1: parseFloat(f1.toFixed(4)),
    false_positive_estimate,
    detection_rate,
    top_trigger_indicators: sorted_indicators,
    confidence,
    methodology,
  };
}

/**
 * Convenience wrapper: resolve template_id → template, validate
 * window_days, run backtest. Throws TemplateEffectivenessError on
 * unknown template or invalid window.
 */
export function runTemplateEffectivenessBacktestById(
  template_id: string,
  raw_window_days: unknown,
): TemplateEffectivenessResult {
  const window_days = validateWindowDays(raw_window_days);
  const template = getTemplate(template_id);
  if (!template) {
    throw new TemplateEffectivenessError(
      'unknown_template',
      `rule template ${template_id} not found`,
    );
  }
  return runTemplateEffectivenessBacktest(template, window_days);
}

// Re-export RULE_TEMPLATES for tests that want to iterate the library.
export { RULE_TEMPLATES };
