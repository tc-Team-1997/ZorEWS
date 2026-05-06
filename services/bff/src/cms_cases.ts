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
