// services/bff/src/aml/str_reporting.ts
//
// PHASE C.1 — STR Reporting (Suspicious Transaction Report) per
// PDF §11 AML Integration item 4.
//
// Compliance-grade workflow for RBI FIU-IND STR submissions:
//   draft → ready_for_review → submitted → acknowledged
// Distinct from M14.3 AML adapter (which surfaces sanctions/PEP/AML
// MATCH probes — read-side); this is the OUTBOUND workflow ops uses
// to file a regulatory STR per RBI Master Direction on KYC §5.16 +
// PML Act 2002 §12.
//
// Architecture mirrors Phase A/B modules:
//   - Additive only — no changes to M14.3 read-side adapter.
//   - Pure in-memory store; pg swap deferred.
//   - Audit fields + soft-delete + Recovery on draft reports only
//     (submitted/acknowledged STRs are immutable per FIU-IND retention
//     rules; they can't be soft-deleted from the system).
//   - RBAC: audit:read admin-only (every STR action is a compliance
//     event audited externally).

/** STR workflow states. Closed enum. Once submitted, the entry
 *  becomes effectively immutable — the system retains the
 *  acknowledgement reference but admins cannot edit the data. */
export const ALL_STR_STATUSES = [
  'draft',
  'ready_for_review',
  'submitted',
  'acknowledged',
  'rejected',
] as const;
export type StrStatus = (typeof ALL_STR_STATUSES)[number];

export function isStrStatus(v: unknown): v is StrStatus {
  return typeof v === 'string' && (ALL_STR_STATUSES as readonly string[]).includes(v);
}

/** Suspicion reason taxonomy — closed enum aligned with FIU-IND XML
 *  reason codes. */
export const ALL_STR_REASONS = [
  'sanctions_hit',
  'pep_high_value',
  'unusual_pattern',
  'cash_intensive',
  'shell_company',
  'structuring',
  'tax_evasion',
  'trade_based_ml',
  'wire_fraud',
  'other',
] as const;
export type StrReason = (typeof ALL_STR_REASONS)[number];

export function isStrReason(v: unknown): v is StrReason {
  return typeof v === 'string' && (ALL_STR_REASONS as readonly string[]).includes(v);
}

/** Allowed forward transitions. Backwards transitions deliberately
 *  refused — once an STR moves forward in the lifecycle it can't
 *  rewind (matches FIU-IND audit semantics). */
const ALLOWED_TRANSITIONS: Record<StrStatus, StrStatus[]> = {
  draft: ['ready_for_review'],
  ready_for_review: ['submitted', 'draft'],   // checker can send back to maker
  submitted: ['acknowledged', 'rejected'],
  acknowledged: [],                            // terminal
  rejected: [],                                // terminal (re-file = new STR)
};

export function canTransition(from: StrStatus, to: StrStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface StrReport {
  str_id: string;
  tenant_id: string;
  customer_id: string;                    // FK to mart.customer_360
  case_id: string | null;                  // optional link to M9.x investigation
  reasons: StrReason[];                    // 1+; closed enum
  total_amount_kes: number;                // sum across the suspicious transactions
  transaction_count: number;               // number of underlying transactions
  date_range_start: string;                // ISO; first suspicious txn
  date_range_end: string;                  // ISO; last suspicious txn
  narrative: string;                       // free-form description (1000 chars)
  supporting_doc_refs: string[];           // links to evidence (DMS refs etc.)
  status: StrStatus;
  // Maker-checker
  maker_username: string;                  // who drafted
  checker_username: string | null;         // who approved (set on submit)
  submitted_at: string | null;
  ack_reference: string | null;            // FIU-IND ack ID once acknowledged
  ack_received_at: string | null;
  rejection_reason: string | null;
  // Audit
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface StrReportCreateInput {
  str_id: string;
  customer_id: string;
  case_id?: string | null;
  reasons: StrReason[];
  total_amount_kes: number;
  transaction_count: number;
  date_range_start: string;
  date_range_end: string;
  narrative: string;
  supporting_doc_refs?: string[];
}

export interface StrReportUpdateInput {
  // Only the data fields editable in draft / ready_for_review.
  // Status transitions go through the dedicated endpoint.
  customer_id?: string;
  case_id?: string | null;
  reasons?: StrReason[];
  total_amount_kes?: number;
  transaction_count?: number;
  date_range_start?: string;
  date_range_end?: string;
  narrative?: string;
  supporting_doc_refs?: string[];
}

export interface StrReportTransitionInput {
  to: StrStatus;
  checker_username?: string;          // required when transitioning ready_for_review → submitted
  ack_reference?: string;             // required for submitted → acknowledged
  rejection_reason?: string;          // required for submitted → rejected
}

export class StrError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_str_id'
      | 'invalid_customer_id'
      | 'invalid_reasons'
      | 'invalid_amount'
      | 'invalid_count'
      | 'invalid_date_range'
      | 'invalid_narrative'
      | 'invalid_supporting_doc_refs'
      | 'invalid_status'
      | 'invalid_transition'
      | 'missing_checker'
      | 'missing_ack_reference'
      | 'missing_rejection_reason'
      | 'self_approval_forbidden'
      | 'unknown_str'
      | 'duplicate_str_id'
      | 'immutable'
      | 'cap_reached',
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StrError';
  }
}

