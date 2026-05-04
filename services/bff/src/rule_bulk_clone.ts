// services/bff/src/rule_bulk_clone.ts
//
// T6 M5.2 — Rule bulk-clone.
//
// M5.1 ships the BIL rule template library. M5.2 lets admins bulk-
// clone a set of templates during tenant onboarding instead of
// hand-creating rules one-at-a-time.
//
// Design: this module is a *preview* — it materialises draft rule
// shapes from the template selection, but does NOT mutate the T4.7
// rules store. The SPA then iterates the result and POSTs each one
// to /v1/rules (T4.7) to commit. Keeps the bulk-clone logic
// decoupled from the rules state machine.
//
// Selection: caller supplies EITHER `template_ids[]` OR a filter
// `(category, vertical)`. Exactly one mode — both supplied → 400;
// neither → 400 (matches the M16.2 bulk-run shape).
//
// Result: deterministic-ish — `cloned[]` matches the input template
// order; `skipped[]` carries `{template_id, reason}` for ids in the
// request that didn't resolve. Same id specified twice → cloned
// once; second appearance reported as skipped (`duplicate`).

import {
  type RuleTemplate,
  type RuleTemplateCategory,
  type RuleTemplateVertical,
  type RecommendedAction,
  type RecommendedSeverity,
  isRuleTemplateCategory,
  isRuleTemplateVertical,
  listTemplates,
  getTemplate,
} from './rule_templates';

// ─── Public types ──────────────────────────────────────────────────────

export interface BulkCloneInput {
  template_ids?: string[];
  category?: RuleTemplateCategory;
  vertical?: RuleTemplateVertical;
  /** Optional rename prefix applied to every cloned rule's name.
   *  E.g. `"BIL-prod-"` → "BIL-prod-DPD 30-60 watchlist". null/empty
   *  passes the template name through unchanged. */
  name_prefix?: string;
}

/** Draft rule shape produced from a template — the SPA submits this
 *  (potentially after edits) to T4.7 POST /v1/rules. */
export interface ClonedRule {
  /** Source template id this clone derived from. */
  source_template_id: string;
  /** Human-readable name (template.name with optional prefix). */
  name: string;
  description: string;
  category: RuleTemplateCategory;
  vertical: RuleTemplateVertical;
  condition_pseudocode: string;
  recommended_severity: RecommendedSeverity;
  recommended_actions: RecommendedAction[];
  supporting_indicators: string[];
  /** State the clone starts in — always `draft` so a reviewer signs it
   *  off before activation per BIL/RBI rule lifecycle. */
  state: 'draft';
}

export interface SkippedClone {
  template_id: string;
  /** unknown_template (id didn't resolve) | duplicate (same id supplied
   *  twice in template_ids) | out_of_filter (id resolves but doesn't
   *  match category/vertical filter) */
  reason: 'unknown_template' | 'duplicate' | 'out_of_filter';
}

export interface BulkCloneResult {
  generated_at: string;
  selection: { mode: 'by_ids'; template_ids: string[] } | { mode: 'by_filter'; category?: RuleTemplateCategory; vertical?: RuleTemplateVertical };
  /** How many template_ids the caller supplied (or how many matched
   *  the filter). */
  requested_count: number;
  /** Clones successfully materialised. */
  cloned: ClonedRule[];
  /** Per-id skip reasons — useful for the SPA to render "5 of 8
   *  cloned, 3 skipped". */
  skipped: SkippedClone[];
}

export class BulkCloneError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BulkCloneError';
  }
}

// ─── Validation + resolution ───────────────────────────────────────────

/**
 * Resolve the input to a list of (template, source_template_id) pairs
 * + a `skipped[]` array. Throws BulkCloneError on invalid input
 * combinations (both modes / neither / > 50 ids / bad type).
 */
