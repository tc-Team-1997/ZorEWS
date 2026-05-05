// services/bff/src/rule_template_diff.ts
//
// T6 M5.5 — Rule template diff.
//
// Mirror of M16.3 (scenario diff) but for M5.1 rule templates.
// Compares two templates field-by-field and surfaces a structured
// diff the SPA renders side-by-side. Pure function — no store, no
// AppDeps slot.
//
// Field types covered:
//  - enum:  category, vertical, recommended_severity
//  - string: name, condition_pseudocode, source_doc, description
//  - array (set-diff with added/removed/common): recommended_actions,
//    supporting_indicators

import {
  type RuleTemplate,
  getTemplate as getRuleTemplate,
} from './rule_templates';

/** Optional callback to extend resolution beyond the M5.1 platform
 *  library (M5.7 — wires customRuleTemplateStore so tenant-authored
 *  ids resolve too). */
export type DiffRuleTemplateLookup = (id: string) => RuleTemplate | null;

// ─── Public types ─────────────────────────────────────────────────────

export type DiffFieldKind = 'enum' | 'string' | 'array';

export interface DiffEntry {
  field: string;
  kind: DiffFieldKind;
  /** For enum/string fields: raw left/right values. For array fields:
   *  the full string[] arrays. */
  left: string | readonly string[];
  right: string | readonly string[];
  changed: boolean;
  /** Populated only for kind='array' — set-diff over left vs right. */
  added?: string[];
  removed?: string[];
  common?: string[];
}

export interface RuleTemplateDiffResult {
  left: RuleTemplate;
  right: RuleTemplate;
  entries: DiffEntry[];
  changed_entries: DiffEntry[];
  generated_at: string;
}

export class RuleTemplateDiffError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RuleTemplateDiffError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function stringEntry(
  field: string,
  kind: 'enum' | 'string',
  left: string,
  right: string,
): DiffEntry {
  return {
    field,
    kind,
    left,
    right,
    changed: left !== right,
  };
}

function arrayEntry(
  field: string,
  left: readonly string[],
  right: readonly string[],
): DiffEntry {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const added = right.filter((x) => !leftSet.has(x));
  const removed = left.filter((x) => !rightSet.has(x));
  const common = left.filter((x) => rightSet.has(x));
  return {
    field,
    kind: 'array',
    left: [...left],
    right: [...right],
    changed: added.length > 0 || removed.length > 0,
    added,
    removed,
    common,
  };
}

// ─── Main entry ───────────────────────────────────────────────────────

/**
 * Pure-function field-by-field diff between two rule templates.
 *
 * Fields covered (declared order):
 *   1. category               (enum)
 *   2. vertical               (enum)
 *   3. recommended_severity   (enum)
 *   4. name                   (string)
 *   5. condition_pseudocode   (string)
 *   6. source_doc             (string)
 *   7. recommended_actions    (array)
 *   8. supporting_indicators  (array)
 *
 * `id` and `description` are excluded — id is the lookup key,
 * description is free-text prose.
 */
export function diffRuleTemplates(
  left: RuleTemplate,
  right: RuleTemplate,
  now: Date,
): RuleTemplateDiffResult {
  const entries: DiffEntry[] = [
    stringEntry('category', 'enum', left.category, right.category),
    stringEntry('vertical', 'enum', left.vertical, right.vertical),
    stringEntry('recommended_severity', 'enum', left.recommended_severity, right.recommended_severity),
    stringEntry('name', 'string', left.name, right.name),
    stringEntry('condition_pseudocode', 'string', left.condition_pseudocode, right.condition_pseudocode),
    stringEntry('source_doc', 'string', left.source_doc, right.source_doc),
    arrayEntry('recommended_actions', left.recommended_actions, right.recommended_actions),
    arrayEntry('supporting_indicators', left.supporting_indicators, right.supporting_indicators),
  ];

  const changed_entries = entries.filter((e) => e.changed);

  return {
    left,
    right,
    entries,
    changed_entries,
    generated_at: now.toISOString(),
  };
}

/**
 * Resolve template ids and run the diff.
 * Code-routed:
 *   - missing/blank left/right id → invalid_input (400)
 *   - left === right              → same_template (400)
 *   - either id unknown           → unknown_template (404)
 */
export function diffRuleTemplatesByIds(
  left_id: unknown,
  right_id: unknown,
  now: Date,
  lookup: DiffRuleTemplateLookup = getRuleTemplate,
): RuleTemplateDiffResult {
  if (typeof left_id !== 'string' || !left_id.trim()) {
    throw new RuleTemplateDiffError('invalid_input', 'left_id is required');
  }
  if (typeof right_id !== 'string' || !right_id.trim()) {
    throw new RuleTemplateDiffError('invalid_input', 'right_id is required');
  }
  if (left_id === right_id) {
    throw new RuleTemplateDiffError(
      'same_template',
      'left_id and right_id are the same template — diff would be empty',
    );
  }
  const left = lookup(left_id);
  if (!left) {
    throw new RuleTemplateDiffError('unknown_template', `unknown rule template: ${left_id}`);
  }
  const right = lookup(right_id);
  if (!right) {
    throw new RuleTemplateDiffError('unknown_template', `unknown rule template: ${right_id}`);
  }
  return diffRuleTemplates(left, right, now);
}