export const STR_REPORT_CAP_PER_TENANT = 10_000;
export const STR_SUPPORTING_DOCS_CAP = 50;
const STR_ID_RE = /^[A-Z][A-Z0-9_-]{2,63}$/;
const CUSTOMER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function validateCreateInput(input: StrReportCreateInput): void {
  if (!input || typeof input !== 'object') {
    throw new StrError('invalid_input', 'request body must be an object');
  }
  if (typeof input.str_id !== 'string' || !STR_ID_RE.test(input.str_id)) {
    throw new StrError(
      'invalid_str_id',
      'str_id must match ^[A-Z][A-Z0-9_-]{2,63}$',
    );
  }
  if (typeof input.customer_id !== 'string' || !CUSTOMER_ID_RE.test(input.customer_id)) {
    throw new StrError('invalid_customer_id', 'customer_id invalid');
  }
  if (input.case_id != null) {
    if (typeof input.case_id !== 'string' || input.case_id.length > 64) {
      throw new StrError('invalid_input', 'case_id ≤ 64 chars (or null)');
    }
  }
  if (!Array.isArray(input.reasons) || input.reasons.length === 0) {
    throw new StrError('invalid_reasons', 'reasons must be a non-empty array');
  }
  for (const r of input.reasons) {
    if (!isStrReason(r)) {
      throw new StrError(
        'invalid_reasons',
        `reason "${r}" not in: ${ALL_STR_REASONS.join(', ')}`,
      );
    }
  }
  // Dedup check inside reasons.
  if (new Set(input.reasons).size !== input.reasons.length) {
    throw new StrError('invalid_reasons', 'reasons must not contain duplicates');
  }
  if (
    typeof input.total_amount_kes !== 'number' ||
    !Number.isFinite(input.total_amount_kes) ||
    input.total_amount_kes <= 0
  ) {
    throw new StrError(
      'invalid_amount',
      'total_amount_kes must be a positive finite number',
    );
  }
  if (
    typeof input.transaction_count !== 'number' ||
    !Number.isInteger(input.transaction_count) ||
    input.transaction_count <= 0
  ) {
    throw new StrError('invalid_count', 'transaction_count must be a positive integer');
  }
  if (
    typeof input.date_range_start !== 'string' ||
    !ISO_TS_RE.test(input.date_range_start) ||
    typeof input.date_range_end !== 'string' ||
    !ISO_TS_RE.test(input.date_range_end)
  ) {
    throw new StrError(
      'invalid_date_range',
      'date_range_start and date_range_end must be ISO-8601 datetimes',
    );
  }
  const ts1 = Date.parse(input.date_range_start);
  const ts2 = Date.parse(input.date_range_end);
  if (!Number.isFinite(ts1) || !Number.isFinite(ts2) || ts2 < ts1) {
    throw new StrError(
      'invalid_date_range',
      'date_range_end must be ≥ date_range_start',
    );
  }
  if (
    typeof input.narrative !== 'string' ||
    input.narrative.trim().length < 20 ||
    input.narrative.length > 1000
  ) {
    throw new StrError(
      'invalid_narrative',
      'narrative must be 20..1000 chars (regulatory minimum 20)',
    );
  }
  if (input.supporting_doc_refs !== undefined) {
    if (!Array.isArray(input.supporting_doc_refs)) {
      throw new StrError('invalid_supporting_doc_refs', 'supporting_doc_refs must be array');
    }
    if (input.supporting_doc_refs.length > STR_SUPPORTING_DOCS_CAP) {
      throw new StrError(
        'invalid_supporting_doc_refs',
        `supporting_doc_refs cap is ${STR_SUPPORTING_DOCS_CAP}`,
      );
    }
    for (const d of input.supporting_doc_refs) {
      if (typeof d !== 'string' || d.length === 0 || d.length > 200) {
        throw new StrError('invalid_supporting_doc_refs', 'each doc ref ≤ 200 chars');
      }
    }
  }
}

