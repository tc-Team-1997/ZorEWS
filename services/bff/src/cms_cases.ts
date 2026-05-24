// services/bff/src/cms_cases.ts
//
// CMS-1 — types + validator for the EWS Case Management System.
//
// Lives ALONGSIDE the existing M9.1–M9.4 case surface (additive
// only — that work doesn't move). Path prefix /v1/cms/cases/*.
// Architecture map: docs/ews-cms-mapping.md.
//
// CMS-1 ships:
//   - State machine + priority enums + RBAC capability constants
//   - Validators for create / update / transition / assign / close /
//     note / attachment payloads
//   - SLA helpers (computeSlaDueAt, slaProgressPct, isSlaBreached)
//   - Case-number generator (per-tenant per-year monotonic)
//   - Pure type definitions for downstream CMS-2..5 commits
//
// CMS-1 does NOT ship the store, routes, or automation. Those land
// in CMS-2 / CMS-3 / CMS-4.

import { randomUUID } from 'node:crypto';

// ─── Lifecycle states ─────────────────────────────────────────────────

export const CMS_CASE_STATES = [
  'OPEN',
  'ASSIGNED',
  'INVESTIGATING',
  'PENDING_APPROVAL',
  'ESCALATED',
  'CLOSED',
  'REOPENED',
] as const;
export type CmsCaseState = (typeof CMS_CASE_STATES)[number];

export function isCmsCaseState(s: unknown): s is CmsCaseState {
  return typeof s === 'string' && (CMS_CASE_STATES as readonly string[]).includes(s);
}

// Allowed transitions per the brief's diagram. CLOSED→OPEN is the
// reopen path. ESCALATED can de-escalate back to INVESTIGATING. All
// non-CLOSED states can short-cut to ESCALATED.
const ALLOWED: Record<CmsCaseState, CmsCaseState[]> = {
  OPEN: ['ASSIGNED', 'CLOSED'],
  ASSIGNED: ['INVESTIGATING', 'ESCALATED', 'CLOSED'],
  INVESTIGATING: ['PENDING_APPROVAL', 'ESCALATED', 'CLOSED'],
  PENDING_APPROVAL: ['CLOSED', 'INVESTIGATING', 'ESCALATED'],
  ESCALATED: ['INVESTIGATING', 'CLOSED'],
  CLOSED: ['OPEN'], // reopen path; status flips to OPEN, is_locked cleared
  REOPENED: ['ASSIGNED', 'CLOSED'], // alias state (used briefly during reopen)
};

export function isLegalCmsTransition(from: CmsCaseState, to: CmsCaseState): boolean {
  return ALLOWED[from].includes(to);
}

export function legalCmsTransitions(from: CmsCaseState): CmsCaseState[] {
  return [...ALLOWED[from]];
}

// ─── Priority + SLA ──────────────────────────────────────────────────

export const CMS_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type CmsPriority = (typeof CMS_PRIORITIES)[number];

export function isCmsPriority(s: unknown): s is CmsPriority {
  return typeof s === 'string' && (CMS_PRIORITIES as readonly string[]).includes(s);
}

/** SLA window per priority, in milliseconds. Per the brief:
 *  P1=4h, P2=24h, P3=72h, P4=7d. */
export const CMS_SLA_WINDOWS_MS: Record<CmsPriority, number> = {
  P1: 4 * 60 * 60 * 1000,
  P2: 24 * 60 * 60 * 1000,
  P3: 72 * 60 * 60 * 1000,
  P4: 7 * 24 * 60 * 60 * 1000,
};

/** Pure helper. Returns the absolute deadline = anchor + window. */
export function computeSlaDueAt(priority: CmsPriority, anchor: Date): Date {
  return new Date(anchor.getTime() + CMS_SLA_WINDOWS_MS[priority]);
}

/** Pure helper. Returns 0..100+; values ≥ 100 mean SLA breached. */
export function slaProgressPct(now: Date, created_at: Date, sla_due_at: Date): number {
  const total = sla_due_at.getTime() - created_at.getTime();
  if (total <= 0) return 100;
  const elapsed = now.getTime() - created_at.getTime();
  return Math.max(0, Math.round((elapsed / total) * 100));
}

