// services/bff/src/cms_store.ts
//
// CMS-2 — In-memory store + state machine + audit trail.
//
// Builds on CMS-1's types + validators + helpers. Does NOT change
// any of the M9.x case modules (additive only).
//
// Sub-stores:
//   InMemoryCmsCaseStore         — case envelope CRUD + transitions
//   InMemoryCmsCaseNoteStore     — append-only notes thread
//   InMemoryCmsAttachmentStore   — attachment metadata + virus scan
//   InMemoryCmsAssignmentStore   — assignment history (assigned_to/by/at,
//                                  unassigned_at NULL = currently active)
//   InMemoryCmsHistoryStore      — per-case immutable audit slice
//
// All sub-stores are facets behind a single `CmsCaseStore` interface so
// the route layer in CMS-3 takes one dependency. Production swap-in is
// PostgreSQL via 013_cms_cases.sql.
//
// Audit semantics: every mutation on a case (create/update/transition/
// assign/close/reopen/note/attachment) writes a row to the history
// store, KEY = case_id. CMS-3 also forwards each mutation to the M9.4
// case-event journal so cross-case consumers see one stream.

import { randomUUID } from 'node:crypto';
import {
  ATTACHMENT_VIRUS_STATUSES,
  CMS_RESOLUTION_CATEGORIES,
  CmsCaseError,
  computeSlaDueAt,
  formatCmsCaseNumber,
  isLegalCmsTransition,
  pickNextAssignee,
  validateCmsAttachmentMeta,
  validateCmsCaseAssign,
  validateCmsCaseClose,
  validateCmsCaseInput,
  validateCmsCaseNote,
  validateCmsCaseUpdate,
  type AttachmentVirusStatus,
  type CmsCase,
  type CmsCaseAssignInput,
  type CmsCaseAssignment,
  type CmsCaseAttachment,
  type CmsCaseCloseInput,
  type CmsCaseHistoryEntry,
  type CmsCaseInput,
  type CmsCaseNote,
  type CmsCaseState,
  type CmsCaseUpdate,
  type CmsPriority,
} from './cms_cases';

// ─── Caps ─────────────────────────────────────────────────────────────

export const CMS_CASES_CAP_PER_TENANT = 1000;
export const CMS_NOTES_CAP_PER_CASE = 50;
export const CMS_ATTACHMENTS_CAP_PER_CASE = 50;
export const CMS_ASSIGNMENTS_CAP_PER_CASE = 50;
export const CMS_HISTORY_CAP_PER_CASE = 200;

// ─── Filters ─────────────────────────────────────────────────────────

export interface CmsListFilter {
  status?: CmsCaseState;
  priority?: CmsPriority;
  assigned_to?: string;
  alert_id?: string;
  /** ISO inclusive lower bound on created_at. */
  since?: string;
  /** ISO exclusive upper bound on created_at. */
  until?: string;
  /** Free-text search over title + description (case-insensitive substring). */
  q?: string;
  /** Substring match against case_number. */
  case_number?: string;
  /** Tag membership — match if ANY supplied tag is in the case's tags. */
  tags_any?: string[];
}

// ─── Store interface ─────────────────────────────────────────────────

