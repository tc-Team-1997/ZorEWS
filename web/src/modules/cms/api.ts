// web/src/modules/cms/api.ts
//
// CMS-5 — typed API client for the /v1/cms/cases/* surface (CMS-3 + CMS-4).
// Intentionally a thin wrapper — the SPA's existing http client already
// stamps tenant + role + user headers via interceptors.

import { http } from '@/lib/http';

// ─── Types (mirror BFF cms_cases.ts) ─────────────────────────────────

export type CmsCaseState =
  | 'OPEN'
  | 'ASSIGNED'
  | 'INVESTIGATING'
  | 'PENDING_APPROVAL'
  | 'ESCALATED'
  | 'CLOSED'
  | 'REOPENED';

export type CmsPriority = 'P1' | 'P2' | 'P3' | 'P4';

export type CmsResolutionCategory = 'false_positive' | 'confirmed_risk' | 'mitigated';

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
  /** Re-categorisable via PATCH /v1/cms/cases/:id/category. NULL falls
   *  through to default_fallback in the dashboard SLA Breach Matrix. */
  case_category?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CmsCaseDetail extends CmsCase {
  assignments: Array<{
    assignment_id: string;
    assigned_to: string;
    assigned_by: string;
    assigned_at: string;
    unassigned_at: string | null;
    reason: string | null;
  }>;
  notes_count: number;
  attachments_count: number;
  sla: {
    due_at: string;
    progress_pct: number;
    breached: boolean;
    warning: boolean;
  };
}

export interface CmsCaseNote {
  note_id: string;
  case_id: string;
  user_id: string;
  note_text: string;
  is_internal: boolean;
  created_at: string;
}

export interface CmsCaseAttachment {
  attachment_id: string;
  case_id: string;
  file_name: string;
  file_url: string;
  file_size: number;
  mime_type: string;
  uploaded_by: string;
  virus_scan_status: 'pending' | 'clean' | 'infected' | 'failed';
  created_at: string;
}

export interface CmsHistoryEntry {
  history_id: string;
  case_id: string;
  action_type: string;
  old_value: unknown;
  new_value: unknown;
  performed_by: string;
  performed_at: string;
}

// ─── Tracking timeline (BAC §3.1.5) ─────────────────────────────────

export type TrackingEventType =
  | 'STATUS_CHANGE'
  | 'COMMENT'
  | 'ATTACHMENT'
  | 'ASSIGNMENT_CHANGE'
  | 'ESCALATION'
  | 'CAUSAL_ANALYSIS_UPDATE'
  | 'CAP_UPDATE'
  | 'APPROVAL';

export interface StatusChangePayload {
  from_status: string;
  to_status: string;
}
export interface CommentPayload {
  note_id: string;
  snippet: string;
  is_internal: boolean;
}
export interface AttachmentPayload {
  attachment_id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  change: 'added' | 'deleted';
}
export interface AssignmentChangePayload {
  assigned_from: string | null;
  assigned_to: string | null;
}
export interface EscalationPayload {
  reason: string | null;
}
export interface StubPayload {
  stub: true;
  message: string;
}

export type TrackingPayload =
  | StatusChangePayload
  | CommentPayload
  | AttachmentPayload
  | AssignmentChangePayload
  | EscalationPayload
  | StubPayload;

export interface TrackingEvent {
  event_id: string;
  case_id: string;
  type: TrackingEventType;
  ts: string;
  actor: string;
  linkable: boolean;
  locked?: { reason: string };
  payload: TrackingPayload;
  href?: string;
}

export interface TrackingResponse {
  case_id: string;
  items: TrackingEvent[];
  total: number;
  generated_at: string;
}

export interface CmsStats {
  total: number;
  by_status: Record<CmsCaseState, number>;
  by_priority: Record<CmsPriority, number>;
  sla_breached_count: number;
  sla_warning_count: number;
  avg_resolution_hours: number | null;
}

export interface CmsSlaBreach {
  case_id: string;
  case_number: string;
  title: string;
  priority: CmsPriority;
  assigned_to: string | null;
  status: CmsCaseState;
  sla_due_at: string;
  overshoot_hours: number;
  progress_pct: number;
}

// Module 3.1 — auto-escalate SLA result envelope (mirrors BFF
// services/bff/src/cms_cases.ts AutoEscalatePlan + route additions).
export type AutoEscalateSkipReason =
  | 'already_escalated'
  | 'closed'
  | 'unassigned_open'
  | 'illegal_transition'
  | 'locked'
  | 'below_threshold';