export function isSlaBreached(now: Date, sla_due_at: Date): boolean {
  return now.getTime() >= sla_due_at.getTime();
}

/** Pure helper. Threshold for the "breach warning" flag the SPA
 *  surfaces in yellow before the SLA is fully breached. */
export const CMS_SLA_WARNING_PCT = 80;

// ─── M3.1 SW-3 — Auto-escalate on SLA breach ─────────────────────────
//
// Module 3.1 acceptance: "escalation auto-triggers when SLA breaches by
// configured percentage." Configured fraction lives at the M13.1 key
// `cases.auto_escalate_at_pct` (default 0.8). Eligibility is derived
// from the legal transition map (only states that can legally → ESCALATED
// are considered) so the pure helper stays in lock-step with the state
// machine — no drift if ALLOWED ever gains a new state.

export type AutoEscalateSkipReason =
  | 'already_escalated' // status === 'ESCALATED'
  | 'closed' // status === 'CLOSED'
  | 'unassigned_open' // OPEN — must be ASSIGNED before escalation per state machine
  | 'illegal_transition' // covers REOPENED + any future non-escalatable state
  | 'locked' // is_locked === true
  | 'below_threshold'; // eligible but progress < threshold

export interface AutoEscalateCandidate {
  case_id: string;
  case_number: string;
  status: CmsCaseState;
  priority: CmsPriority;
  assigned_to: string | null;
  created_at: string;
  sla_due_at: string;
  /** 0..100+ — values ≥ 100 mean the SLA is already breached. */
  current_progress_pct: number;
  threshold_pct: number;
  breach_severity: 'imminent' | 'breached';
}

export interface AutoEscalateSkipped {
  case_id: string;
  status: CmsCaseState;
  reason: AutoEscalateSkipReason;
}

export interface AutoEscalatePlan {
  threshold_fraction: number; // 0..1, the config input
  threshold_pct: number; // threshold_fraction × 100, rounded
  total_considered: number;
  candidates: AutoEscalateCandidate[];
  skipped: AutoEscalateSkipped[];
}

/** Pure. Walks cases + returns those eligible to be auto-escalated.
 *  Eligible = (status legally → ESCALATED) AND (not locked) AND
 *  (slaProgressPct ≥ threshold_pct). Every non-eligible case surfaces
 *  in skipped[] with a code so the SPA dry-run preview is transparent.
 *  Candidates sorted worst-first by progress, ties broken by oldest
 *  created_at — most-urgent first. */
