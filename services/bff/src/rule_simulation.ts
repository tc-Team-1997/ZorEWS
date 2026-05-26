// services/bff/src/rule_simulation.ts
//
// T6 M5.3 — Rule simulation against scenario library.
//
// M5.1 ships the BIL rule template library; M16.1 ships the named
// scenario library. M5.3 ties them together: an admin picks a
// rule template + a scenario preset, and the BFF returns an
// expected fire-rate (fired_count / customer_count) plus a per-
// severity breakdown. Drives the SPA's "what would this rule do
// under RBI Severely Adverse?" pre-activation check.
//
// Design:
//  - Pure function. No store, no AppDeps. The synthesis is
//    deterministic per (template, scenario, asOf-day) so the SPA
//    can re-issue the call and get the same answer.
//  - Fire rate is built from three factors:
//      base_rate(template)  — depends on template id hash + category
//                             (fraud_detection rules fire less than
//                             risk_monitoring on baseline)
//      stress(scenario)     — magnitude of the scenario's shocks
//                             (gdp + rate + fx → 0..1)
//      sensitivity(template_category) — how strongly the rule
//                             responds to stress (compliance/under-
//                             writing rules barely move; risk_-
//                             monitoring + fraud_detection move a
//                             lot)
//    Final rate = clamp(base_rate * (1 + sensitivity * stress), 0, 1).
//  - by_severity bucketing: 60% of fired_count maps to
//    recommended_severity, 25% one notch below, 15% the notch below
//    that. Floors at 'low'.
//  - amplification = fire_rate / baseline_fire_rate (against the
//    zero-shock baseline preset). Capped at 99 to dodge divide-by-
//    near-zero blowup. Always 1.0 when scenario IS the baseline.
//
// Out of scope:
//  - Real evaluation against real customer state. That's what the
//    existing rule simulator does in `services/regulatory-svc/rules/`
//    against synthetic event streams. M5.3 is the lighter "what's
//    the EXPECTED fire-rate" view that doesn't need actual events.

import {
  type RuleTemplate,
  type RuleTemplateCategory,
  type RecommendedSeverity,
  getTemplate as getRuleTemplate,
} from './rule_templates';

/** Optional callback to extend template resolution beyond the
 *  M5.1 platform library (M5.7 — wires customRuleTemplateStore so
 *  tenant-authored ids resolve too). */
export type RuleTemplateLookup = (id: string) => RuleTemplate | null;
import {
  type ScenarioPreset,
  getScenarioPreset,
} from './scenario_library';

// ─── Public types ─────────────────────────────────────────────────────

export interface RuleSimulationInput {
  rule_template_id: string;
  scenario_preset_id: string;
  /** Population size for the simulation. Defaults to 200; capped at
   *  10000 to keep the pure-function fast. */
  customer_count?: number;
}

export interface SeverityBucket {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** M5.2 — sample matched record. The simulator doesn't run against
 *  real customer data — these are deterministic synthetic ids the SPA
 *  surfaces in the simulator "what would have matched?" preview. */
export interface SimulatedMatchedRecord {
  customer_id: string;
  segment: 'RETAIL' | 'SME' | 'CORPORATE' | 'NBFC';
  contribution: number; // 0..1 — how strongly the rule would fire on this
}

export interface RuleSimulationResult {
  rule_template_id: string;
  rule_name: string;
  rule_category: RuleTemplateCategory;
  recommended_severity: RecommendedSeverity;
  scenario_preset_id: string;
  scenario_name: string;
  customer_count: number;
  fired_count: number;
  /** M5.2 — pass = matched the rule. Alias for fired_count, surfaced
   *  explicitly so the SPA can label it as "pass" in the simulator. */
  pass_count: number;
  /** M5.2 — fail = NOT matched. customer_count - fired_count. */
  fail_count: number;
  /** fired_count / customer_count, in [0, 1]. */
  fire_rate: number;
  /** Fire rate the same rule would have on the zero-shock baseline. */
  baseline_fire_rate: number;
  /** fire_rate / baseline_fire_rate; ≥ 1 means the scenario amplifies
   *  this rule's firing relative to baseline. Capped at 99 to dodge
   *  divide-by-near-zero. */
  amplification: number;
  by_severity: SeverityBucket;
  /** M5.2 — top-10 deterministic synthetic customer_ids that the rule
   *  would match in this scenario. Drives the simulator's "sample
   *  matched records" preview. Empty when fired_count=0. */
  sample_matched_records: SimulatedMatchedRecord[];
  /** M5.2 — projected alert volume in matches/day, derived from
   *  fired_count + assumed daily population turnover. Drives the
   *  "expected operator load" headline on the simulator. */
  projected_alert_volume_per_day: number;
  simulated_at: string;
}

export class RuleSimulationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuleSimulationError';
  }
}

// ─── Deterministic PRNG (FNV-1a + Mulberry32) ─────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Per-category sensitivity (how much stress moves the rule) ────────