export interface CmsCaseStore {
  // Cases
  list(tenant_id: string, filter: CmsListFilter): CmsCase[];
  get(tenant_id: string, case_id: string): CmsCase | null;
  getByNumber(tenant_id: string, case_number: string): CmsCase | null;
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): CmsCase;
  update(
    tenant_id: string,
    case_id: string,
    patch: unknown,
    updated_by: string,
    now: Date,
  ): CmsCase;
  transition(
    tenant_id: string,
    case_id: string,
    target: CmsCaseState,
    performed_by: string,
    now: Date,
  ): CmsCase;
  assign(
    tenant_id: string,
    case_id: string,
    input: unknown,
    assigned_by: string,
    now: Date,
  ): CmsCase;
  /** Convenience: assign next from a round-robin pool. Pool selection
   *  is the caller's job (typically the team roster). */
  assignRoundRobin(
    tenant_id: string,
    case_id: string,
    pool: readonly string[],
    assigned_by: string,
    now: Date,
  ): CmsCase;
  escalate(
    tenant_id: string,
    case_id: string,
    performed_by: string,
    reason: string | undefined,
    now: Date,
  ): CmsCase;
  close(
    tenant_id: string,
    case_id: string,
    input: unknown,
    closed_by: string,
    now: Date,
  ): CmsCase;
  reopen(
    tenant_id: string,
    case_id: string,
    performed_by: string,
    now: Date,
  ): CmsCase;
  bulkAssign(
    tenant_id: string,
    case_ids: readonly string[],
    assigned_to: string,
    assigned_by: string,
    reason: string | undefined,
    now: Date,
  ): Array<{ case_id: string; status: 'ok' | 'unknown_case' | 'case_locked' | 'invalid_input'; reason?: string }>;

  // Notes
  addNote(
    tenant_id: string,
    case_id: string,
    input: unknown,
    user_id: string,
    now: Date,
  ): CmsCaseNote;
  listNotes(tenant_id: string, case_id: string): CmsCaseNote[];

  // Attachments
  addAttachment(
    tenant_id: string,
    case_id: string,
    meta: unknown,
    uploaded_by: string,
    now: Date,
  ): CmsCaseAttachment;
  listAttachments(tenant_id: string, case_id: string): CmsCaseAttachment[];
  getAttachment(
    tenant_id: string,
    case_id: string,
    attachment_id: string,
  ): CmsCaseAttachment | null;
  deleteAttachment(
    tenant_id: string,
    case_id: string,
    attachment_id: string,
    deleted_by: string,
    now: Date,
  ): boolean;
  /** Test-time hook: flip a pending scan to clean/infected/failed. */
  setVirusScanStatus(
    tenant_id: string,
    case_id: string,
    attachment_id: string,
    status: AttachmentVirusStatus,
  ): CmsCaseAttachment | null;

  // Assignment history
  listAssignments(tenant_id: string, case_id: string): CmsCaseAssignment[];

  // Per-case audit slice
  listHistory(tenant_id: string, case_id: string, limit?: number): CmsCaseHistoryEntry[];
}

// ─── Synthesise virus-scan stub ──────────────────────────────────────

const PENDING_MIME_PATTERNS = [/macro/i, /unknown/i];

/** Pure prototype virus-scan: clean for whitelisted-and-known mimes,
 *  infected for blocked extensions, pending otherwise. Production
 *  swap is ClamAV. */
export function simulateVirusScan(file_name: string, mime_type: string): AttachmentVirusStatus {
  const lower = file_name.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.bat') || lower.endsWith('.scr')) {
    return 'infected';
  }
  for (const re of PENDING_MIME_PATTERNS) {
    if (re.test(mime_type)) return 'pending';
  }
  return 'clean';
}

// ─── Helpers ─────────────────────────────────────────────────────────

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function priorityToStatusForFreshCreate(): CmsCaseState {
  return 'OPEN';
}

// ─── Implementation ──────────────────────────────────────────────────

export class InMemoryCmsCaseStore implements CmsCaseStore {
  private readonly cases = new Map<string, CmsCase[]>();
  private readonly notes = new Map<string, CmsCaseNote[]>();
  private readonly attachments = new Map<string, CmsCaseAttachment[]>();
  private readonly assignments = new Map<string, CmsCaseAssignment[]>();
  private readonly history = new Map<string, CmsCaseHistoryEntry[]>();

  /** (tenant_id, year) → next sequence_no for case_number generation. */
  private readonly caseSeq = new Map<string, number>();

  // ─── internal helpers ────────────────────────────────────────────

  private bucket<T>(map: Map<string, T[]>, key: string): T[] {
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    return arr;
  }

  private nextCaseNumber(tenant_id: string, now: Date): string {
    const year = now.getUTCFullYear();
    const key = `${tenant_id}::${year}`;
    const next = (this.caseSeq.get(key) ?? 0) + 1;
    this.caseSeq.set(key, next);
    return formatCmsCaseNumber(year, next);
  }