export function resolveBulkClone(input: BulkCloneInput): {
  templates: { template: RuleTemplate; source_template_id: string }[];
  skipped: SkippedClone[];
  selection: BulkCloneResult['selection'];
  requested_count: number;
} {
  if (!input || typeof input !== 'object') {
    throw new BulkCloneError('invalid_input', 'request body required');
  }
  const hasIds = Array.isArray(input.template_ids) && input.template_ids.length > 0;
  const hasFilter =
    typeof input.category === 'string' || typeof input.vertical === 'string';

  if (hasIds && hasFilter) {
    throw new BulkCloneError(
      'invalid_input',
      'supply either template_ids[] OR a category/vertical filter, not both',
    );
  }
  if (!hasIds && !hasFilter) {
    throw new BulkCloneError(
      'invalid_input',
      'one of template_ids[] / category / vertical is required',
    );
  }
  if (input.name_prefix !== undefined && typeof input.name_prefix !== 'string') {
    throw new BulkCloneError('invalid_input', 'name_prefix must be a string');
  }
  if (input.name_prefix !== undefined && input.name_prefix.length > 80) {
    throw new BulkCloneError('invalid_input', 'name_prefix must be ≤ 80 chars');
  }

  if (hasIds) {
    const ids = input.template_ids!;
    if (ids.length > 50) {
      throw new BulkCloneError('invalid_input', 'at most 50 template_ids per call');
    }
    const skipped: SkippedClone[] = [];
    const seen = new Set<string>();
    const resolved: { template: RuleTemplate; source_template_id: string }[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new BulkCloneError('invalid_input', 'every template_id must be a non-empty string');
      }
      if (seen.has(id)) {
        skipped.push({ template_id: id, reason: 'duplicate' });
        continue;
      }
      seen.add(id);
      const tpl = getTemplate(id);
      if (!tpl) {
        skipped.push({ template_id: id, reason: 'unknown_template' });
        continue;
      }
      resolved.push({ template: tpl, source_template_id: id });
    }
    return {
      templates: resolved,
      skipped,
      selection: { mode: 'by_ids', template_ids: ids },
      requested_count: ids.length,
    };
  }

  // Filter mode
  if (input.category !== undefined && !isRuleTemplateCategory(input.category)) {
    throw new BulkCloneError(
      'invalid_category',
      `invalid category: ${input.category}`,
    );
  }
  if (input.vertical !== undefined && !isRuleTemplateVertical(input.vertical)) {
    throw new BulkCloneError(
      'invalid_vertical',
      `invalid vertical: ${input.vertical}`,
    );
  }
  const matched = listTemplates({
    category: input.category,
    vertical: input.vertical,
  });
  return {
    templates: matched.map((t) => ({ template: t, source_template_id: t.id })),
    skipped: [],
    selection: { mode: 'by_filter', category: input.category, vertical: input.vertical },
    requested_count: matched.length,
  };
}

// ─── Materialisation ───────────────────────────────────────────────────

function materialise(
  template: RuleTemplate,
  source_template_id: string,
  name_prefix?: string,
): ClonedRule {
  const prefix = name_prefix && name_prefix.length > 0 ? name_prefix : '';
  return {
    source_template_id,
    name: `${prefix}${template.name}`,
    description: template.description,
    category: template.category,
    vertical: template.vertical,
    condition_pseudocode: template.condition_pseudocode,
    recommended_severity: template.recommended_severity,
    recommended_actions: [...template.recommended_actions],
    supporting_indicators: [...template.supporting_indicators],
    state: 'draft',
  };
}

// ─── Main entry ────────────────────────────────────────────────────────

/**
 * Pure expansion function. Build the bulk-clone result for the given
 * input. Doesn't mutate any store — the SPA submits each clone to
 * T4.7's POST /v1/rules to commit.
 */
export function expandBulkClone(input: BulkCloneInput, now: Date): BulkCloneResult {
  const resolved = resolveBulkClone(input);
  const cloned: ClonedRule[] = resolved.templates.map((r) =>
    materialise(r.template, r.source_template_id, input.name_prefix),
  );
  return {
    generated_at: now.toISOString(),
    selection: resolved.selection,
    requested_count: resolved.requested_count,
    cloned,
    skipped: resolved.skipped,
  };
}