export function findAutoEscalationCandidates(
  cases: readonly CmsCase[],
  threshold_fraction: number,
  now: Date,
): AutoEscalatePlan {
  if (!Number.isFinite(threshold_fraction) || threshold_fraction < 0 || threshold_fraction > 1) {
    throw new CmsCaseError(
      'invalid_input',
      'threshold_fraction must be a finite number in [0, 1]',
    );
  }
  const threshold_pct = Math.round(threshold_fraction * 100);
  const candidates: AutoEscalateCandidate[] = [];
  const skipped: AutoEscalateSkipped[] = [];

  for (const c of cases) {
    if (c.status === 'ESCALATED') {
      skipped.push({ case_id: c.case_id, status: c.status, reason: 'already_escalated' });
      continue;
    }
    if (c.status === 'CLOSED') {
      skipped.push({ case_id: c.case_id, status: c.status, reason: 'closed' });
      continue;
    }
    if (c.is_locked) {
      skipped.push({ case_id: c.case_id, status: c.status, reason: 'locked' });
      continue;
    }
    if (c.status === 'OPEN') {
      // OPEN can only legally → ASSIGNED or CLOSED per the state machine.
      // Surface separately so ops knows to assign first.
      skipped.push({ case_id: c.case_id, status: c.status, reason: 'unassigned_open' });
      continue;
    }
    if (!isLegalCmsTransition(c.status, 'ESCALATED')) {
      // Catches REOPENED + any future non-escalatable state.
      skipped.push({ case_id: c.case_id, status: c.status, reason: 'illegal_transition' });
      continue;
    }
    const progress = slaProgressPct(
      now,
      new Date(c.created_at),
      new Date(c.sla_due_at),
    );
    if (progress < threshold_pct) {
      skipped.push({ case_id: c.case_id, status: c.status, reason: 'below_threshold' });
      continue;
    }
    candidates.push({
      case_id: c.case_id,
      case_number: c.case_number,
      status: c.status,
      priority: c.priority,
      assigned_to: c.assigned_to,
      created_at: c.created_at,
      sla_due_at: c.sla_due_at,
      current_progress_pct: progress,
      threshold_pct,
      breach_severity: progress >= 100 ? 'breached' : 'imminent',
    });
  }
  // Sort worst-first (highest progress) — ties broken by oldest created_at.
  candidates.sort(
    (a, b) =>
      b.current_progress_pct - a.current_progress_pct ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  return {
    threshold_fraction,
    threshold_pct,
    total_considered: cases.length,
    candidates,
    skipped,
  };
}

/** Builds the M13.1 audit-trail reason string the route writes per
 *  successful escalation. Encodes the threshold + observed progress so
 *  the audit chain is self-describing. */
export function autoEscalateReason(threshold_pct: number, progress_pct: number): string {
  return `auto_sla_breach@${threshold_pct}%: progress=${progress_pct}%`;
}

// ─── Resolution categories ───────────────────────────────────────────

export const CMS_RESOLUTION_CATEGORIES = [
  'false_positive',
  'confirmed_risk',
  'mitigated',
] as const;
export type CmsResolutionCategory = (typeof CMS_RESOLUTION_CATEGORIES)[number];

export function isCmsResolutionCategory(s: unknown): s is CmsResolutionCategory {
  return (
    typeof s === 'string' &&
    (CMS_RESOLUTION_CATEGORIES as readonly string[]).includes(s)
  );
}

// ─── Attachment whitelist ────────────────────────────────────────────

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
export const ATTACHMENT_MIME_WHITELIST: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
]);

export const ATTACHMENT_VIRUS_STATUSES = [
  'pending',
  'clean',
  'infected',
  'failed',
] as const;
export type AttachmentVirusStatus = (typeof ATTACHMENT_VIRUS_STATUSES)[number];

// ─── Public types ─────────────────────────────────────────────────────

export interface CmsCaseInput {
  title: string;
  description?: string;
  alert_id?: string;
  priority: CmsPriority;
  assigned_to?: string;
  tags?: string[];
}

export interface CmsCaseUpdate {
  title?: string;
  description?: string;
  priority?: CmsPriority;
  tags?: string[];
}

export interface CmsCaseCloseInput {
  resolution_category: CmsResolutionCategory;
  resolution_notes: string;
}

export interface CmsCaseAssignInput {
  assigned_to: string;
  reason?: string;
}

export interface CmsCase {
  case_id: string;
  case_number: string;
  tenant_id: string;
  title: string;
  description: string;
  alert_id: string | null;
  status: CmsCaseState;
  priority: CmsPriority;
  assigned_to: string | null;
  created_by: string;
  sla_due_at: string;
  resolved_at: string | null;
  resolution_category: CmsResolutionCategory | null;
  resolution_notes: string;
  tags: string[];
  is_locked: boolean;
  /** Mirrors app_cases.cms_cases.case_category column from migration 019.
   *  NULL falls through to the resolver's default_fallback when the
   *  dashboard SLA Breach Matrix runs its math. Mutated via the
   *  `setCategory` store method + PATCH /v1/cms/cases/:id/category. */
  case_category: string | null;
  created_at: string;
  updated_at: string;
}

export interface CmsCaseNote {
  note_id: string;
  case_id: string;
  tenant_id: string;
  user_id: string;
  note_text: string;
  is_internal: boolean;
  created_at: string;
}