export interface CmsAutoEscalateCandidate {
  case_id: string;
  case_number: string;
  status: CmsCaseState;
  priority: CmsPriority;
  assigned_to: string | null;
  created_at: string;
  sla_due_at: string;
  current_progress_pct: number;
  threshold_pct: number;
  breach_severity: 'imminent' | 'breached';
}

export interface CmsAutoEscalateSkipped {
  case_id: string;
  status: CmsCaseState;
  reason: AutoEscalateSkipReason;
}

export interface CmsAutoEscalateResult {
  tenant_id: string;
  generated_at: string;
  dry_run: boolean;
  threshold_fraction: number;
  threshold_pct: number;
  total_considered: number;
  would_escalate: number;
  candidates: CmsAutoEscalateCandidate[];
  skipped: CmsAutoEscalateSkipped[];
  escalated: Array<{ case_id: string; case_number: string; progress_pct: number; reason: string }>;
  errors: Array<{ case_id: string; code: string; message: string }>;
}

export interface CmsListFilters {
  status?: CmsCaseState;
  priority?: CmsPriority;
  assigned_to?: string;
  alert_id?: string;
  q?: string;
  case_number?: string;
  tags?: string;
  since?: string;
  until?: string;
  /** Server-side: keep only cases past their SLA target per app_admin.sla_config. */
  breached?: boolean;
}

// ─── API ─────────────────────────────────────────────────────────────

const cmsBase = '/v1/cms/cases';

// http.ts now auto-unwraps the {header, body} envelope at the response
// interceptor, so `r.data` IS the body. For test setups that mock
// http.get directly with the raw envelope shape (`{ data: { body: T } }`),
// fall through and unwrap one more level so call sites stay shape-agnostic.
function unwrap<T>(p: Promise<{ data: T | { body: T } }>) {
  return p.then((r) => {
    const d = r.data as { body?: T } | T;
    if (d && typeof d === 'object' && 'body' in d && (d as { body: T }).body !== undefined) {
      return (d as { body: T }).body;
    }
    return d as T;
  });
}

