// services/regulatory-svc/cases/src/service.ts
//
// CaseService — the integration layer. Combines store (persistence),
// state machine (transition validation), and producer (case.events
// outbox). Pure service object, no HTTP — server.ts wires it to Express.

import {
  deterministicCaseId,
  newActionId,
  newCapId,
  newCasId,
  newEventId,
} from './case_id';
import { validateOrThrow } from './event_validator';
import { OutboxCaseProducer } from './producer';
import { nextState, type Transition } from './state_machine';
import { type ICaseStore, type ListFilters } from './store';
import { ApprovalsClient } from './approvals';
import type {
  Action,
  ActionKind,
  AlertSummary,
  ApproveCapInput,
  Cap,
  Case,
  CaseEvent,
  CaseState,
  CasRecord,
  Gps,
  CloseCapInput,
  Outcome,
  ProposeCapInput,
  ReviewCasInput,
  SubmitCasInput,
} from './types';

export const CASE_TOPIC = 'apex.case.events';

export interface ServiceDeps {
  store: ICaseStore;
  producer: OutboxCaseProducer;
  /** Override clock for tests. */
  now?: () => Date;
  topic?: string;
  /**
   * Cross-cutting maker-checker fan-out (T4.20). Defaults to a no-op
   * client so the in-memory CaseStore code path runs with no pg
   * dependency. The pg-backed bootstrap should pass an
   * `ApprovalsClient(pool)` to enable the fan-out into
   * `app_audit.approvals`.
   */
  approvals?: ApprovalsClient;
}

export interface LogActionInput {
  kind: ActionKind;
  officer_id: string;
  outcome_note?: string | null;
  gps?: Gps | null;
}

export interface CloseInput {
  outcome: Outcome;
  note?: string | null;
}

