// services/bff/src/cms/case_tracking.ts
//
// Per-case tracking timeline resolver — wraps the existing CmsCaseHistory
// rows with type discrimination + payload context so the SPA's
// /cms/cases/:id Timeline tab can render each card as a clickable
// drill-down with appropriate per-type behaviour.
//
// Cross-service event sources (Causal Analysis / CAP / approval trail
// from `services/regulatory-svc/cases`) aren't joined into the BFF
// today. Stub events for those types are emitted only when explicitly
// asked for via `include_stubs: true` so the SPA can demo the
// navigation without misleading auditors.

import type {
  CmsCase,
  CmsCaseAttachment,
  CmsCaseHistoryEntry,
  CmsCaseNote,
} from '../cms_cases';

// ─── Public types ─────────────────────────────────────────────────────

export const TRACKING_EVENT_TYPES = [
  'STATUS_CHANGE',
  'COMMENT',
  'ATTACHMENT',
  'ASSIGNMENT_CHANGE',
  'ESCALATION',
  'CAUSAL_ANALYSIS_UPDATE',
  'CAP_UPDATE',
  'APPROVAL',
] as const;

export type TrackingEventType = (typeof TRACKING_EVENT_TYPES)[number];

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
  /** history_id reused so `?tracking=event_id` round-trips through the URL. */
  event_id: string;
  case_id: string;
  type: TrackingEventType;
  ts: string;
  actor: string;
  /** False when the actor lacks the role to interact (e.g. ATTACHMENT
   *  without `cases:download_attachment`). The SPA renders a locked
   *  icon + tooltip in that case. */
  linkable: boolean;
  /** Set only when `linkable=false` so the SPA can show the reason. */
  locked?: { reason: string };
  payload: TrackingPayload;
  /** Pre-baked deep-link target — the SPA may override per-type
   *  (e.g. open a modal vs navigate). */
  href?: string;
}

export interface ComputeTrackingInput {
  tenant_id: string;
  case_id: string;
  /** Newest-first or oldest-first — resolver re-sorts to newest-first. */
  history: CmsCaseHistoryEntry[];
  /** Used to short-list the snippet on COMMENT events. Optional — when
   *  absent, snippet falls back to `<text omitted>`. */
  notes?: CmsCaseNote[];
  /** Used to enrich ATTACHMENT events with mime/size/file_name when
   *  history entries don't carry the full row. */
  attachments?: CmsCaseAttachment[];
  /** Caller's role — drives `cases:download_attachment` gating. The
   *  resolver doesn't depend on the matrix.json directly so it stays
   *  pure + testable; the route layer hands the right boolean in. */
  canDownloadAttachment: boolean;
  /** When true, append CAUSAL_ANALYSIS_UPDATE / CAP_UPDATE / APPROVAL
   *  stub events. Default false so the response is honest by default. */
  include_stubs?: boolean;
}

