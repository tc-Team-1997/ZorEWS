// services/bff/src/investigation_step_progress.ts
//
// T6 M9.9 — Investigation step progress.
//
// M9.1 defines per-investigation checklist steps; M9.8 rolls them up
// at the cohort level (counts + means). M9.9 is the per-investigation
// step granularity view: how many of the 8 steps are done on THIS
// case, which step is the bottleneck across ALL cases, etc. Two pure
// surfaces:
//
//   summariseInvestigationSteps(inv)   — single-case progress card
//   listInvestigationStepBacklog(invs) — fleet-wide "where do cases
//                                       get stuck?" backlog
//
// Pure — no I/O. Caller passes the loaded investigations.

import type { CaseInvestigation, InvestigationStep } from './case_investigation';

// ─── Public types ─────────────────────────────────────────────────────

export interface RecentCompletion {
  step_id: string;
  completed_at: string;
  completed_by: string | null;
}

export interface InvestigationStepProgress {
  investigation_id: string;
  case_id: string;
  status: string;
  total_steps: number;
  completed_count: number;
  pending_count: number;
  /** 0..1 — completed_count / total_steps. 0 when total_steps=0. */
  completion_rate: number;
  /** First (by step order) step that's still pending. null when
   *  every step is completed OR the investigation has no steps. */
  oldest_pending_step: {
    step_id: string;
    name: string;
    description: string;
  } | null;
  /** Newest 5 completions for the timeline view. Sorted newest-first. */
  recent_completions: RecentCompletion[];
}

export interface StepBacklogEntry {
  step_id: string;
  name: string;
  /** Cases where this step is not yet completed. */
  pending_count: number;
  /** Cases where this step IS completed. */
  completed_count: number;
  /** Total cases this step appears in (some checklists may omit it). */
  cases_with_step: number;
  /** Cases where the investigation is still open AND this step is
   *  pending. Surfaces the actual bottleneck — completed cases don't
   *  count, neither do pending steps on closed cases. */
  open_pending_count: number;
}

export interface InvestigationStepBacklog {
  total_investigations: number;
  open_investigations: number;
  /** One entry per distinct step_id across the cohort, sorted by
   *  open_pending_count desc with step_id asc tie-break — biggest
   *  bottleneck first. */
  entries: StepBacklogEntry[];
}

// ─── Pure summariser (single investigation) ──────────────────────────

export function summariseInvestigationSteps(
  inv: CaseInvestigation,
): InvestigationStepProgress {
  const total = inv.steps.length;
  const completed = inv.steps.filter((s) => s.completed);
  const completed_count = completed.length;
  const pending_count = total - completed_count;
  // oldest_pending_step is the first step (by array order = step order)
  // that's still pending.
  const firstPending = inv.steps.find((s) => !s.completed) ?? null;
  // Recent completions newest-first.
  const sortedCompletions = [...completed]
    .filter((s) => s.completed_at !== null)
    .sort((a, b) =>
      a.completed_at! < b.completed_at! ? 1 : a.completed_at! > b.completed_at! ? -1 : 0,
    )
    .slice(0, 5)
    .map((s) => ({
      step_id: s.step_id,
      completed_at: s.completed_at!,
      completed_by: s.completed_by,
    }));
  return {
    investigation_id: inv.investigation_id,
    case_id: inv.case_id,
    status: inv.status,
    total_steps: total,
    completed_count,
    pending_count,
    completion_rate: total > 0 ? completed_count / total : 0,
    oldest_pending_step: firstPending
      ? {
          step_id: firstPending.step_id,
          name: firstPending.name,
          description: firstPending.description,
        }
      : null,
    recent_completions: sortedCompletions,
  };
}

// ─── Pure aggregator (fleet backlog) ─────────────────────────────────

interface BacklogAcc {
  step_id: string;
  name: string;
  pending_count: number;
  completed_count: number;
  cases_with_step: number;
  open_pending_count: number;
}

export function listInvestigationStepBacklog(
  investigations: readonly CaseInvestigation[],
): InvestigationStepBacklog {
  const byStep = new Map<string, BacklogAcc>();
  let open = 0;
  for (const inv of investigations) {
    const isOpen = inv.status !== 'closed';
    if (isOpen) open += 1;
    for (const step of inv.steps) {
      let acc = byStep.get(step.step_id);
      if (!acc) {
        acc = {
          step_id: step.step_id,
          name: step.name,
          pending_count: 0,
          completed_count: 0,
          cases_with_step: 0,
          open_pending_count: 0,
        };
        byStep.set(step.step_id, acc);
      }
      acc.cases_with_step += 1;
      if (step.completed) acc.completed_count += 1;
      else {
        acc.pending_count += 1;
        if (isOpen) acc.open_pending_count += 1;
      }
    }
  }
  const entries = [...byStep.values()].sort((a, b) => {
    if (b.open_pending_count !== a.open_pending_count) {
      return b.open_pending_count - a.open_pending_count;
    }
    return a.step_id < b.step_id ? -1 : a.step_id > b.step_id ? 1 : 0;
  });
  return {
    total_investigations: investigations.length,
    open_investigations: open,
    entries,
  };
}
