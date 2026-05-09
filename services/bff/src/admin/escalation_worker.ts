// services/bff/src/admin/escalation_worker.ts
//
// First runtime consumer of the escalation_matrix + case_scenarios +
// notification_templates triad. Pure helpers — no IO, no scheduling.
// The worker that wires this on a cron is a separate slice (M14.25b);
// for now an admin route lets ops trigger it manually and inspect what
// would fire.
//
// Logic:
//
//   For each open case, find a matching ACTIVE case_scenario by
//   (case_category, priority). Resolve its default_escalation_id to
//   an escalation_matrix rule. Compute case age (now - opened_at) and
//   determine the highest level (L1/L2/L3) due — the levels above the
//   case's last-dispatched level (looked up from the dispatch log via
//   reference=case:<case_id>+trigger=escalation_worker).
//
//   For each due level, render the scenario's notification_template
//   (when set) with case context vars + emit one DueEscalation. The
//   caller (route layer) decides whether to dispatch or just preview.
//
// Idempotency: the dispatch log is the source of truth for "which
// levels already fired". A second tick at the same time produces zero
// dispatches — same set already logged.

import type {
  CaseScenario,
  EscalationMatrixRule,
  NotificationTemplate,
} from './case_scenarios_types';
import type {
  CaseScenarioStore,
} from './case_scenarios_store';
import type {
  EscalationMatrixStore,
} from './escalation_matrix_store';
import type {
  NotificationTemplateStore,
} from './notification_templates_store';
import type {
  DispatchEntry,
  NotificationDispatchStore,
} from './notification_dispatch_store';
import { renderTemplate } from './notification_template_render';

// ─── Public input types ──────────────────────────────────────────────

/** Open-case shape the worker iterates. The caller (route or future
 *  cron worker) shapes its case source into this — keeps the helper
 *  decoupled from the CMS case store schema. */
export interface OpenCaseRef {
  case_id: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  /** ISO timestamp when the case was opened. Used to compute age. */
  opened_at: string;
  /** Optional — if the case carries a customer name etc., pass it
   *  through so the rendered template can use {{customer_name}}.
   *  Free-form bag; merged into the render context. */
  context_vars?: Record<string, unknown>;
}

export interface EscalationWorkerDeps {
  scenarioStore: Pick<CaseScenarioStore, 'list'>;
  escalationMatrixStore: Pick<EscalationMatrixStore, 'get'>;
  templateStore: Pick<NotificationTemplateStore, 'get'>;
  dispatchStore: NotificationDispatchStore;
}

// ─── Output shapes ───────────────────────────────────────────────────

/** One per (case, level) that's due to fire. Either dispatched or
 *  skipped depending on whether the route is preview vs tick. */
export interface DueEscalation {
  case_id: string;
  case_category: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  /** 1, 2, or 3 — which escalation level is due. */
  level: 1 | 2 | 3;
  /** RBAC role to escalate to (from the matrix rule's level_*_role). */
  role: string;
  /** Minutes-since-open at which this level should fire. Useful for
   *  the preview UI to show "would fire at +60m" labels. */
  after_minutes: number;
  /** Minutes the case has been open at the resolution moment. */
  case_age_minutes: number;
  /** The matched scenario + escalation rule + (optional) template ids
   *  so the SPA can deep-link. */
  scenario_id: string;
  escalation_id: string;
  template_id: string | null;
  template_name: string;
  /** Channel of the rendered notification. When no template is wired,
   *  defaults to IN_APP so the dispatch log row still satisfies the
   *  channel ↔ subject CHECK (EMAIL/IN_APP require non-null subject). */
  channel: 'EMAIL' | 'SMS' | 'IN_APP';
  /** Pre-rendered subject + body. NULL only when channel = SMS (DB
   *  CHECK). For no-template cases we synthesize a placeholder so the
   *  audit trail still records the escalation event. */
  rendered_subject: string | null;
  rendered_body: string;
  /** Mustache vars that were referenced but unset. */
  missing_vars: string[];
}

export interface ComputeDueResult {
  due: DueEscalation[];
  /** Diagnostic counts so the route can return useful numbers without
   *  the caller having to walk the array. */
  cases_inspected: number;
  cases_with_no_scenario: number;
  cases_with_archived_escalation: number;
}

// ─── Pure resolver ───────────────────────────────────────────────────

/**
 * Compute everything that's due to fire for the given tenant + open
 * cases at `now`. Pure-data input + output — no IO. The route handler
 * loads scenarios/matrix/templates from the store layer once per tick
 * (cheaper than per-case lookups) and passes them in.
 *
 * Idempotency note: this resolver does NOT consult the dispatch log.
 * The route layer does that lookup + filters out already-dispatched
 * (case_id, level) pairs before calling dispatchDueEscalations(). This
 * keeps the resolver fully testable without a dispatch store mock.
 */