export class CaseService {
  private readonly store: ICaseStore;
  private readonly producer: OutboxCaseProducer;
  private readonly now: () => Date;
  private readonly topic: string;
  private readonly approvals: ApprovalsClient;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.producer = deps.producer;
    this.now = deps.now ?? (() => new Date());
    this.topic = deps.topic ?? CASE_TOPIC;
    this.approvals = deps.approvals ?? ApprovalsClient.noop();
  }

  /**
   * Create a case from an alert summary. Idempotent on alert_id — repeated
   * calls return the existing case (and emit no further event), so an
   * at-least-once alert delivery cannot create duplicate cases.
   */
  async createFromAlert(
    alert: AlertSummary,
    tenant_id: string = 'BANK_DEMO',
  ): Promise<{ case: Case; created: boolean }> {
    const existing = this.store.getByAlert(alert.alert_id, tenant_id);
    if (existing) return { case: existing, created: false };

    const ts = this.now().toISOString();
    const c: Case = {
      case_id: deterministicCaseId(alert.alert_id, alert.customer_id),
      tenant_id,
      alert_id: alert.alert_id,
      customer_id: alert.customer_id,
      loan_id: alert.loan_id ?? null,
      severity: alert.severity,
      rule_id: alert.rule_id,
      reason_summary: alert.reason_summary ?? null,
      state: 'open',
      assignee: null,
      outcome: null,
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      actions: [],
      cas_records: [],
      caps: [],
    };
    this.store.upsert(c);
    await this.emit(c, null, 'case.created', { severity: alert.severity });
    return { case: c, created: true };
  }

  async assign(caseId: string, userId: string, tenant_id: string = 'BANK_DEMO'): Promise<Case> {
    const c = this.requireCase(caseId, tenant_id);
    const prior = c.state;
    const newState = nextState(prior, 'assign');
    const updated: Case = {
      ...c,
      state: newState,
      assignee: userId,
      updated_at: this.now().toISOString(),
    };
    this.store.upsert(updated);
    await this.emit(updated, prior, 'case.assigned', { user_id: userId });
    return updated;
  }

  async logAction(caseId: string, input: LogActionInput, tenant_id: string = 'BANK_DEMO'): Promise<Case> {
    const c = this.requireCase(caseId, tenant_id);
    const prior = c.state;
    // logAction is the only transition allowed from `assigned`, `in_action`,
    // and `monitored`; all three resolve to in_action.
    const newState = nextState(prior, 'logAction');
    const ts = this.now().toISOString();
    const action: Action = {
      action_id: newActionId(this.now),
      ts,
      kind: input.kind,
      officer_id: input.officer_id,
      outcome_note: input.outcome_note ?? null,
      gps: input.gps ?? null,
    };
    const updated: Case = {
      ...c,
      state: newState,
      updated_at: ts,
      actions: [...c.actions, action],
    };
    this.store.upsert(updated);
    await this.emit(updated, prior, 'case.action_logged', {
      action_id: action.action_id,
      kind: action.kind,
      officer_id: action.officer_id,
      gps: action.gps,
    });
    return updated;
  }

  async monitor(caseId: string, tenant_id: string = 'BANK_DEMO'): Promise<Case> {
    const c = this.requireCase(caseId, tenant_id);
    const prior = c.state;
    const newState = nextState(prior, 'monitor');
    const updated: Case = {
      ...c,
      state: newState,
      updated_at: this.now().toISOString(),
    };
    this.store.upsert(updated);
    await this.emit(updated, prior, 'case.monitored', {});
    return updated;
  }

  async close(caseId: string, input: CloseInput, tenant_id: string = 'BANK_DEMO'): Promise<Case> {
    const c = this.requireCase(caseId, tenant_id);
    // BAC-A manual §3.1.5: "Once all the CAPs are closed then only the
    // case can be closed." Refuse the close transition if any CAP is
    // still open or in_progress (overdue counts as still-open). Closed
    // and rejected CAPs don't block.
    const blocking = (c.caps ?? []).filter(
      (cap) => cap.status === 'open' || cap.status === 'in_progress' || cap.status === 'overdue',
    );
    if (blocking.length > 0) {
      const err = new Error(
        `cannot close case ${caseId}: ${blocking.length} CAP(s) still open (${blocking.map((b) => b.cap_id).join(', ')})`,
      ) as Error & { status?: number };
      err.status = 409;
      throw err;
    }
    const prior = c.state;
    const newState = nextState(prior, 'close');
    const ts = this.now().toISOString();
    const updated: Case = {
      ...c,
      state: newState,
      outcome: input.outcome,
      updated_at: ts,
      closed_at: ts,
    };
    this.store.upsert(updated);
    await this.emit(updated, prior, 'case.closed', {
      outcome: input.outcome,
      note: input.note ?? null,
    });
    return updated;
  }

  // ─── CAS — Causal Analysis Stage (BAC-A manual §3.1.5) ──────────────────

  /**
   * Submit a Causal Analysis Stage record. Maker (RM) provides cause
   * + severity + decision. The record lands in `review_status='pending'`
   * — it has no effect on the case until a checker calls reviewCas().
   * Throws 404 if the case doesn't exist.
   */
  async submitCas(caseId: string, input: SubmitCasInput, tenant_id: string = 'BANK_DEMO'): Promise<CasRecord> {
    const c = this.requireCase(caseId, tenant_id);
    const ts = this.now().toISOString();
    const cas: CasRecord = {
      cas_id: newCasId(this.now),
      case_id: caseId,
      cause_type: input.cause_type,
      cause_summary: input.cause_summary,
      severity_assessment: input.severity_assessment,
      decision: input.decision,
      submitted_by: input.submitted_by,
      submitted_at: ts,
      reviewed_by: null,
      reviewed_at: null,
      review_status: 'pending',
      review_comments: null,
      attachments: input.attachments ?? [],
    };
    const updated: Case = {
      ...c,
      updated_at: ts,
      cas_records: [...(c.cas_records ?? []), cas],
    };
    this.store.upsert(updated);
    await this.emit(updated, c.state, 'case.cas_submitted', {
      cas_id: cas.cas_id,
      decision: cas.decision,
      severity_assessment: cas.severity_assessment,
      submitted_by: cas.submitted_by,
    });
    // Fan out to the cross-cutting approvals log (T4.20).
    void this.approvals.propose({
      subject_type: 'cas',
      subject_id: cas.cas_id,
      action: 'submit',
      maker: cas.submitted_by,
      payload: {
        cause_type: cas.cause_type,
        cause_summary: cas.cause_summary,
        severity_assessment: cas.severity_assessment,
        decision: cas.decision,
      },
      correlation_id: caseId,
    });
    return cas;
  }

  /**
   * Review a pending CAS — checker either approves, rejects, or returns
   * for rework. Throws 404 if the CAS doesn't exist on the case; 409 if
   * the CAS is already reviewed. On approval with decision='close_case'
   * the caller can subsequently invoke close(); on decision='proceed_to_cap'
   * the caller is expected to call proposeCap().
   */
  async reviewCas(caseId: string, casId: string, input: ReviewCasInput, tenant_id: string = 'BANK_DEMO'): Promise<CasRecord> {
    const c = this.requireCase(caseId, tenant_id);
    const idx = (c.cas_records ?? []).findIndex((cas) => cas.cas_id === casId);
    if (idx < 0) throw httpError(404, `cas ${casId} not found on case ${caseId}`);
    const existing = c.cas_records[idx];
    if (existing.review_status !== 'pending') {
      throw httpError(409, `cas ${casId} already reviewed (${existing.review_status})`);
    }
    const ts = this.now().toISOString();
    const updatedCas: CasRecord = {
      ...existing,
      reviewed_by: input.reviewed_by,
      reviewed_at: ts,
      review_status: input.review_status,
      review_comments: input.review_comments ?? null,
    };
    const newRecords = [...c.cas_records];
    newRecords[idx] = updatedCas;
    const updated: Case = {
      ...c,
      updated_at: ts,
      cas_records: newRecords,
    };
    this.store.upsert(updated);
    await this.emit(updated, c.state, 'case.cas_reviewed', {
      cas_id: casId,
      review_status: input.review_status,
      reviewed_by: input.reviewed_by,
      decision: existing.decision,
    });
    void this.approvals.review({
      subject_type: 'cas',
      subject_id: casId,
      checker: input.reviewed_by,
      decision: input.review_status,
      comments: input.review_comments ?? null,
    });
    return updatedCas;
  }

  // ─── CAP — Corrective Action Plan (BAC-A manual §3.1.5) ─────────────────

  /**
   * Propose a Corrective Action Plan. Maker (RM) sets the cap_item +
   * issue owner group + specific owner + priority + target completion
   * date. The CAP lands in status='open' — it has no operational effect
   * until a checker calls approveCap(). Multiple CAPs per case are fine.
   * Returns 404 if the case doesn't exist.
   */
  async proposeCap(caseId: string, input: ProposeCapInput, tenant_id: string = 'BANK_DEMO'): Promise<Cap> {
    const c = this.requireCase(caseId, tenant_id);
    const ts = this.now().toISOString();
    const cap: Cap = {
      cap_id: newCapId(this.now),
      case_id: caseId,
      cap_item: input.cap_item,
      issue_owner_group: input.issue_owner_group,
      issue_owner: input.issue_owner,
      issue_priority: input.issue_priority,
      target_completion_date: input.target_completion_date,
      status: 'open',
      proposed_by: input.proposed_by,
      proposed_at: ts,
      approved_by: null,
      approved_at: null,
      closed_at: null,
      closure_comments: null,
      attachments: input.attachments ?? [],
    };
    const updated: Case = {
      ...c,
      updated_at: ts,
      caps: [...(c.caps ?? []), cap],
    };
    this.store.upsert(updated);
    await this.emit(updated, c.state, 'case.cap_proposed', {
      cap_id: cap.cap_id,
      cap_item: cap.cap_item,
      issue_owner: cap.issue_owner,
      issue_priority: cap.issue_priority,
      target_completion_date: cap.target_completion_date,
    });
    void this.approvals.propose({
      subject_type: 'cap',
      subject_id: cap.cap_id,
      action: 'propose',
      maker: cap.proposed_by,
      payload: {
        cap_item: cap.cap_item,
        issue_owner_group: cap.issue_owner_group,
        issue_owner: cap.issue_owner,
        issue_priority: cap.issue_priority,
        target_completion_date: cap.target_completion_date,
      },
      correlation_id: caseId,
    });
    return cap;
  }

  /**
   * Checker reviews a proposed CAP. approve=true moves the CAP to
   * status='in_progress' and stamps approved_by / approved_at.
   * approve=false leaves the CAP in status='open' and the comments
   * carry the rejection reason — the maker can then update or replace
   * the CAP. Throws 404 if the CAP isn't on the case; 409 if it isn't
   * in status='open'.
   */
  async approveCap(caseId: string, capId: string, input: ApproveCapInput, tenant_id: string = 'BANK_DEMO'): Promise<Cap> {
    const c = this.requireCase(caseId, tenant_id);
    const idx = (c.caps ?? []).findIndex((cap) => cap.cap_id === capId);
    if (idx < 0) throw httpError(404, `cap ${capId} not found on case ${caseId}`);
    const existing = c.caps[idx];
    if (existing.status !== 'open') {
      throw httpError(409, `cap ${capId} cannot be approved (status=${existing.status})`);
    }
    const ts = this.now().toISOString();
    const updatedCap: Cap = {
      ...existing,
      status: input.approve ? 'in_progress' : 'open',
      approved_by: input.approve ? input.approved_by : existing.approved_by,
      approved_at: input.approve ? ts : existing.approved_at,
      // On rejection, surface the rejection reason in closure_comments
      // even though the CAP isn't closed — the maker needs to see why.
      closure_comments: input.approve
        ? existing.closure_comments
        : (input.comments ?? existing.closure_comments),
    };
    const newCaps = [...c.caps];
    newCaps[idx] = updatedCap;
    const updated: Case = {
      ...c,
      updated_at: ts,
      caps: newCaps,
    };
    this.store.upsert(updated);
    await this.emit(updated, c.state, 'case.cap_approved', {
      cap_id: capId,
      approved: input.approve,
      approved_by: input.approved_by,
      comments: input.comments ?? null,
    });
    void this.approvals.review({
      subject_type: 'cap',
      subject_id: capId,
      checker: input.approved_by,
      // approve=true → approved; approve=false → rework (the CAP stays
      // open and the maker can fix + re-fire). 'rejected' is a stronger
      // terminal state we'd use if we ever added a "permanently kill
      // this CAP" route.
      decision: input.approve ? 'approved' : 'rework',
      comments: input.comments ?? null,
    });
    return updatedCap;
  }

  /**
   * Issue Owner closes a CAP after implementing it. Status transitions
   * 'in_progress' → 'closed'. Throws 404 if the CAP isn't on the case;
   * 409 if the CAP isn't in_progress (open CAPs need approval first).
   */
  async closeCap(caseId: string, capId: string, input: CloseCapInput, tenant_id: string = 'BANK_DEMO'): Promise<Cap> {
    const c = this.requireCase(caseId, tenant_id);
    const idx = (c.caps ?? []).findIndex((cap) => cap.cap_id === capId);
    if (idx < 0) throw httpError(404, `cap ${capId} not found on case ${caseId}`);
    const existing = c.caps[idx];
    if (existing.status !== 'in_progress' && existing.status !== 'overdue') {
      throw httpError(
        409,
        `cap ${capId} cannot be closed from status=${existing.status} (must be in_progress or overdue)`,
      );
    }
    const ts = this.now().toISOString();
    const updatedCap: Cap = {
      ...existing,
      status: 'closed',
      closed_at: ts,
      closure_comments: input.closure_comments ?? existing.closure_comments,
    };
    const newCaps = [...c.caps];
    newCaps[idx] = updatedCap;
    const updated: Case = {
      ...c,
      updated_at: ts,
      caps: newCaps,
    };
    this.store.upsert(updated);
    await this.emit(updated, c.state, 'case.cap_closed', {
      cap_id: capId,
      closed_by: input.closed_by,
      closure_comments: input.closure_comments ?? null,
    });
    return updatedCap;
  }

  get(caseId: string, tenant_id: string = 'BANK_DEMO'): Case | undefined {
    return this.store.get(caseId, tenant_id);
  }

  list(filters: Partial<ListFilters> = {}) {
    return this.store.list({ tenant_id: 'BANK_DEMO', ...filters });
  }

  private requireCase(caseId: string, tenant_id: string = 'BANK_DEMO'): Case {
    const c = this.store.get(caseId, tenant_id);
    if (!c) {
      const err = new Error(`case ${caseId} not found`) as Error & { status?: number };
      err.status = 404;
      throw err;
    }
    return c;
  }

  private async emit(
    c: Case,
    priorState: CaseState | null,
    eventType: CaseEvent['event_type'],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const event: CaseEvent = {
      event_id: newEventId(this.now),
      event_type: eventType,
      ts: this.now().toISOString(),
      case_id: c.case_id,
      alert_id: c.alert_id,
      customer_id: c.customer_id,
      prior_state: priorState,
      new_state: c.state,
      payload,
    };
    // Guard against drift between code and the registered schema. CI catches
    // changes to the schema file; this catches changes to the emitter.
    validateOrThrow(event);
    await this.producer.emit(this.topic, event);
  }
}

export type { Transition };

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}