function validateUpdateInput(patch: StrReportUpdateInput, base: StrReport): void {
  if (!patch || typeof patch !== 'object') {
    throw new StrError('invalid_input', 'patch must be an object');
  }
  // Editing only permitted in draft + ready_for_review states.
  if (base.status !== 'draft' && base.status !== 'ready_for_review') {
    throw new StrError(
      'immutable',
      `cannot edit STR in status=${base.status} (only draft/ready_for_review are editable)`,
    );
  }
  if (patch.customer_id !== undefined && !CUSTOMER_ID_RE.test(patch.customer_id)) {
    throw new StrError('invalid_customer_id', 'customer_id invalid');
  }
  if (patch.case_id !== undefined && patch.case_id !== null) {
    if (typeof patch.case_id !== 'string' || patch.case_id.length > 64) {
      throw new StrError('invalid_input', 'case_id ≤ 64 chars (or null)');
    }
  }
  if (patch.reasons !== undefined) {
    if (!Array.isArray(patch.reasons) || patch.reasons.length === 0) {
      throw new StrError('invalid_reasons', 'reasons must be a non-empty array');
    }
    for (const r of patch.reasons) {
      if (!isStrReason(r)) {
        throw new StrError('invalid_reasons', `reason "${r}" not in catalog`);
      }
    }
    if (new Set(patch.reasons).size !== patch.reasons.length) {
      throw new StrError('invalid_reasons', 'reasons must not contain duplicates');
    }
  }
  if (patch.total_amount_kes !== undefined) {
    if (
      typeof patch.total_amount_kes !== 'number' ||
      !Number.isFinite(patch.total_amount_kes) ||
      patch.total_amount_kes <= 0
    ) {
      throw new StrError('invalid_amount', 'total_amount_kes must be a positive finite number');
    }
  }
  if (patch.transaction_count !== undefined) {
    if (
      typeof patch.transaction_count !== 'number' ||
      !Number.isInteger(patch.transaction_count) ||
      patch.transaction_count <= 0
    ) {
      throw new StrError('invalid_count', 'transaction_count must be a positive integer');
    }
  }
  if (patch.date_range_start !== undefined || patch.date_range_end !== undefined) {
    const startStr = patch.date_range_start ?? base.date_range_start;
    const endStr = patch.date_range_end ?? base.date_range_end;
    if (
      typeof startStr !== 'string' ||
      typeof endStr !== 'string' ||
      !ISO_TS_RE.test(startStr) ||
      !ISO_TS_RE.test(endStr)
    ) {
      throw new StrError('invalid_date_range', 'date_range_* must be ISO-8601');
    }
    const ts1 = Date.parse(startStr);
    const ts2 = Date.parse(endStr);
    if (!Number.isFinite(ts1) || !Number.isFinite(ts2) || ts2 < ts1) {
      throw new StrError('invalid_date_range', 'date_range_end must be ≥ date_range_start');
    }
  }
  if (patch.narrative !== undefined) {
    if (
      typeof patch.narrative !== 'string' ||
      patch.narrative.trim().length < 20 ||
      patch.narrative.length > 1000
    ) {
      throw new StrError('invalid_narrative', 'narrative must be 20..1000 chars');
    }
  }
  if (patch.supporting_doc_refs !== undefined) {
    if (!Array.isArray(patch.supporting_doc_refs)) {
      throw new StrError('invalid_supporting_doc_refs', 'supporting_doc_refs must be array');
    }
    if (patch.supporting_doc_refs.length > STR_SUPPORTING_DOCS_CAP) {
      throw new StrError(
        'invalid_supporting_doc_refs',
        `supporting_doc_refs cap is ${STR_SUPPORTING_DOCS_CAP}`,
      );
    }
    for (const d of patch.supporting_doc_refs) {
      if (typeof d !== 'string' || d.length === 0 || d.length > 200) {
        throw new StrError('invalid_supporting_doc_refs', 'each doc ref ≤ 200 chars');
      }
    }
  }
}