export interface CmsCaseAttachment {
  attachment_id: string;
  case_id: string;
  tenant_id: string;
  file_name: string;
  file_url: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string;
  virus_scan_status: AttachmentVirusStatus;
  created_at: string;
}

export interface CmsCaseAssignment {
  assignment_id: string;
  case_id: string;
  tenant_id: string;
  assigned_to: string;
  assigned_by: string;
  assigned_at: string;
  unassigned_at: string | null;
  reason: string | null;
}

export interface CmsCaseHistoryEntry {
  history_id: string;
  case_id: string;
  tenant_id: string;
  action_type: string;
  old_value: unknown;
  new_value: unknown;
  performed_by: string;
  performed_at: string;
}

// ─── Errors ───────────────────────────────────────────────────────────

export class CmsCaseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CmsCaseError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────

const TITLE_CAP = 200;
const DESC_CAP = 4000;
const NOTE_CAP = 8000;
const TAG_CAP = 32;
const TAG_MAX = 16;
const FILE_NAME_CAP = 200;

function checkString(name: string, v: unknown, cap: number, required: boolean): string | null {
  if (v === undefined || v === null) {
    if (required) {
      throw new CmsCaseError('invalid_input', `${name} is required`);
    }
    return null;
  }
  if (typeof v !== 'string') {
    throw new CmsCaseError('invalid_input', `${name} must be a string`);
  }
  const t = v.trim();
  if (required && t.length === 0) {
    throw new CmsCaseError('invalid_input', `${name} is required`);
  }
  if (t.length > cap) {
    throw new CmsCaseError('invalid_input', `${name} ≤ ${cap} chars`);
  }
  return t.length === 0 ? null : t;
}

function checkTags(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new CmsCaseError('invalid_input', 'tags must be an array');
  }
  if (v.length > TAG_MAX) {
    throw new CmsCaseError('invalid_input', `at most ${TAG_MAX} tags`);
  }
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string' || !t.trim()) {
      throw new CmsCaseError('invalid_input', 'tag must be a non-empty string');
    }
    if (t.length > TAG_CAP) {
      throw new CmsCaseError('invalid_input', `tag ≤ ${TAG_CAP} chars`);
    }
    out.push(t.trim());
  }
  return out;
}

export function validateCmsCaseInput(input: unknown): CmsCaseInput {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const title = checkString('title', i.title, TITLE_CAP, true)!;
  const description = checkString('description', i.description, DESC_CAP, false) ?? '';
  const alert_id = checkString('alert_id', i.alert_id, 64, false);
  if (!isCmsPriority(i.priority)) {
    throw new CmsCaseError(
      'invalid_input',
      `priority must be one of ${CMS_PRIORITIES.join(', ')}`,
    );
  }
  const assigned_to = checkString('assigned_to', i.assigned_to, 64, false);
  const tags = checkTags(i.tags);
  return {
    title,
    description: description || undefined,
    alert_id: alert_id ?? undefined,
    priority: i.priority,
    assigned_to: assigned_to ?? undefined,
    tags,
  };
}

export function validateCmsCaseUpdate(input: unknown): CmsCaseUpdate {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const out: CmsCaseUpdate = {};
  if (i.title !== undefined) out.title = checkString('title', i.title, TITLE_CAP, true)!;
  if (i.description !== undefined) {
    const d = checkString('description', i.description, DESC_CAP, false);
    out.description = d ?? '';
  }
  if (i.priority !== undefined) {
    if (!isCmsPriority(i.priority)) {
      throw new CmsCaseError(
        'invalid_input',
        `priority must be one of ${CMS_PRIORITIES.join(', ')}`,
      );
    }
    out.priority = i.priority;
  }
  if (i.tags !== undefined) out.tags = checkTags(i.tags);
  if (Object.keys(out).length === 0) {
    throw new CmsCaseError('invalid_input', 'update body must contain at least one mutable field');
  }
  return out;
}