const CATEGORY_SENSITIVITY: Record<RuleTemplateCategory, number> = {
  risk_monitoring: 1.8, // SLA + DPD + concentration rules — very stress-sensitive
  fraud_detection: 1.5, // duplicate claims + suspicious patterns
  underwriting: 0.8,   // medium — UW signals shift in macro stress
  compliance: 0.4,     // KYC + AML — barely move with shocks
  operational: 0.6,    // service-level + ops alarms
};

// ─── Stress index from a scenario ─────────────────────────────────────

/**
 * Map a scenario's shocks to a 0..1 stress index. Magnitude-only
 * (sign ignored) since both gdp contraction (negative) and gdp
 * expansion (positive) move rule firing — though in opposite
 * directions, the rule library doesn't carry a directional bias
 * field, so we treat magnitude.
 */
export function scenarioStress(s: ScenarioPreset): number {
  // Reference points (severely-adverse): gdp -4, rate 300, fx 12.
  const gdp = Math.min(1, Math.abs(s.shocks.gdp) / 4);
  const rate = Math.min(1, Math.abs(s.shocks.rate) / 300);
  const fx = Math.min(1, Math.abs(s.shocks.fx) / 12);
  // Weighted average — gdp + rate dominate; fx is a third.
  return 0.4 * gdp + 0.4 * rate + 0.2 * fx;
}

// ─── Base fire rate per template (deterministic) ──────────────────────

/**
 * Synthesise a baseline fire rate for the template — a deterministic
 * function of (template id, category). Bounded in [0.005, 0.12]
 * so even high-firing templates only fire on ~12% of the population
 * under no-shock baseline.
 */
function templateBaseRate(t: RuleTemplate): number {
  // Category bias: compliance rules fire less often than fraud
  const categoryBias: Record<RuleTemplateCategory, number> = {
    risk_monitoring: 0.06,
    fraud_detection: 0.03,
    underwriting: 0.02,
    compliance: 0.015,
    operational: 0.025,
  };
  const bias = categoryBias[t.category] ?? 0.02;
  // Per-template jitter (deterministic) so two same-category
  // templates don't end up identical.
  const r = rng(fnv1a(`base|${t.id}|${t.category}`))();
  // Jitter ±50% of the bias.
  const jitter = (r - 0.5) * bias;
  return Math.max(0.005, Math.min(0.12, bias + jitter));
}

// ─── Severity bucketing ───────────────────────────────────────────────

const SEVERITY_ORDER: RecommendedSeverity[] = ['critical', 'high', 'medium', 'low'];

function severityBucket(
  fired: number,
  recommended: RecommendedSeverity,
): SeverityBucket {
  const out: SeverityBucket = { critical: 0, high: 0, medium: 0, low: 0 };
  if (fired === 0) return out;
  const idx = SEVERITY_ORDER.indexOf(recommended);
  // 60% recommended, 25% one below, 15% two below — floor at 'low'.
  const split: Array<{ key: RecommendedSeverity; share: number }> = [
    { key: SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, idx)]!, share: 0.6 },
    { key: SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, idx + 1)]!, share: 0.25 },
    { key: SEVERITY_ORDER[Math.min(SEVERITY_ORDER.length - 1, idx + 2)]!, share: 0.15 },
  ];
  let assigned = 0;
  for (const { key, share } of split) {
    const n = Math.round(fired * share);
    out[key] += n;
    assigned += n;
  }
  // Round-off drift: assign the remainder to the recommended bucket.
  const drift = fired - assigned;
  out[recommended] += drift;
  // Defensive: any negative entries (over-correction) get clamped.
  for (const k of SEVERITY_ORDER) out[k] = Math.max(0, out[k]);
  return out;
}

// ─── Main entry ───────────────────────────────────────────────────────

const DEFAULT_CUSTOMER_COUNT = 200;
const MAX_CUSTOMER_COUNT = 10_000;

/**
 * Pure-function rule-vs-scenario simulator. Returns a deterministic
 * fire-rate forecast seeded by (template, scenario, asOf-day).
 */
