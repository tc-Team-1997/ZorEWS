// services/bff/src/rule_template_action_inventory.ts
//
// T6 M5.15 — Rule template recommended-action inventory.
//
// M5.1 ships 12 BIL rule templates, each with a `recommended_actions[]`
// list pointing at the M8 routing actions (open_case, notify_supervisor,
// pause_disbursement, request_documents, flag_for_review, auto_decline).
// M5.15 ships the INVERTED index: for each distinct action, list which
// templates use it + how often + which categories they cover.
//
// Mirror of M4.11 (indicator usage map → reverse cross-reference of
// indicators → templates) but for the recommended_actions axis.
// Surfaces operational coverage gaps — e.g. "no template auto-declines"
// → ops should consider adding one for high-confidence fraud cases.
//
// Pure — platform-static. Same response across every tenant.

import { RULE_TEMPLATES, type RecommendedAction, type RuleTemplate } from './rule_templates';

// ─── Public types ─────────────────────────────────────────────────────

const ALL_ACTIONS: readonly RecommendedAction[] = [
  'open_case',
  'notify_supervisor',
  'pause_disbursement',
  'request_documents',
  'flag_for_review',
  'auto_decline',
] as const;

export interface TemplateActionUsage {
  action: RecommendedAction;
  /** Templates referencing this action. Sorted by template_id asc. */
  templates: Array<{
    template_id: string;
    name: string;
    category: RuleTemplate['category'];
    vertical: RuleTemplate['vertical'];
    recommended_severity: RuleTemplate['recommended_severity'];
  }>;
  /** Total templates referencing this action. */
  reference_count: number;
  /** Per-category breakdown — counts of how many referencing templates
   *  fall into each category. Every category key present (zero when
   *  the action has no template in that category). */
  by_category: Record<RuleTemplate['category'], number>;
  /** Per-severity breakdown — same approach. */
  by_severity: Record<RuleTemplate['recommended_severity'], number>;
}

export interface TemplateActionInventory {
  total_templates: number;
  /** Every action in ALL_ACTIONS emitted; zero-count surfaced too
   *  (unused actions are the actionable signal for ops). Sorted by
   *  reference_count desc with action name asc tie-break. */
  actions: TemplateActionUsage[];
  /** Actions with reference_count === 0 — surfaced separately for
   *  the SPA to render "no templates use this action" warning. */
  unused_actions: RecommendedAction[];
  /** Most-referenced action (highest reference_count). null when
   *  every action is unused (zero-template library). */
  most_referenced: RecommendedAction | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

function emptyCategoryCounts(): Record<RuleTemplate['category'], number> {
  return {
    risk_monitoring: 0,
    fraud_detection: 0,
    compliance: 0,
    operational: 0,
    underwriting: 0,
  };
}

function emptySeverityCounts(): Record<RuleTemplate['recommended_severity'], number> {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
}

export function mapTemplateActionUsage(): TemplateActionInventory {
  // Initialise every action with zero-state so unused actions surface
  // alongside referenced ones.
  const usage = new Map<RecommendedAction, TemplateActionUsage>();
  for (const action of ALL_ACTIONS) {
    usage.set(action, {
      action,
      templates: [],
      reference_count: 0,
      by_category: emptyCategoryCounts(),
      by_severity: emptySeverityCounts(),
    });
  }

  for (const tpl of RULE_TEMPLATES) {
    // Defensive dedup: if a template ever lists the same action twice
    // (caller error in the library), count it once.
    const seenForThisTemplate = new Set<RecommendedAction>();
    for (const action of tpl.recommended_actions) {
      if (seenForThisTemplate.has(action)) continue;
      seenForThisTemplate.add(action);
      const row = usage.get(action);
      if (!row) continue; // unknown action enum — shouldn't happen
      row.templates.push({
        template_id: tpl.id,
        name: tpl.name,
        category: tpl.category,
        vertical: tpl.vertical,
        recommended_severity: tpl.recommended_severity,
      });
      row.reference_count++;
      row.by_category[tpl.category]++;
      row.by_severity[tpl.recommended_severity]++;
    }
  }

  for (const row of usage.values()) {
    row.templates.sort((a, b) => a.template_id.localeCompare(b.template_id));
  }

  const actions = [...usage.values()].sort((a, b) => {
    if (b.reference_count !== a.reference_count) return b.reference_count - a.reference_count;
    return a.action.localeCompare(b.action);
  });

  const unused_actions = actions
    .filter((row) => row.reference_count === 0)
    .map((row) => row.action);

  const most_referenced = actions[0] && actions[0].reference_count > 0
    ? actions[0].action
    : null;

  return {
    total_templates: RULE_TEMPLATES.length,
    actions,
    unused_actions,
    most_referenced,
  };
}