export const cmsApi = {
  list: (params: CmsListFilters = {}) =>
    unwrap<{ items: CmsCase[]; total: number }>(http.get(cmsBase, { params })),

  detail: (case_id: string) =>
    unwrap<CmsCaseDetail>(http.get(`${cmsBase}/${case_id}`)),

  create: (body: Partial<CmsCase> & { title: string; priority: CmsPriority }) =>
    unwrap<CmsCase>(http.post(cmsBase, body)),

  update: (case_id: string, body: Record<string, unknown>) =>
    unwrap<CmsCase>(http.patch(`${cmsBase}/${case_id}`, body)),

  setCategory: (case_id: string, case_category: string | null, reason?: string) =>
    unwrap<CmsCase>(
      http.patch(`${cmsBase}/${case_id}/category`, { case_category, reason }),
    ),

  transition: (case_id: string, target: CmsCaseState) =>
    unwrap<CmsCase>(http.post(`${cmsBase}/${case_id}/transition`, { target })),

  assign: (case_id: string, assigned_to: string, reason?: string) =>
    unwrap<CmsCase>(http.post(`${cmsBase}/${case_id}/assign`, { assigned_to, reason })),

  escalate: (case_id: string, reason?: string) =>
    unwrap<CmsCase>(http.post(`${cmsBase}/${case_id}/escalate`, { reason })),

  close: (
    case_id: string,
    resolution_category: CmsResolutionCategory,
    resolution_notes: string,
  ) =>
    unwrap<CmsCase>(
      http.post(`${cmsBase}/${case_id}/close`, { resolution_category, resolution_notes }),
    ),

  notes: {
    list: (case_id: string) =>
      unwrap<{ items: CmsCaseNote[]; total: number }>(http.get(`${cmsBase}/${case_id}/notes`)),
    add: (case_id: string, note_text: string, is_internal = true) =>
      unwrap<CmsCaseNote>(http.post(`${cmsBase}/${case_id}/notes`, { note_text, is_internal })),
  },

  attachments: {
    list: (case_id: string) =>
      unwrap<{ items: CmsCaseAttachment[]; total: number }>(
        http.get(`${cmsBase}/${case_id}/attachments`),
      ),
    add: (case_id: string, meta: { file_name: string; file_size: number; mime_type: string }) =>
      unwrap<CmsCaseAttachment>(http.post(`${cmsBase}/${case_id}/attachments`, meta)),
    remove: (case_id: string, attachment_id: string) =>
      http.delete(`${cmsBase}/${case_id}/attachments/${attachment_id}`),
  },

  history: (case_id: string, limit = 50) =>
    unwrap<{ items: CmsHistoryEntry[]; total: number }>(
      http.get(`${cmsBase}/${case_id}/history`, { params: { limit } }),
    ),

  /** GET /v1/cms/cases/:case_id/tracking?include_stubs= — typed
   *  tracking timeline used by <CaseTrackingTimeline /> on the
   *  case detail page (BAC §3.1.5). */
  tracking: (case_id: string, include_stubs = false) =>
    unwrap<TrackingResponse>(
      http.get(`${cmsBase}/${case_id}/tracking`, {
        params: include_stubs ? { include_stubs: 'true' } : undefined,
      }),
    ),

  stats: () => unwrap<CmsStats>(http.get(`${cmsBase}/stats`)),
  slaBreaches: () =>
    unwrap<{ items: CmsSlaBreach[]; total: number }>(http.get(`${cmsBase}/sla-breaches`)),

  // Module 3.1 — auto-escalate non-closed cases whose SLA progress
  // crosses the configured threshold. dry_run=true returns the plan
  // without mutating. threshold_pct_override overrides M13.1 config
  // for one-off triggering at a tighter/looser threshold.
  autoEscalateSla: (
    opts: { dry_run?: boolean; threshold_pct_override?: number } = {},
  ) =>
    unwrap<CmsAutoEscalateResult>(
      http.post(`${cmsBase}/auto-escalate-sla`, {
        dry_run: opts.dry_run ?? false,
        threshold_pct_override: opts.threshold_pct_override,
      }),
    ),

  bulkAssign: (case_ids: string[], assigned_to: string, reason?: string) =>
    unwrap<{
      rows: Array<{ case_id: string; status: 'ok' | 'unknown_case' | 'case_locked' | 'invalid_input'; reason?: string }>;
      ok_count: number;
      total: number;
    }>(http.post(`${cmsBase}/bulk-assign`, { case_ids, assigned_to, reason })),

  // Automation (CMS-4)
  pool: {
    get: () =>
      unwrap<{ tenant_id: string; members: string[]; updated_at: string; updated_by: string }>(
        http.get('/v1/cms/automation/pool'),
      ),
    set: (members: string[]) =>
      unwrap<{ tenant_id: string; members: string[] }>(
        http.put('/v1/cms/automation/pool', { members }),
      ),
  },
  assignFromPool: (case_id: string) =>
    unwrap<CmsCase>(http.post(`${cmsBase}/${case_id}/assign-from-pool`, {})),
  inactiveCases: (threshold_hours = 48) =>
    unwrap<{ items: Array<CmsCase & { inactive_hours: number }>; total: number; threshold_hours: number }>(
      http.get('/v1/cms/automation/inactive-cases', { params: { threshold_hours } }),
    ),
};

// ─── UI helpers ──────────────────────────────────────────────────────

export const PRIORITY_TONE: Record<CmsPriority, string> = {
  P1: 'danger',
  P2: 'warning',
  P3: 'neutral',
  P4: 'success',
};

export const STATUS_TONE: Record<CmsCaseState, string> = {
  OPEN: 'neutral',
  ASSIGNED: 'blue',
  INVESTIGATING: 'warning',
  PENDING_APPROVAL: 'warning',
  ESCALATED: 'danger',
  CLOSED: 'success',
  REOPENED: 'blue',
};

export const KANBAN_COLUMNS: CmsCaseState[] = [
  'OPEN',
  'ASSIGNED',
  'INVESTIGATING',
  'PENDING_APPROVAL',
  'ESCALATED',
  'CLOSED',
];

/** Cards in column X can shortcut to these states via quick-action buttons. */
export const QUICK_TRANSITIONS: Record<CmsCaseState, CmsCaseState[]> = {
  OPEN: ['ASSIGNED', 'CLOSED'],
  ASSIGNED: ['INVESTIGATING', 'ESCALATED'],
  INVESTIGATING: ['PENDING_APPROVAL', 'ESCALATED'],
  PENDING_APPROVAL: ['INVESTIGATING'],
  ESCALATED: ['INVESTIGATING'],
  CLOSED: ['OPEN'],
  REOPENED: ['ASSIGNED'],
};