export function simulateRule(
  template: RuleTemplate,
  scenario: ScenarioPreset,
  customer_count: number,
  asOf: Date,
): RuleSimulationResult {
  const day = asOf.toISOString().slice(0, 10);
  // 1) Base + stress + sensitivity → fire_rate
  const baseRate = templateBaseRate(template);
  const stress = scenarioStress(scenario);
  const sensitivity = CATEGORY_SENSITIVITY[template.category] ?? 1;
  const adjustedRate = Math.max(0, Math.min(1, baseRate * (1 + sensitivity * stress)));
  // 2) Apply per-day deterministic noise so the SPA can re-render
  //    with stable numbers within a day, but adjacent days drift
  //    slightly (matches the "expected" framing — not "exact").
  const noiseR = rng(fnv1a(`sim|${template.id}|${scenario.id}|${day}`))();
  // ±5% jitter
  const jitter = 1 + (noiseR - 0.5) * 0.1;
  const fire_rate = Math.max(0, Math.min(1, adjustedRate * jitter));
  const fired_count = Math.round(fire_rate * customer_count);

  // 3) Baseline fire rate: same template, scenario id 'preset_baseline_no_shock'.
  //    For the all-zero shocks scenario, stress=0 → adjustedRate = baseRate.
  //    Skip the day jitter so the amplification is stable across days.
  const baseline_fire_rate = baseRate;

  // 4) Amplification — capped at 99 to dodge divide-by-near-zero.
  const amplification =
    baseline_fire_rate === 0
      ? 1
      : Math.min(99, fire_rate / baseline_fire_rate);

  // M5.2 — Sample matched records. Deterministic synthetic customer
  // ids seeded by (template, scenario, day) so the same simulation
  // returns the same 10 records — useful for regression + UI snapshot.
  const sample_matched_records = buildSampleMatched(template.id, scenario.id, day, fired_count);

  // M5.2 — Projected alert volume per day. Assumes ~14-day average
  // population turnover (the scoring engine re-evaluates every customer
  // ~14 days) → daily alerts = fired_count / 14. Operators consume this
  // to size the supervisor desk.
  const POPULATION_TURNOVER_DAYS = 14;
  const projected_alert_volume_per_day = Math.max(
    0,
    Math.round((fired_count / POPULATION_TURNOVER_DAYS) * 10) / 10,
  );

  return {
    rule_template_id: template.id,
    rule_name: template.name,
    rule_category: template.category,
    recommended_severity: template.recommended_severity,
    scenario_preset_id: scenario.id,
    scenario_name: scenario.name,
    customer_count,
    fired_count,
    pass_count: fired_count,
    fail_count: Math.max(0, customer_count - fired_count),
    fire_rate,
    baseline_fire_rate,
    amplification,
    by_severity: severityBucket(fired_count, template.recommended_severity),
    sample_matched_records,
    projected_alert_volume_per_day,
    simulated_at: asOf.toISOString(),
  };
}

/** M5.2 — deterministic synthetic match sampler. Returns up to 10 ids
 *  with descending contribution scores. fired_count=0 → empty. */
export const SAMPLE_MATCHED_CAP = 10;
const SAMPLE_SEGMENTS: SimulatedMatchedRecord['segment'][] = [
  'RETAIL',
  'SME',
  'CORPORATE',
  'NBFC',
];

function buildSampleMatched(
  template_id: string,
  scenario_id: string,
  day: string,
  fired_count: number,
): SimulatedMatchedRecord[] {
  if (fired_count <= 0) return [];
  const n = Math.min(SAMPLE_MATCHED_CAP, fired_count);
  const out: SimulatedMatchedRecord[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng(fnv1a(`match|${template_id}|${scenario_id}|${day}|${i}`))();
    // Descending contribution — first sample is the highest-fit match.
    const contribution = Math.round((0.95 - i * 0.06 - r * 0.04) * 100) / 100;
    out.push({
      customer_id: `c-sim-${(fnv1a(`${template_id}|${scenario_id}|${day}|${i}`) % 100000)
        .toString()
        .padStart(5, '0')}`,
      segment: SAMPLE_SEGMENTS[i % SAMPLE_SEGMENTS.length]!,
      contribution: Math.max(0.1, contribution),
    });
  }
  return out;
}

/**
 * Resolve template + scenario by id and run the simulation. Code-
 * routed:
 *   - missing/blank id            → invalid_input (400)
 *   - customer_count out of range → invalid_input (400)
 *   - unknown template id         → unknown_template (404)
 *   - unknown scenario id         → unknown_scenario (404)
 */
export function simulateRuleByIds(
  input: RuleSimulationInput,
  asOf: Date,
  templateLookup: RuleTemplateLookup = getRuleTemplate,
): RuleSimulationResult {
  if (!input || typeof input !== 'object') {
    throw new RuleSimulationError('invalid_input', 'request body required');
  }
  if (typeof input.rule_template_id !== 'string' || !input.rule_template_id.trim()) {
    throw new RuleSimulationError('invalid_input', 'rule_template_id is required');
  }
  if (typeof input.scenario_preset_id !== 'string' || !input.scenario_preset_id.trim()) {
    throw new RuleSimulationError('invalid_input', 'scenario_preset_id is required');
  }
  let customer_count = DEFAULT_CUSTOMER_COUNT;
  if (input.customer_count !== undefined) {
    if (
      typeof input.customer_count !== 'number' ||
      !Number.isFinite(input.customer_count) ||
      !Number.isInteger(input.customer_count)
    ) {
      throw new RuleSimulationError('invalid_input', 'customer_count must be an integer');
    }
    if (input.customer_count < 1 || input.customer_count > MAX_CUSTOMER_COUNT) {
      throw new RuleSimulationError(
        'invalid_input',
        `customer_count must be in [1, ${MAX_CUSTOMER_COUNT}]`,
      );
    }
    customer_count = input.customer_count;
  }

  const template = templateLookup(input.rule_template_id);
  if (!template) {
    throw new RuleSimulationError(
      'unknown_template',
      `unknown rule template: ${input.rule_template_id}`,
    );
  }
  const scenario = getScenarioPreset(input.scenario_preset_id);
  if (!scenario) {
    throw new RuleSimulationError(
      'unknown_scenario',
      `unknown scenario preset: ${input.scenario_preset_id}`,
    );
  }

  return simulateRule(template, scenario, customer_count, asOf);
}