export interface StrReportStore {
  list(
    tenant_id: string,
    opts?: {
      include_deleted?: boolean;
      status?: StrStatus;
      customer_id?: string;
      since?: string;
      until?: string;
      limit?: number;
    },
  ): StrReport[];
  get(tenant_id: string, str_id: string): StrReport | null;
  create(
    tenant_id: string,
    input: StrReportCreateInput,
    maker: string,
    now: Date,
  ): StrReport;
  update(
    tenant_id: string,
    str_id: string,
    patch: StrReportUpdateInput,
    actor: string,
    now: Date,
  ): StrReport;
  transition(
    tenant_id: string,
    str_id: string,
    input: StrReportTransitionInput,
    actor: string,
    now: Date,
  ): StrReport;
  softDelete(
    tenant_id: string,
    str_id: string,
    actor: string,
    now: Date,
  ): StrReport;
  restore(payload: StrReport): boolean;
}

export class InMemoryStrReportStore implements StrReportStore {
  private byTenant = new Map<string, Map<string, StrReport>>();

  private bucket(tenant_id: string): Map<string, StrReport> {
    let b = this.byTenant.get(tenant_id);
    if (!b) {
      b = new Map();
      this.byTenant.set(tenant_id, b);
    }
    return b;
  }

  list(
    tenant_id: string,
    opts: {
      include_deleted?: boolean;
      status?: StrStatus;
      customer_id?: string;
      since?: string;
      until?: string;
      limit?: number;
    } = {},
  ): StrReport[] {
    const b = this.byTenant.get(tenant_id);
    if (!b) return [];
    const sinceTs = opts.since ? Date.parse(opts.since) : null;
    const untilTs = opts.until ? Date.parse(opts.until) : null;
    let out: StrReport[] = [];
    for (const e of b.values()) {
      if (!opts.include_deleted && e.deleted_at) continue;
      if (opts.status && e.status !== opts.status) continue;
      if (opts.customer_id && e.customer_id !== opts.customer_id) continue;
      if (sinceTs && Date.parse(e.created_at) < sinceTs) continue;
      if (untilTs && Date.parse(e.created_at) > untilTs) continue;
      out.push({ ...e });
    }
    // Sort newest-first by created_at (compliance ledger style).
    out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    if (out.length > limit) out = out.slice(0, limit);
    return out;
  }

  get(tenant_id: string, str_id: string): StrReport | null {
    const e = this.byTenant.get(tenant_id)?.get(str_id);
    if (!e || e.deleted_at) return null;
    return { ...e };
  }

  create(
    tenant_id: string,
    input: StrReportCreateInput,
    maker: string,
    now: Date,
  ): StrReport {
    validateCreateInput(input);
    if (typeof maker !== 'string' || maker.trim().length === 0) {
      throw new StrError('invalid_input', 'maker (created_by) required');
    }
    const b = this.bucket(tenant_id);
    const existing = b.get(input.str_id);
    if (existing && !existing.deleted_at) {
      throw new StrError('duplicate_str_id', `str_id ${input.str_id} already exists`, {
        str_id: input.str_id,
      });
    }
    const live = [...b.values()].filter((e) => !e.deleted_at).length;
    if (live >= STR_REPORT_CAP_PER_TENANT) {
      throw new StrError('cap_reached', `STR report cap (${STR_REPORT_CAP_PER_TENANT}) reached`);
    }
    const ts = now.toISOString();
    const entry: StrReport = {
      str_id: input.str_id,
      tenant_id,
      customer_id: input.customer_id,
      case_id: input.case_id ?? null,
      reasons: [...input.reasons],
      total_amount_kes: input.total_amount_kes,
      transaction_count: input.transaction_count,
      date_range_start: input.date_range_start,
      date_range_end: input.date_range_end,
      narrative: input.narrative.trim(),
      supporting_doc_refs: input.supporting_doc_refs ? [...input.supporting_doc_refs] : [],
      status: 'draft',
      maker_username: maker,
      checker_username: null,
      submitted_at: null,
      ack_reference: null,
      ack_received_at: null,
      rejection_reason: null,
      created_at: ts,
      created_by: maker,
      updated_at: ts,
      updated_by: maker,
      deleted_at: null,
      deleted_by: null,
    };
    b.set(entry.str_id, entry);
    return { ...entry };
  }

