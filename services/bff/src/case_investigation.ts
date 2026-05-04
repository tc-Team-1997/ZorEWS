// services/bff/src/case_investigation.ts
//
// T6 M9.1 — BIL Case Investigation tracker.
//
// Module 9 (Case Management) had shipped surface from T4.10
// (`/v1/cases/sla-summary`, `/v1/action` for logging). What was
// missing for the BIL pitch deck:
//   - An investigation workflow on top of a case (triage → gather
//     evidence → decision → close) that operations can drive day-to-
//     day on suspected claim-fraud cases.
//   - A standard evidence checklist so the SPA can render progress
//     and audit can verify "did the investigator do the steps".
//   - Notes (free-text discussion thread) attached to an investigation.
//
// Distinct from the existing case-events stream — that's an immutable
// audit log of state transitions. Investigations are the *workflow
// container* a case is being worked through. One case → at most one
// open investigation at a time; investigations can re-open.

import { randomUUID } from 'node:crypto';

// ─── Public types ──────────────────────────────────────────────────────

export type InvestigationStatus =
  | 'triage'
  | 'gathering_evidence'
  | 'awaiting_response'
  | 'review'
  | 'decision'
  | 'closed';

export type InvestigationDecision =
  | 'fraud_confirmed'
  | 'fraud_unsubstantiated'
  | 'partial_fraud'
  | 'data_quality'
  | null;

export interface InvestigationStep {
  step_id: string;
  name: string;
  description: string;
  completed: boolean;
  completed_at: string | null;
  completed_by: string | null;
  /** Optional pointer to evidence (URL, doc id, AML match id, etc). */
  evidence_link: string | null;
}

export interface InvestigationNote {
  note_id: string;
  ts: string;
  author: string;
  body: string;
}

export interface CaseInvestigation {
  investigation_id: string;
  tenant_id: string;
  case_id: string;
  customer_id: string;
  status: InvestigationStatus;
  /** null until status='closed'. */
  decision: InvestigationDecision;
  opened_at: string;
  opened_by: string;
  last_updated_at: string;
  last_updated_by: string;
  /** ISO timestamp when status='closed' was applied. null otherwise. */
  closed_at: string | null;
  steps: InvestigationStep[];
  notes_count: number;
}

export interface OpenInvestigationInput {
  case_id: string;
  customer_id: string;
}

export interface ListFilters {
  status?: InvestigationStatus;
  case_id?: string;
  customer_id?: string;
  page?: number;
  page_size?: number;
}

export interface InvestigationPage {
  items: CaseInvestigation[];
  page: number;
  page_size: number;
  total: number;
}

export interface CaseInvestigationStore {
  open(tenant_id: string, input: OpenInvestigationInput, opened_by: string, now: Date): CaseInvestigation;
  get(tenant_id: string, investigation_id: string): CaseInvestigation | null;
  list(tenant_id: string, filters: ListFilters): InvestigationPage;
  updateStatus(
    tenant_id: string,
    investigation_id: string,
    status: InvestigationStatus,
    decision: InvestigationDecision,
    updated_by: string,
    now: Date,
  ): CaseInvestigation;
  completeStep(
    tenant_id: string,
    investigation_id: string,
    step_id: string,
    completed_by: string,
    evidence_link: string | null,
    now: Date,
  ): CaseInvestigation;
  addNote(
    tenant_id: string,
    investigation_id: string,
    author: string,
    body: string,
    now: Date,
  ): { note: InvestigationNote; investigation: CaseInvestigation };
  listNotes(tenant_id: string, investigation_id: string): InvestigationNote[];
}

export class InvestigationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'InvestigationError';
  }
}

// ─── Schema ────────────────────────────────────────────────────────────

const VALID_STATUSES: InvestigationStatus[] = [
  'triage',
  'gathering_evidence',
  'awaiting_response',
  'review',
  'decision',
  'closed',
];

const VALID_DECISIONS: NonNullable<InvestigationDecision>[] = [
  'fraud_confirmed',
  'fraud_unsubstantiated',
  'partial_fraud',
  'data_quality',
];

export function isInvestigationStatus(s: unknown): s is InvestigationStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as InvestigationStatus);
}
export function isInvestigationDecision(s: unknown): s is NonNullable<InvestigationDecision> {
  return typeof s === 'string' && VALID_DECISIONS.includes(s as NonNullable<InvestigationDecision>);
}

/**
 * State machine — defines which transitions are legal. Re-opening a
 * closed investigation requires going back to `gathering_evidence` to
 * make the audit trail explicit. closed→closed is a no-op (allowed).
 */
const TRANSITIONS: Record<InvestigationStatus, InvestigationStatus[]> = {
  triage: ['gathering_evidence', 'closed'],
  gathering_evidence: ['awaiting_response', 'review', 'closed'],
  awaiting_response: ['gathering_evidence', 'review', 'closed'],
  review: ['decision', 'gathering_evidence'],
  decision: ['closed', 'review'],
  closed: ['gathering_evidence', 'closed'],
};