  private requireCase(tenant_id: string, case_id: string): CmsCase {
    const arr = this.cases.get(tenant_id) ?? [];
    const cur = arr.find((c) => c.case_id === case_id);
    if (!cur) {
      throw new CmsCaseError('unknown_case', `case ${case_id} not found`);
    }
    return cur;
  }

  private rejectIfLocked(c: CmsCase): void {
    if (c.is_locked) {
      throw new CmsCaseError(
        'case_locked',
        `case ${c.case_id} is closed and locked — reopen before mutating`,
      );
    }
  }

  private upsert(tenant_id: string, c: CmsCase): void {
    const arr = this.bucket(this.cases, tenant_id);
    const idx = arr.findIndex((x) => x.case_id === c.case_id);
    if (idx < 0) arr.push(c);
    else arr[idx] = c;
  }

  private writeHistory(
    tenant_id: string,
    case_id: string,
    action_type: string,
    old_value: unknown,
    new_value: unknown,
    performed_by: string,
    now: Date,
  ): CmsCaseHistoryEntry {
    const entry: CmsCaseHistoryEntry = {
      history_id: randomUUID(),
      case_id,
      tenant_id,
      action_type,
      old_value: old_value === undefined ? null : (clone(old_value) as unknown),
      new_value: new_value === undefined ? null : (clone(new_value) as unknown),
      performed_by,
      performed_at: now.toISOString(),
    };
    const arr = this.bucket(this.history, `${tenant_id}::${case_id}`);
    arr.push(entry);
    if (arr.length > CMS_HISTORY_CAP_PER_CASE) {
      arr.splice(0, arr.length - CMS_HISTORY_CAP_PER_CASE);
    }
    return clone(entry);
  }

  // ─── Cases ───────────────────────────────────────────────────────