export interface ComputeTrackingResult {
  case_id: string;
  items: TrackingEvent[];
  total: number;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function computeCaseTracking(input: ComputeTrackingInput): ComputeTrackingResult {
  const noteById = new Map<string, CmsCaseNote>();
  for (const n of input.notes ?? []) noteById.set(n.note_id, n);
  const attById = new Map<string, CmsCaseAttachment>();
  for (const a of input.attachments ?? []) attById.set(a.attachment_id, a);

  const items: TrackingEvent[] = [];

  for (const h of input.history) {
    const mapped = mapHistoryEntry(h, input, noteById, attById);
    if (mapped) items.push(mapped);
  }

  if (input.include_stubs) {
    items.push(...stubEvents(input.case_id));
  }

  // Newest-first (history rows come in either order — re-sort defensively).
  items.sort((a, b) => b.ts.localeCompare(a.ts));

  return {
    case_id: input.case_id,
    items,
    total: items.length,
  };
}

// ─── Per-action mapper ─────────────────────────────────────────────────

function mapHistoryEntry(
  h: CmsCaseHistoryEntry,
  input: ComputeTrackingInput,
  noteById: Map<string, CmsCaseNote>,
  attById: Map<string, CmsCaseAttachment>,
): TrackingEvent | null {
  const base = {
    event_id: h.history_id,
    case_id: h.case_id,
    ts: h.performed_at,
    actor: h.performed_by,
  };

  switch (h.action_type) {
    case 'transition':
    case 'reopen': {
      const before = (h.old_value ?? null) as Partial<CmsCase> | null;
      const after = (h.new_value ?? null) as Partial<CmsCase> | null;
      return {
        ...base,
        type: 'STATUS_CHANGE',
        linkable: true,
        payload: {
          from_status: String(before?.status ?? '?'),
          to_status: String(after?.status ?? '?'),
        },
      };
    }
    case 'note_added': {
      const after = (h.new_value ?? {}) as { note_id?: string; is_internal?: boolean };
      const noteId = after.note_id ?? '';
      const note = noteId ? noteById.get(noteId) : undefined;
      const snippet = note ? snip(note.note_text) : '<text omitted>';
      return {
        ...base,
        type: 'COMMENT',
        linkable: true,
        payload: {
          note_id: noteId,
          snippet,
          is_internal: !!(note?.is_internal ?? after.is_internal),
        },
        href: `/cms/cases/${h.case_id}?tab=Investigation&note=${encodeURIComponent(noteId)}`,
      };
    }
    case 'attachment_added':
    case 'attachment_deleted': {
      const after = (h.new_value ?? {}) as {
        attachment_id?: string;
        file_name?: string;
        mime_type?: string;
        file_size?: number;
      };
      const attId = after.attachment_id ?? '';
      const att = attId ? attById.get(attId) : undefined;
      const change: 'added' | 'deleted' =
        h.action_type === 'attachment_added' ? 'added' : 'deleted';
      const linkable = input.canDownloadAttachment;
      const out: TrackingEvent = {
        ...base,
        type: 'ATTACHMENT',
        linkable,
        payload: {
          attachment_id: attId,
          file_name: att?.file_name ?? after.file_name ?? '(unknown)',
          mime: att?.mime_type ?? after.mime_type ?? 'application/octet-stream',
          size_bytes: Number(att?.file_size ?? after.file_size ?? 0),
          change,
        },
      };
      if (!linkable) {
        out.locked = { reason: 'needs cases:download_attachment' };
      }
      return out;
    }
    case 'assign': {
      const before = (h.old_value ?? {}) as { assigned_to?: string | null };
      const after = (h.new_value ?? {}) as { assigned_to?: string | null };
      return {
        ...base,
        type: 'ASSIGNMENT_CHANGE',
        linkable: true,
        payload: {
          assigned_from: (before.assigned_to ?? null) || null,
          assigned_to: (after.assigned_to ?? null) || null,
        },
      };
    }
    case 'escalate': {
      const after = (h.new_value ?? {}) as { reason?: string | null };
      return {
        ...base,
        type: 'ESCALATION',
        linkable: true,
        payload: { reason: after.reason ?? null },
      };
    }
    // 'create', 'update', 'close' aren't surfaced as tracking events —
    // they're either implicit (create) or covered by status change.
    case 'create':
    case 'update':
    case 'close':
      return null;
    default:
      return null;
  }
}

function snip(s: string, max = 80): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

// ─── Cross-service stubs ───────────────────────────────────────────────

function stubEvents(case_id: string): TrackingEvent[] {
  const ts = new Date(0).toISOString(); // deterministic stub timestamp
  return [
    {
      event_id: `stub-cas-${case_id}`,
      case_id,
      type: 'CAUSAL_ANALYSIS_UPDATE',
      ts,
      actor: 'system',
      linkable: true,
      payload: {
        stub: true,
        message: 'Cross-service feed pending — placeholder navigation only.',
      },
      href: `/cms/cases/${case_id}/causal-analysis`,
    },
    {
      event_id: `stub-cap-${case_id}`,
      case_id,
      type: 'CAP_UPDATE',
      ts,
      actor: 'system',
      linkable: true,
      payload: {
        stub: true,
        message: 'Cross-service feed pending — placeholder navigation only.',
      },
      href: `/cms/cases/${case_id}/cap`,
    },
    {
      event_id: `stub-approval-${case_id}`,
      case_id,
      type: 'APPROVAL',
      ts,
      actor: 'system',
      linkable: true,
      payload: {
        stub: true,
        message: 'Maker-checker trail pending — placeholder modal only.',
      },
    },
  ];
}
