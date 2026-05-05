// services/bff/src/rule_simulation_bundle.ts
//
// T6 M5.4 — Rule simulation bundle.
//
// M5.3 simulates ONE rule against ONE scenario. M5.4 maps M5.3
// across ALL M16.1 presets at once, returning a ranked table the
// SPA renders as a single "stress preview" panel ("how does this
// rule fire across the full preset library?").

import {
  type RuleSimulationResult,
  type RuleTemplateLookup,
  RuleSimulationError,
  simulateRule,
} from './rule_simulation';
import { getTemplate as getRuleTemplate } from './rule_templates';
import { SCENARIO_PRESETS, getScenarioPreset } from './scenario_library';

export interface BundleSimulationInput {
  rule_template_id: string;
  /** Optional subset of preset ids; defaults to all 10. */
  preset_ids?: string[];
  customer_count?: number;
}

export interface BundleSimulationResult {
  rule_template_id: string;
  rule_name: string;
  customer_count: number;
  /** Per-scenario simulation result, sorted by fire_rate desc. */
  results: RuleSimulationResult[];
  /** Aggregate over all scenarios in the bundle. */
  worst: RuleSimulationResult;
  best: RuleSimulationResult;
  mean_fire_rate: number;
  generated_at: string;
}

const DEFAULT_CUSTOMER_COUNT = 200;
const MAX_CUSTOMER_COUNT = 10_000;

export function simulateRuleBundle(
  input: BundleSimulationInput,
  asOf: Date,
  templateLookup: RuleTemplateLookup = getRuleTemplate,
): BundleSimulationResult {
  if (!input || typeof input !== 'object') {
    throw new RuleSimulationError('invalid_input', 'request body required');
  }
  if (typeof input.rule_template_id !== 'string' || !input.rule_template_id.trim()) {
    throw new RuleSimulationError('invalid_input', 'rule_template_id is required');
  }
  let customer_count = DEFAULT_CUSTOMER_COUNT;
  if (input.customer_count !== undefined) {
    if (
      typeof input.customer_count !== 'number' ||
      !Number.isFinite(input.customer_count) ||
      !Number.isInteger(input.customer_count) ||
      input.customer_count < 1 ||
      input.customer_count > MAX_CUSTOMER_COUNT
    ) {
      throw new RuleSimulationError(
        'invalid_input',
        `customer_count must be integer in [1, ${MAX_CUSTOMER_COUNT}]`,
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

  let presets = SCENARIO_PRESETS;
  if (input.preset_ids !== undefined) {
    if (!Array.isArray(input.preset_ids) || input.preset_ids.length === 0) {
      throw new RuleSimulationError('invalid_input', 'preset_ids must be a non-empty array');
    }
    if (input.preset_ids.length > 50) {
      throw new RuleSimulationError('invalid_input', 'at most 50 preset_ids per bundle');
    }
    const resolved = [];
    for (const id of input.preset_ids) {
      const p = getScenarioPreset(id);
      if (!p) {
        throw new RuleSimulationError('unknown_scenario', `unknown scenario preset: ${id}`);
      }
      resolved.push(p);
    }
    presets = resolved;
  }

  const results = presets
    .map((p) => simulateRule(template, p, customer_count, asOf))
    .sort((a, b) => b.fire_rate - a.fire_rate);

  const worst = results[0]!;
  const best = results[results.length - 1]!;
  const mean_fire_rate =
    results.reduce((acc, r) => acc + r.fire_rate, 0) / results.length;

  return {
    rule_template_id: template.id,
    rule_name: template.name,
    customer_count,
    results,
    worst,
    best,
    mean_fire_rate,
    generated_at: asOf.toISOString(),
  };
}