export function validateCmsCaseClose(input: unknown): CmsCaseCloseInput {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (!isCmsResolutionCategory(i.resolution_category)) {
    throw new CmsCaseError(
      'invalid_input',
      `resolution_category must be one of ${CMS_RESOLUTION_CATEGORIES.join(', ')}`,
    );
  }
  const notes = checkString('resolution_notes', i.resolution_notes, NOTE_CAP, true)!;
  return { resolution_category: i.resolution_category, resolution_notes: notes };
}

export function validateCmsCaseAssign(input: unknown): CmsCaseAssignInput {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const assigned_to = checkString('assigned_to', i.assigned_to, 64, true)!;
  const reason = checkString('reason', i.reason, NOTE_CAP, false) ?? undefined;
  return { assigned_to, reason };
}

export function validateCmsCaseTransition(input: unknown): { target: CmsCaseState } {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (!isCmsCaseState(i.target)) {
    throw new CmsCaseError(
      'invalid_input',
      `target must be one of ${CMS_CASE_STATES.join(', ')}`,
    );
  }
  return { target: i.target };
}

export function validateCmsCaseNote(input: unknown): {
  note_text: string;
  is_internal: boolean;
} {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const note_text = checkString('note_text', i.note_text, NOTE_CAP, true)!;
  const is_internal = i.is_internal === undefined ? true : i.is_internal === true;
  return { note_text, is_internal };
}

export function validateCmsAttachmentMeta(input: unknown): {
  file_name: string;
  file_size: number;
  mime_type: string;
} {
  if (!input || typeof input !== 'object') {
    throw new CmsCaseError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  const file_name = checkString('file_name', i.file_name, FILE_NAME_CAP, true)!;
  if (
    typeof i.file_size !== 'number' ||
    !Number.isFinite(i.file_size) ||
    i.file_size <= 0
  ) {
    throw new CmsCaseError('invalid_input', 'file_size must be a positive number');
  }
  if (i.file_size > ATTACHMENT_MAX_BYTES) {
    throw new CmsCaseError(
      'invalid_input',
      `file_size > ${ATTACHMENT_MAX_BYTES} bytes (cap 20 MB)`,
    );
  }
  if (typeof i.mime_type !== 'string' || !i.mime_type.trim()) {
    throw new CmsCaseError('invalid_input', 'mime_type required');
  }
  if (!ATTACHMENT_MIME_WHITELIST.has(i.mime_type)) {
    throw new CmsCaseError(
      'invalid_mime_type',
      `${i.mime_type} not in attachment whitelist`,
    );
  }
  return { file_name, file_size: i.file_size, mime_type: i.mime_type };
}

// ─── Case-number generator ───────────────────────────────────────────

const CASE_NUMBER_RE = /^EWS-\d{4}-\d{5}$/;

export function isCmsCaseNumber(s: unknown): s is string {
  return typeof s === 'string' && CASE_NUMBER_RE.test(s);
}

/** Format the canonical case number string. Per-tenant per-year
 *  counter is supplied by the caller — store advances it on every
 *  create. Pad to 5 digits ('00001'..'99999'). */
export function formatCmsCaseNumber(year: number, seq: number): string {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) {
    throw new CmsCaseError('invalid_input', 'year out of range');
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > 99_999) {
    throw new CmsCaseError('invalid_input', 'seq out of range (1..99999)');
  }
  return `EWS-${year}-${String(seq).padStart(5, '0')}`;
}

// ─── Round-robin assignment ──────────────────────────────────────────

/** Pure helper — picks the next assignee given the active pool +
 *  the previous assignment. Returns null when pool is empty. */
export function pickNextAssignee(
  pool: readonly string[],
  lastAssignedTo: string | null,
): string | null {
  if (pool.length === 0) return null;
  if (!lastAssignedTo) return pool[0]!;
  const idx = pool.indexOf(lastAssignedTo);
  if (idx < 0) return pool[0]!;
  return pool[(idx + 1) % pool.length]!;
}

// ─── UUID helper (re-exported so tests don't depend on node:crypto) ──

export function generateCaseId(): string {
  return randomUUID();
}