  update(
    tenant_id: string,
    str_id: string,
    patch: StrReportUpdateInput,
    actor: string,
    now: Date,
  ): StrReport {
    const b = this.bucket(tenant_id);
    const e = b.get(str_id);
    if (!e || e.deleted_at) {
      throw new StrError('unknown_str', `str_id ${str_id} not found`, { str_id });
    }
    validateUpdateInput(patch, e);
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new StrError('invalid_input', 'actor required');
    }
    const next: StrReport = { ...e };
    if (patch.customer_id !== undefined) next.customer_id = patch.customer_id;
    if (patch.case_id !== undefined) next.case_id = patch.case_id;
    if (patch.reasons !== undefined) next.reasons = [...patch.reasons];
    if (patch.total_amount_kes !== undefined) next.total_amount_kes = patch.total_amount_kes;
    if (patch.transaction_count !== undefined) next.transaction_count = patch.transaction_count;
    if (patch.date_range_start !== undefined) next.date_range_start = patch.date_range_start;
    if (patch.date_range_end !== undefined) next.date_range_end = patch.date_range_end;
    if (patch.narrative !== undefined) next.narrative = patch.narrative.trim();
    if (patch.supporting_doc_refs !== undefined) {
      next.supporting_doc_refs = [...patch.supporting_doc_refs];
    }
    next.updated_at = now.toISOString();
    next.updated_by = actor;
    b.set(str_id, next);
    return { ...next };
  }

  transition(
    tenant_id: string,
    str_id: string,
    input: StrReportTransitionInput,
    actor: string,
    now: Date,
  ): StrReport {
    if (!input || typeof input !== 'object') {
      throw new StrError('invalid_input', 'request body must be an object');
    }
    if (!isStrStatus(input.to)) {
      throw new StrError('invalid_status', `to must be one of: ${ALL_STR_STATUSES.join(', ')}`);
    }
    const b = this.bucket(tenant_id);
    const e = b.get(str_id);
    if (!e || e.deleted_at) {
      throw new StrError('unknown_str', `str_id ${str_id} not found`, { str_id });
    }
    if (!canTransition(e.status, input.to)) {
      throw new StrError(
        'invalid_transition',
        `cannot transition from ${e.status} to ${input.to}`,
        { from: e.status, to: input.to },
      );
    }
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new StrError('invalid_input', 'actor required');
    }
    const next: StrReport = { ...e };
    const ts = now.toISOString();

    // Status-specific guards + side effects.
    if (input.to === 'submitted') {
      const checker = (input.checker_username ?? '').trim();
      if (!checker) {
        throw new StrError('missing_checker', 'checker_username required to submit');
      }
      if (checker === e.maker_username) {
        // RBI segregation-of-duties: maker cannot be checker. Mirrors
        // M9.3 maker-checker for sensitive case actions.
        throw new StrError(
          'self_approval_forbidden',
          'maker and checker must be different users (RBI segregation of duties)',
        );
      }
      next.checker_username = checker;
      next.submitted_at = ts;
    } else if (input.to === 'acknowledged') {
      const ack = (input.ack_reference ?? '').trim();
      if (!ack || ack.length > 100) {
        throw new StrError(
          'missing_ack_reference',
          'ack_reference required (1..100 chars) for submitted → acknowledged',
        );
      }
      next.ack_reference = ack;
      next.ack_received_at = ts;
    } else if (input.to === 'rejected') {
      const reason = (input.rejection_reason ?? '').trim();
      if (!reason || reason.length > 500) {
        throw new StrError(
          'missing_rejection_reason',
          'rejection_reason required (1..500 chars) for submitted → rejected',
        );
      }
      next.rejection_reason = reason;
    }

    next.status = input.to;
    next.updated_at = ts;
    next.updated_by = actor;
    b.set(str_id, next);
    return { ...next };
  }

  softDelete(
    tenant_id: string,
    str_id: string,
    actor: string,
    now: Date,
  ): StrReport {
    if (typeof actor !== 'string' || actor.trim().length === 0) {
      throw new StrError('invalid_input', 'actor required');
    }
    const b = this.bucket(tenant_id);
    const e = b.get(str_id);
    if (!e || e.deleted_at) {
      throw new StrError('unknown_str', `str_id ${str_id} not found`, { str_id });
    }
    // Submitted / acknowledged / rejected STRs are immutable per
    // FIU-IND retention rules. Only drafts + ready_for_review can be
    // soft-deleted.
    if (e.status !== 'draft' && e.status !== 'ready_for_review') {
      throw new StrError(
        'immutable',
        `cannot delete STR in status=${e.status} — only draft/ready_for_review can be soft-deleted`,
      );
    }
    const ts = now.toISOString();
    const tombstoned: StrReport = {
      ...e,
      deleted_at: ts,
      deleted_by: actor,
      updated_at: ts,
      updated_by: actor,
    };
    b.set(str_id, tombstoned);
    return { ...tombstoned };
  }

  restore(payload: StrReport): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.str_id !== 'string' || typeof payload.tenant_id !== 'string') {
      return false;
    }
    const b = this.bucket(payload.tenant_id);
    const existing = b.get(payload.str_id);
    if (existing && !existing.deleted_at) return false;
    b.set(payload.str_id, { ...payload, deleted_at: null, deleted_by: null });
    return true;
  }
}