export function canTransition(from: InvestigationStatus, to: InvestigationStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── BIL standard 8-step claim-fraud checklist ────────────────────────
//
// Sourced from DataNetworks-EWS-Ver1.pdf §17 — the standard ops checklist
// every fraud investigation walks through. M9.2 will let admins customise
// per-tenant; M9.1 ships the platform default.

const STEP_TEMPLATE: ReadonlyArray<Pick<InvestigationStep, 'step_id' | 'name' | 'description'>> = [
  {
    step_id: 'verify_identity',
    name: 'Verify customer identity',
    description: 'Cross-check submitted ID + KYC documents against the case profile',
  },
  {
    step_id: 'pull_policy_history',
    name: 'Pull policy + claim history',
    description: 'Fetch full policy + all prior claims via Policy Master + Claims feed',
  },
  {
    step_id: 'aml_screen',
    name: 'Run AML screening',
    description: 'Hit /v1/integrations/aml/screen and log any matches against this case',
  },
  {
    step_id: 'review_documents',
    name: 'Review submitted documents',
    description: 'Inspect claim form, medical records, repair quotes for inconsistencies',
  },
  {
    step_id: 'check_red_flags',
    name: 'Check fraud red flags',
    description: 'Run the BIL §10 indicator catalogue checklist against the customer',
  },
  {
    step_id: 'interview_claimant',
    name: 'Interview claimant',
    description: 'Schedule + record claimant interview; flag inconsistencies',
  },
  {
    step_id: 'site_inspection',
    name: 'Site inspection (if applicable)',
    description: 'For property/motor claims — physical inspection by an assessor',
  },
  {
    step_id: 'final_recommendation',
    name: 'Document recommendation',
    description: 'Investigator writes a final recommendation (approve / repudiate / partial)',
  },
];

export function defaultSteps(): InvestigationStep[] {
  return STEP_TEMPLATE.map((s) => ({
    ...s,
    completed: false,
    completed_at: null,
    completed_by: null,
    evidence_link: null,
  }));
}

// ─── In-memory store ───────────────────────────────────────────────────

interface TenantState {
  /** investigation_id → record. */
  byId: Map<string, CaseInvestigation>;
  /** investigation_id → note[]. */
  notes: Map<string, InvestigationNote[]>;
}

export class InMemoryCaseInvestigationStore implements CaseInvestigationStore {
  private readonly state = new Map<string, TenantState>();

  open(
    tenant_id: string,
    input: OpenInvestigationInput,
    opened_by: string,
    now: Date,
  ): CaseInvestigation {
    if (!input || typeof input !== 'object') {
      throw new InvestigationError('invalid_input', 'request body required');
    }
    if (typeof input.case_id !== 'string' || !input.case_id.trim()) {
      throw new InvestigationError('invalid_input', 'case_id is required');
    }
    if (typeof input.customer_id !== 'string' || !input.customer_id.trim()) {
      throw new InvestigationError('invalid_input', 'customer_id is required');
    }

    const ts = this.tState(tenant_id);
    // Refuse to open a 2nd active investigation for a case — must close
    // the existing one first. Keeps the audit trail unambiguous.
    for (const existing of ts.byId.values()) {
      if (existing.case_id === input.case_id && existing.status !== 'closed') {
        throw new InvestigationError(
          'investigation_already_open',
          `case ${input.case_id} already has an open investigation: ${existing.investigation_id}`,
        );
      }
    }

    const investigation: CaseInvestigation = {
      investigation_id: `inv-${randomUUID()}`,
      tenant_id,
      case_id: input.case_id,
      customer_id: input.customer_id,
      status: 'triage',
      decision: null,
      opened_at: now.toISOString(),
      opened_by,
      last_updated_at: now.toISOString(),
      last_updated_by: opened_by,
      closed_at: null,
      steps: defaultSteps(),
      notes_count: 0,
    };
    ts.byId.set(investigation.investigation_id, investigation);
    ts.notes.set(investigation.investigation_id, []);
    return investigation;
  }

  get(tenant_id: string, investigation_id: string): CaseInvestigation | null {
    return this.state.get(tenant_id)?.byId.get(investigation_id) ?? null;
  }

  list(tenant_id: string, filters: ListFilters): InvestigationPage {
    const ts = this.state.get(tenant_id);
    const all = ts ? [...ts.byId.values()] : [];
    const filtered = all.filter((inv) => {
      if (filters.status !== undefined && inv.status !== filters.status) return false;
      if (filters.case_id !== undefined && inv.case_id !== filters.case_id) return false;
      if (filters.customer_id !== undefined && inv.customer_id !== filters.customer_id) return false;
      return true;
    });
    // newest opened_at first
    filtered.sort((a, b) => b.opened_at.localeCompare(a.opened_at));
    const page = Math.max(1, filters.page ?? 1);
    const page_size = Math.max(1, Math.min(200, filters.page_size ?? 50));
    const start = (page - 1) * page_size;
    return {
      items: filtered.slice(start, start + page_size),
      page,
      page_size,
      total: filtered.length,
    };
  }

  updateStatus(
    tenant_id: string,
    investigation_id: string,
    status: InvestigationStatus,
    decision: InvestigationDecision,
    updated_by: string,
    now: Date,
  ): CaseInvestigation {
    if (!isInvestigationStatus(status)) {
      throw new InvestigationError('invalid_status', `invalid status: ${status}`);
    }
    if (decision !== null && !isInvestigationDecision(decision)) {
      throw new InvestigationError('invalid_decision', `invalid decision: ${decision}`);
    }
    const inv = this.requireInvestigation(tenant_id, investigation_id);
    if (!canTransition(inv.status, status)) {
      throw new InvestigationError(
        'invalid_transition',
        `cannot transition from ${inv.status} to ${status}`,
      );
    }
    // Decision is required when closing from a decision-aware path; allowed
    // null when closing from earlier states (e.g. case dismissed pre-review).
    if (status === 'closed' && inv.status === 'decision' && decision === null) {
      throw new InvestigationError(
        'decision_required',
        'decision is required when closing from review/decision',
      );
    }
    const updated: CaseInvestigation = {
      ...inv,
      status,
      decision: status === 'closed' ? decision : decision ?? inv.decision,
      last_updated_at: now.toISOString(),
      last_updated_by: updated_by,
      // close→stamp now; re-opening clears closed_at.
      closed_at: status === 'closed' ? now.toISOString() : null,
    };
    this.state.get(tenant_id)!.byId.set(investigation_id, updated);
    return updated;
  }

  completeStep(
    tenant_id: string,
    investigation_id: string,
    step_id: string,
    completed_by: string,
    evidence_link: string | null,
    now: Date,
  ): CaseInvestigation {
    const inv = this.requireInvestigation(tenant_id, investigation_id);
    if (inv.status === 'closed') {
      throw new InvestigationError(
        'closed',
        'cannot complete steps on a closed investigation — re-open first',
      );
    }
    const idx = inv.steps.findIndex((s) => s.step_id === step_id);
    if (idx === -1) {
      throw new InvestigationError('unknown_step', `unknown step: ${step_id}`);
    }
    if (inv.steps[idx]!.completed) {
      throw new InvestigationError('step_already_completed', `step ${step_id} already completed`);
    }
    const newSteps = inv.steps.map((s, i) =>
      i === idx
        ? {
            ...s,
            completed: true,
            completed_at: now.toISOString(),
            completed_by,
            evidence_link,
          }
        : s,
    );
    const updated: CaseInvestigation = {
      ...inv,
      steps: newSteps,
      last_updated_at: now.toISOString(),
      last_updated_by: completed_by,
    };
    this.state.get(tenant_id)!.byId.set(investigation_id, updated);
    return updated;
  }

  addNote(
    tenant_id: string,
    investigation_id: string,
    author: string,
    body: string,
    now: Date,
  ): { note: InvestigationNote; investigation: CaseInvestigation } {
    if (typeof body !== 'string' || !body.trim()) {
      throw new InvestigationError('invalid_input', 'note body is required');
    }
    if (body.length > 4000) {
      throw new InvestigationError('note_too_long', 'note body must be ≤ 4000 chars');
    }
    const inv = this.requireInvestigation(tenant_id, investigation_id);
    const note: InvestigationNote = {
      note_id: `note-${randomUUID()}`,
      ts: now.toISOString(),
      author,
      body,
    };
    const ts = this.state.get(tenant_id)!;
    let arr = ts.notes.get(investigation_id);
    if (!arr) {
      arr = [];
      ts.notes.set(investigation_id, arr);
    }
    arr.push(note);
    const updated: CaseInvestigation = {
      ...inv,
      notes_count: arr.length,
      last_updated_at: now.toISOString(),
      last_updated_by: author,
    };
    ts.byId.set(investigation_id, updated);
    return { note, investigation: updated };
  }

  listNotes(tenant_id: string, investigation_id: string): InvestigationNote[] {
    const inv = this.state.get(tenant_id)?.byId.get(investigation_id);
    if (!inv) {
      throw new InvestigationError('unknown_investigation', `unknown investigation: ${investigation_id}`);
    }
    const arr = this.state.get(tenant_id)!.notes.get(investigation_id) ?? [];
    return [...arr].reverse();
  }

  /** Test helper. */
  reset(): void {
    this.state.clear();
  }

  private tState(tenant_id: string): TenantState {
    let ts = this.state.get(tenant_id);
    if (!ts) {
      ts = { byId: new Map(), notes: new Map() };
      this.state.set(tenant_id, ts);
    }
    return ts;
  }

  private requireInvestigation(tenant_id: string, investigation_id: string): CaseInvestigation {
    const inv = this.state.get(tenant_id)?.byId.get(investigation_id);
    if (!inv) {
      throw new InvestigationError('unknown_investigation', `unknown investigation: ${investigation_id}`);
    }
    return inv;
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultCaseInvestigationStore: CaseInvestigationStore = new InMemoryCaseInvestigationStore();