  list(tenant_id: string, filter: CmsListFilter): CmsCase[] {
    const arr = this.cases.get(tenant_id) ?? [];
    const q = filter.q?.toLowerCase();
    const tagsAny = new Set(filter.tags_any ?? []);
    return arr
      .filter((c) => {
        if (filter.status && c.status !== filter.status) return false;
        if (filter.priority && c.priority !== filter.priority) return false;
        if (filter.assigned_to && c.assigned_to !== filter.assigned_to) return false;
        if (filter.alert_id && c.alert_id !== filter.alert_id) return false;
        if (filter.since && c.created_at < filter.since) return false;
        if (filter.until && c.created_at >= filter.until) return false;
        if (filter.case_number && !c.case_number.includes(filter.case_number)) return false;
        if (q && !`${c.title} ${c.description}`.toLowerCase().includes(q)) return false;
        if (tagsAny.size > 0) {
          const hit = c.tags.some((t) => tagsAny.has(t));
          if (!hit) return false;
        }
        return true;
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
      .map((c) => clone(c));
  }

  get(tenant_id: string, case_id: string): CmsCase | null {
    const c = this.cases.get(tenant_id)?.find((x) => x.case_id === case_id);
    return c ? clone(c) : null;
  }

  getByNumber(tenant_id: string, case_number: string): CmsCase | null {
    const c = this.cases.get(tenant_id)?.find((x) => x.case_number === case_number);
    return c ? clone(c) : null;
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): CmsCase {
    if (!created_by || !created_by.trim()) {
      throw new CmsCaseError('invalid_input', 'created_by required');
    }
    const valid = validateCmsCaseInput(input) as CmsCaseInput;
    const arr = this.bucket(this.cases, tenant_id);
    if (arr.length >= CMS_CASES_CAP_PER_TENANT) {
      throw new CmsCaseError(
        'cap_reached',
        `tenant ${tenant_id} already has ${CMS_CASES_CAP_PER_TENANT} cases`,
      );
    }
    const case_id = randomUUID();
    const sla_due_at = computeSlaDueAt(valid.priority, now);
    const c: CmsCase = {
      case_id,
      case_number: this.nextCaseNumber(tenant_id, now),
      tenant_id,
      title: valid.title,
      description: valid.description ?? '',
      alert_id: valid.alert_id ?? null,
      status: priorityToStatusForFreshCreate(),
      priority: valid.priority,
      assigned_to: valid.assigned_to ?? null,
      created_by: created_by.trim(),
      sla_due_at: sla_due_at.toISOString(),
      resolved_at: null,
      resolution_category: null,
      resolution_notes: '',
      tags: valid.tags ?? [],
      is_locked: false,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    arr.push(c);

    this.writeHistory(tenant_id, case_id, 'create', null, c, created_by.trim(), now);

    if (valid.assigned_to) {
      // Assigning at create time records an assignment row + flips
      // status to ASSIGNED to keep the lifecycle invariant honest.
      const assignment: CmsCaseAssignment = {
        assignment_id: randomUUID(),
        case_id,
        tenant_id,
        assigned_to: valid.assigned_to,
        assigned_by: created_by.trim(),
        assigned_at: now.toISOString(),
        unassigned_at: null,
        reason: 'created with assignee',
      };
      this.bucket(this.assignments, `${tenant_id}::${case_id}`).push(assignment);
      this.writeHistory(
        tenant_id,
        case_id,
        'assign',
        null,
        { assigned_to: valid.assigned_to },
        created_by.trim(),
        now,
      );
      // Auto-transition OPEN → ASSIGNED.
      c.status = 'ASSIGNED';
      c.updated_at = now.toISOString();
      this.writeHistory(
        tenant_id,
        case_id,
        'transition',
        { status: 'OPEN' },
        { status: 'ASSIGNED' },
        created_by.trim(),
        now,
      );
    }

    return clone(c);
  }

  update(
    tenant_id: string,
    case_id: string,
    patch: unknown,
    updated_by: string,
    now: Date,
  ): CmsCase {
    if (!updated_by || !updated_by.trim()) {
      throw new CmsCaseError('invalid_input', 'updated_by required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    const valid = validateCmsCaseUpdate(patch) as CmsCaseUpdate;

    const before = clone(cur);
    if (valid.title !== undefined) cur.title = valid.title;
    if (valid.description !== undefined) cur.description = valid.description;
    if (valid.priority !== undefined && valid.priority !== cur.priority) {
      // Priority change recomputes SLA from the ORIGINAL created_at.
      cur.priority = valid.priority;
      cur.sla_due_at = computeSlaDueAt(valid.priority, new Date(cur.created_at)).toISOString();
    }
    if (valid.tags !== undefined) cur.tags = [...valid.tags];
    cur.updated_at = now.toISOString();

    this.writeHistory(tenant_id, case_id, 'update', before, clone(cur), updated_by.trim(), now);
    return clone(cur);
  }

  transition(
    tenant_id: string,
    case_id: string,
    target: CmsCaseState,
    performed_by: string,
    now: Date,
  ): CmsCase {
    if (!performed_by || !performed_by.trim()) {
      throw new CmsCaseError('invalid_input', 'performed_by required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    // CLOSED → OPEN is the only legal transition off CLOSED; lock check
    // here would block reopen, so DON'T call rejectIfLocked() here.
    if (target !== 'OPEN' && cur.is_locked) {
      throw new CmsCaseError(
        'case_locked',
        `case ${case_id} is closed and locked — only target=OPEN (reopen) allowed`,
      );
    }
    if (!isLegalCmsTransition(cur.status, target)) {
      throw new CmsCaseError(
        'illegal_transition',
        `cannot transition case from ${cur.status} → ${target}`,
      );
    }
    const before = { status: cur.status, is_locked: cur.is_locked };

    cur.status = target;
    cur.updated_at = now.toISOString();
    if (target === 'CLOSED') {
      // Caller MUST go through close() to set resolution; bare
      // transition to CLOSED is rejected.
      throw new CmsCaseError(
        'invalid_input',
        'use close(input, closed_by, now) to transition into CLOSED — resolution required',
      );
    }
    if (target === 'OPEN' && cur.is_locked) {
      // Reopen path — clear the lock + resolution + recompute SLA.
      cur.is_locked = false;
      cur.resolution_category = null;
      cur.resolution_notes = '';
      cur.resolved_at = null;
      cur.sla_due_at = computeSlaDueAt(cur.priority, now).toISOString();
    }

    this.writeHistory(
      tenant_id,
      case_id,
      target === 'OPEN' && before.is_locked ? 'reopen' : 'transition',
      before,
      { status: target, is_locked: cur.is_locked },
      performed_by.trim(),
      now,
    );
    return clone(cur);
  }

  assign(
    tenant_id: string,
    case_id: string,
    input: unknown,
    assigned_by: string,
    now: Date,
  ): CmsCase {
    if (!assigned_by || !assigned_by.trim()) {
      throw new CmsCaseError('invalid_input', 'assigned_by required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    const valid = validateCmsCaseAssign(input) as CmsCaseAssignInput;
    const before = { assigned_to: cur.assigned_to, status: cur.status };

    // Close the previously-active assignment row, if any.
    const aArr = this.bucket(this.assignments, `${tenant_id}::${case_id}`);
    for (const a of aArr) {
      if (a.unassigned_at === null) a.unassigned_at = now.toISOString();
    }
    aArr.push({
      assignment_id: randomUUID(),
      case_id,
      tenant_id,
      assigned_to: valid.assigned_to,
      assigned_by: assigned_by.trim(),
      assigned_at: now.toISOString(),
      unassigned_at: null,
      reason: valid.reason ?? null,
    });
    if (aArr.length > CMS_ASSIGNMENTS_CAP_PER_CASE) {
      aArr.splice(0, aArr.length - CMS_ASSIGNMENTS_CAP_PER_CASE);
    }

    cur.assigned_to = valid.assigned_to;
    if (cur.status === 'OPEN') cur.status = 'ASSIGNED';
    cur.updated_at = now.toISOString();

    this.writeHistory(
      tenant_id,
      case_id,
      'assign',
      before,
      { assigned_to: cur.assigned_to, status: cur.status },
      assigned_by.trim(),
      now,
    );
    return clone(cur);
  }

  assignRoundRobin(
    tenant_id: string,
    case_id: string,
    pool: readonly string[],
    assigned_by: string,
    now: Date,
  ): CmsCase {
    if (pool.length === 0) {
      throw new CmsCaseError('invalid_input', 'pool[] must be non-empty');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    const next = pickNextAssignee(pool, cur.assigned_to);
    if (!next) {
      throw new CmsCaseError('invalid_input', 'pool yielded no candidate');
    }
    return this.assign(tenant_id, case_id, { assigned_to: next, reason: 'round-robin' }, assigned_by, now);
  }

  escalate(
    tenant_id: string,
    case_id: string,
    performed_by: string,
    reason: string | undefined,
    now: Date,
  ): CmsCase {
    if (!performed_by || !performed_by.trim()) {
      throw new CmsCaseError('invalid_input', 'performed_by required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    if (!isLegalCmsTransition(cur.status, 'ESCALATED')) {
      throw new CmsCaseError(
        'illegal_transition',
        `cannot escalate from ${cur.status}`,
      );
    }
    const before = { status: cur.status };
    cur.status = 'ESCALATED';
    cur.updated_at = now.toISOString();
    this.writeHistory(
      tenant_id,
      case_id,
      'escalate',
      before,
      { status: 'ESCALATED', reason: reason ?? null },
      performed_by.trim(),
      now,
    );
    return clone(cur);
  }

  close(
    tenant_id: string,
    case_id: string,
    input: unknown,
    closed_by: string,
    now: Date,
  ): CmsCase {
    if (!closed_by || !closed_by.trim()) {
      throw new CmsCaseError('invalid_input', 'closed_by required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    const valid = validateCmsCaseClose(input) as CmsCaseCloseInput;
    if (!isLegalCmsTransition(cur.status, 'CLOSED')) {
      throw new CmsCaseError(
        'illegal_transition',
        `cannot close from ${cur.status}`,
      );
    }
    const before = clone(cur);
    cur.status = 'CLOSED';
    cur.resolution_category = valid.resolution_category;
    cur.resolution_notes = valid.resolution_notes;
    cur.resolved_at = now.toISOString();
    cur.is_locked = true;
    cur.updated_at = now.toISOString();
    this.writeHistory(tenant_id, case_id, 'close', before, clone(cur), closed_by.trim(), now);
    return clone(cur);
  }

  reopen(
    tenant_id: string,
    case_id: string,
    performed_by: string,
    now: Date,
  ): CmsCase {
    return this.transition(tenant_id, case_id, 'OPEN', performed_by, now);
  }

  bulkAssign(
    tenant_id: string,
    case_ids: readonly string[],
    assigned_to: string,
    assigned_by: string,
    reason: string | undefined,
    now: Date,
  ) {
    if (!Array.isArray(case_ids) || case_ids.length === 0) {
      throw new CmsCaseError('invalid_input', 'case_ids[] must be non-empty');
    }
    if (case_ids.length > 100) {
      throw new CmsCaseError('invalid_input', 'bulk-assign cap is 100 case_ids');
    }
    if (!assigned_to || !assigned_to.trim()) {
      throw new CmsCaseError('invalid_input', 'assigned_to required');
    }
    const out: Array<{
      case_id: string;
      status: 'ok' | 'unknown_case' | 'case_locked' | 'invalid_input';
      reason?: string;
    }> = [];
    for (const id of case_ids) {
      try {
        this.assign(tenant_id, id, { assigned_to, reason }, assigned_by, now);
        out.push({ case_id: id, status: 'ok' });
      } catch (e) {
        if (e instanceof CmsCaseError) {
          if (e.code === 'unknown_case') {
            out.push({ case_id: id, status: 'unknown_case', reason: e.message });
          } else if (e.code === 'case_locked') {
            out.push({ case_id: id, status: 'case_locked', reason: e.message });
          } else {
            out.push({ case_id: id, status: 'invalid_input', reason: e.message });
          }
        } else {
          out.push({
            case_id: id,
            status: 'invalid_input',
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
    return out;
  }

  // ─── Notes ────────────────────────────────────────────────────────

  addNote(
    tenant_id: string,
    case_id: string,
    input: unknown,
    user_id: string,
    now: Date,
  ): CmsCaseNote {
    if (!user_id || !user_id.trim()) {
      throw new CmsCaseError('invalid_input', 'user_id required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    const valid = validateCmsCaseNote(input);
    const note: CmsCaseNote = {
      note_id: randomUUID(),
      case_id,
      tenant_id,
      user_id: user_id.trim(),
      note_text: valid.note_text,
      is_internal: valid.is_internal,
      created_at: now.toISOString(),
    };
    const arr = this.bucket(this.notes, `${tenant_id}::${case_id}`);
    arr.push(note);
    if (arr.length > CMS_NOTES_CAP_PER_CASE) {
      arr.splice(0, arr.length - CMS_NOTES_CAP_PER_CASE);
    }
    cur.updated_at = now.toISOString();
    this.writeHistory(
      tenant_id,
      case_id,
      'note_added',
      null,
      { note_id: note.note_id, is_internal: note.is_internal },
      user_id.trim(),
      now,
    );
    return clone(note);
  }

  listNotes(tenant_id: string, case_id: string): CmsCaseNote[] {
    return (this.notes.get(`${tenant_id}::${case_id}`) ?? [])
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((n) => clone(n));
  }

  // ─── Attachments ─────────────────────────────────────────────────

  addAttachment(
    tenant_id: string,
    case_id: string,
    meta: unknown,
    uploaded_by: string,
    now: Date,
  ): CmsCaseAttachment {
    if (!uploaded_by || !uploaded_by.trim()) {
      throw new CmsCaseError('invalid_input', 'uploaded_by required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    const valid = validateCmsAttachmentMeta(meta);
    const attachment_id = randomUUID();
    const att: CmsCaseAttachment = {
      attachment_id,
      case_id,
      tenant_id,
      file_name: valid.file_name,
      file_url: `cms://${attachment_id}`,
      file_size: valid.file_size,
      mime_type: valid.mime_type,
      uploaded_by: uploaded_by.trim(),
      virus_scan_status: simulateVirusScan(valid.file_name, valid.mime_type),
      created_at: now.toISOString(),
    };
    const arr = this.bucket(this.attachments, `${tenant_id}::${case_id}`);
    arr.push(att);
    if (arr.length > CMS_ATTACHMENTS_CAP_PER_CASE) {
      arr.splice(0, arr.length - CMS_ATTACHMENTS_CAP_PER_CASE);
    }
    cur.updated_at = now.toISOString();
    this.writeHistory(
      tenant_id,
      case_id,
      'attachment_added',
      null,
      {
        attachment_id,
        file_name: att.file_name,
        mime_type: att.mime_type,
        virus_scan_status: att.virus_scan_status,
      },
      uploaded_by.trim(),
      now,
    );
    return clone(att);
  }

  listAttachments(tenant_id: string, case_id: string): CmsCaseAttachment[] {
    return (this.attachments.get(`${tenant_id}::${case_id}`) ?? [])
      .slice()
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((a) => clone(a));
  }

  getAttachment(
    tenant_id: string,
    case_id: string,
    attachment_id: string,
  ): CmsCaseAttachment | null {
    const a = this.attachments
      .get(`${tenant_id}::${case_id}`)
      ?.find((x) => x.attachment_id === attachment_id);
    return a ? clone(a) : null;
  }

  deleteAttachment(
    tenant_id: string,
    case_id: string,
    attachment_id: string,
    deleted_by: string,
    now: Date,
  ): boolean {
    if (!deleted_by || !deleted_by.trim()) {
      throw new CmsCaseError('invalid_input', 'deleted_by required');
    }
    const cur = this.requireCase(tenant_id, case_id);
    this.rejectIfLocked(cur);
    const arr = this.attachments.get(`${tenant_id}::${case_id}`);
    if (!arr) return false;
    const idx = arr.findIndex((x) => x.attachment_id === attachment_id);
    if (idx < 0) return false;
    const removed = arr[idx]!;
    arr.splice(idx, 1);
    cur.updated_at = now.toISOString();
    this.writeHistory(
      tenant_id,
      case_id,
      'attachment_deleted',
      { attachment_id, file_name: removed.file_name },
      null,
      deleted_by.trim(),
      now,
    );
    return true;
  }

  setVirusScanStatus(
    tenant_id: string,
    case_id: string,
    attachment_id: string,
    status: AttachmentVirusStatus,
  ): CmsCaseAttachment | null {
    if (!(ATTACHMENT_VIRUS_STATUSES as readonly string[]).includes(status)) {
      throw new CmsCaseError('invalid_input', `bad virus_scan_status ${status}`);
    }
    const arr = this.attachments.get(`${tenant_id}::${case_id}`);
    const a = arr?.find((x) => x.attachment_id === attachment_id);
    if (!a) return null;
    a.virus_scan_status = status;
    return clone(a);
  }

  // ─── Assignment history ──────────────────────────────────────────

  listAssignments(tenant_id: string, case_id: string): CmsCaseAssignment[] {
    return (this.assignments.get(`${tenant_id}::${case_id}`) ?? [])
      .slice()
      .sort((a, b) => (a.assigned_at < b.assigned_at ? 1 : -1))
      .map((a) => clone(a));
  }

  // ─── History ─────────────────────────────────────────────────────

  listHistory(tenant_id: string, case_id: string, limit = 200): CmsCaseHistoryEntry[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > CMS_HISTORY_CAP_PER_CASE) {
      throw new CmsCaseError(
        'invalid_input',
        `limit must be 1..${CMS_HISTORY_CAP_PER_CASE}`,
      );
    }
    return (this.history.get(`${tenant_id}::${case_id}`) ?? [])
      .slice()
      .sort((a, b) => (a.performed_at < b.performed_at ? 1 : -1))
      .slice(0, limit)
      .map((h) => clone(h));
  }
}

export const defaultCmsCaseStore: CmsCaseStore = new InMemoryCmsCaseStore();

// Re-exports for callers
export { CMS_RESOLUTION_CATEGORIES };