export const defaultStrReportStore: StrReportStore = new InMemoryStrReportStore();

// ─── Summary helper (drives the AML dashboard) ───────────────────────

export interface StrSummary {
  tenant_id: string;
  generated_at: string;
  total_strs: number;
  by_status: Record<StrStatus, number>;
  by_reason: Record<StrReason, number>;
  total_amount_kes_submitted: number;     // Σ across all submitted/acknowledged/rejected
  pending_review_count: number;            // ready_for_review entries
  unacked_submitted_count: number;         // submitted but not yet acked (timely-tracking)
  oldest_unacked_submitted_at: string | null;
}

export function buildStrSummary(
  store: StrReportStore,
  tenant_id: string,
  now: Date,
): StrSummary {
  const items = store.list(tenant_id, { limit: 500 });
  const by_status: Record<StrStatus, number> = {
    draft: 0,
    ready_for_review: 0,
    submitted: 0,
    acknowledged: 0,
    rejected: 0,
  };
  const by_reason: Record<StrReason, number> = {
    sanctions_hit: 0,
    pep_high_value: 0,
    unusual_pattern: 0,
    cash_intensive: 0,
    shell_company: 0,
    structuring: 0,
    tax_evasion: 0,
    trade_based_ml: 0,
    wire_fraud: 0,
    other: 0,
  };
  let totalAmountSubmitted = 0;
  let unackedSubmitted = 0;
  let oldestUnackedSubmittedAt: string | null = null;

  for (const r of items) {
    by_status[r.status]++;
    for (const reason of r.reasons) by_reason[reason]++;
    if (r.status === 'submitted' || r.status === 'acknowledged' || r.status === 'rejected') {
      totalAmountSubmitted += r.total_amount_kes;
    }
    if (r.status === 'submitted' && r.submitted_at) {
      unackedSubmitted++;
      if (
        !oldestUnackedSubmittedAt ||
        Date.parse(r.submitted_at) < Date.parse(oldestUnackedSubmittedAt)
      ) {
        oldestUnackedSubmittedAt = r.submitted_at;
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_strs: items.length,
    by_status,
    by_reason,
    total_amount_kes_submitted: Math.round(totalAmountSubmitted * 100) / 100,
    pending_review_count: by_status.ready_for_review,
    unacked_submitted_count: unackedSubmitted,
    oldest_unacked_submitted_at: oldestUnackedSubmittedAt,
  };
}