export async function computeDueEscalations(
  tenant_id: string,
  cases: OpenCaseRef[],
  scenarios: CaseScenario[],
  resolveEscalation: (id: string) => Promise<EscalationMatrixRule | null>,
  resolveTemplate: (id: string) => Promise<NotificationTemplate | null>,
  now: Date,
): Promise<ComputeDueResult> {
  const due: DueEscalation[] = [];
  const nowMs = now.getTime();
  let no_scenario = 0;
  let archived_esc = 0;

  for (const c of cases) {
    // Match a scenario on (case_category, priority). Newest ACTIVE wins
    // when multiple are configured for the same combo.
    const matches = scenarios.filter(
      (s) =>
        s.status === 'ACTIVE' &&
        s.case_category === c.case_category &&
        s.priority === c.priority,
    );
    if (matches.length === 0) {
      no_scenario++;
      continue;
    }
    matches.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const scenario = matches[0]!;

    // Resolve the scenario's escalation matrix rule.
    const rule = await resolveEscalation(scenario.default_escalation_id);
    if (!rule || rule.status !== 'ACTIVE') {
      archived_esc++;
      continue;
    }

    // Optionally pre-render the scenario's notification template.
    const tpl = scenario.notification_template_id
      ? await resolveTemplate(scenario.notification_template_id)
      : null;
    const tplActive = tpl && tpl.deleted_at === null && tpl.status === 'ACTIVE';

    const ageMinutes = Math.floor((nowMs - new Date(c.opened_at).getTime()) / 60_000);

    // Build the render context: case attrs + caller's free-form bag.
    const renderVars: Record<string, unknown> = {
      case_id: c.case_id,
      case_number: c.case_id,
      case_category: c.case_category,
      priority: c.priority,
      case_age_minutes: ageMinutes,
      ...(c.context_vars ?? {}),
    };

    // Evaluate each level — emit one DueEscalation per level whose
    // after_minutes window is met. The route's idempotency check then
    // filters out already-dispatched (case, level) pairs.
    const levels: Array<{ level: 1 | 2 | 3; after: number; role: string | null }> = [
      { level: 1, after: rule.level_1_after_minutes, role: rule.level_1_role },
      { level: 2, after: rule.level_2_after_minutes ?? -1, role: rule.level_2_role },
      { level: 3, after: rule.level_3_after_minutes ?? -1, role: rule.level_3_role },
    ];

    for (const lv of levels) {
      if (lv.after < 0 || lv.role === null) continue;
      if (ageMinutes < lv.after) continue;

      // Default to IN_APP placeholder when no template is wired so the
      // dispatch log row satisfies the channel ↔ subject CHECK
      // (EMAIL/IN_APP require non-null subject).
      let channel: 'EMAIL' | 'SMS' | 'IN_APP' = 'IN_APP';
      let template_name = '(no template)';
      let rendered_subject: string | null = '(no template configured for scenario)';
      let rendered_body = `Case ${c.case_id} reached escalation L${lv.level} (${lv.after}m) → role ${lv.role}`;
      let missing_vars: string[] = [];
      if (tplActive && tpl) {
        channel = tpl.channel;
        template_name = tpl.name;
        const r = renderTemplate(tpl, {
          tenant_id,
          vars: { ...renderVars, escalation_role: lv.role, escalation_level: lv.level },
        });
        rendered_subject = r.subject;
        rendered_body = r.body;
        missing_vars = r.missing_vars;
      }

      due.push({
        case_id: c.case_id,
        case_category: c.case_category,
        priority: c.priority,
        level: lv.level,
        role: lv.role,
        after_minutes: lv.after,
        case_age_minutes: ageMinutes,
        scenario_id: scenario.scenario_id,
        escalation_id: rule.escalation_id,
        template_id: tplActive ? scenario.notification_template_id : null,
        template_name,
        channel,
        rendered_subject,
        rendered_body,
        missing_vars,
      });
    }
  }

  return {
    due,
    cases_inspected: cases.length,
    cases_with_no_scenario: no_scenario,
    cases_with_archived_escalation: archived_esc,
  };
}

// ─── Idempotency: filter out already-dispatched (case, level) pairs ─

/**
 * Look at the dispatch log for the given tenant + scope, find the
 * highest level already dispatched per case, and filter the due-list
 * down to NEW levels only. The reference field on a dispatch is the
 * convention `case:<case_id>:lvl:<n>` (set by dispatchDueEscalations
 * below) — exact-match per (case, level).
 */
export async function filterAlreadyDispatched(
  tenant_id: string,
  due: DueEscalation[],
  dispatchStore: NotificationDispatchStore,
): Promise<DueEscalation[]> {
  if (due.length === 0) return [];
  // Pull every escalation_worker dispatch in the tenant within a
  // reasonable window. The dispatch log is FIFO-capped at 500 (in-mem)
  // / unbounded (PG); for the prototype, scanning the recent set is
  // fine. Production would use ?reference=case:<id>:lvl:* style.
  const recent = await dispatchStore.list(tenant_id, {
    trigger: 'escalation_worker',
    page_size: 200,
  });
  const fired = new Set(recent.items.map((e) => e.reference).filter(Boolean));
  return due.filter((d) => !fired.has(`case:${d.case_id}:lvl:${d.level}`));
}

// ─── Dispatch ─────────────────────────────────────────────────────────

/**
 * Append one dispatch log entry per due escalation. Returns the
 * appended entries so the route can return them. No-ops when due is
 * empty.
 */
export async function dispatchDueEscalations(
  tenant_id: string,
  due: DueEscalation[],
  dispatchStore: NotificationDispatchStore,
  now: Date,
  performed_by: string,
): Promise<DispatchEntry[]> {
  const out: DispatchEntry[] = [];
  for (const d of due) {
    const entry = await dispatchStore.append(
      tenant_id,
      {
        template_id: d.template_id ?? '00000000-0000-0000-0000-000000000000',
        template_name: d.template_name,
        channel: d.channel,
        recipient: `role:${d.role}`,
        trigger: 'escalation_worker',
        reference: `case:${d.case_id}:lvl:${d.level}`,
        rendered_subject: d.rendered_subject,
        rendered_body: d.rendered_body,
        missing_vars: d.missing_vars,
        status: 'sent',
        status_reason:
          d.missing_vars.length > 0
            ? `dispatched with ${d.missing_vars.length} missing var(s)`
            : null,
        performed_by,
      },
      now,
    );
    out.push(entry);
  }
  return out;
}
