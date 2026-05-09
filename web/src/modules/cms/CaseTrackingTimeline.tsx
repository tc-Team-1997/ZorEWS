// Per-case clickable tracking timeline (BAC §3.1.5).
//
// Each event card is a real <button>: keyboard accessible, min-h 44px
// for mobile tap targets, hover tooltip, role-aware locked state for
// ATTACHMENT events. Click behaviour fans out per event_type:
//   STATUS_CHANGE     → modal showing from→to + ts
//   COMMENT           → switch to Investigation tab + scroll/highlight
//   ATTACHMENT        → download href if linkable, else no-op + toast
//   ASSIGNMENT_CHANGE → mini-card popover (assignee)
//   ESCALATION        → modal with reason
//   CAUSAL_ANALYSIS_UPDATE / CAP_UPDATE → navigate to placeholder page
//   APPROVAL          → modal with "pending integration" disclaimer
//
// URL state: `?tracking=event_id` opens that event automatically on
// mount + on every change to the URL.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  ChevronRight,
  FileText,
  Lock,
  MessageSquare,
  Paperclip,
  ShieldCheck,
  Sparkles,
  UserPlus,
  X,
} from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import {
  cmsApi,
  type AttachmentPayload,
  type CommentPayload,
  type EscalationPayload,
  type StatusChangePayload,
  type StubPayload,
  type AssignmentChangePayload,
  type TrackingEvent,
  type TrackingEventType,
} from './api';

// ── Tone + icon table ─────────────────────────────────────────────────

const TYPE_META: Record<
  TrackingEventType,
  { label: string; icon: typeof FileText; tint: string }
> = {
  STATUS_CHANGE:          { label: 'Status change',     icon: ArrowRight,    tint: 'text-blue-700 bg-blue-50' },
  COMMENT:                { label: 'Comment',           icon: MessageSquare, tint: 'text-slate-700 bg-slate-100' },
  ATTACHMENT:             { label: 'Attachment',        icon: Paperclip,     tint: 'text-amber-700 bg-amber-50' },
  ASSIGNMENT_CHANGE:      { label: 'Assignment',        icon: UserPlus,      tint: 'text-emerald-700 bg-emerald-50' },
  ESCALATION:             { label: 'Escalation',        icon: AlertTriangle, tint: 'text-rose-700 bg-rose-50' },
  CAUSAL_ANALYSIS_UPDATE: { label: 'Causal analysis',   icon: Sparkles,      tint: 'text-violet-700 bg-violet-50' },
  CAP_UPDATE:             { label: 'CAP',               icon: FileText,      tint: 'text-violet-700 bg-violet-50' },
  APPROVAL:               { label: 'Approval',          icon: ShieldCheck,   tint: 'text-emerald-700 bg-emerald-50' },
};

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function bytesPretty(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Component ─────────────────────────────────────────────────────────

interface Props {
  caseId: string;
  /** Notify parent when the user clicks a COMMENT card so the parent can
   *  switch tabs + scroll to the matching note_id. */
  onJumpToComment?: (note_id: string) => void;
}

export function CaseTrackingTimeline({ caseId, onJumpToComment }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Stubs hidden by default; admin-tunable via the toggle so demos can
  // reach the placeholder pages without polluting auditor views.
  const [showStubs, setShowStubs] = useState(false);

  const q = useQuery({
    queryKey: ['cms-case-tracking', caseId, showStubs],
    queryFn: () => cmsApi.tracking(caseId, showStubs),
    enabled: !!caseId,
  });

  // Auto-open the event matching ?tracking=event_id (also re-runs when
  // the URL changes, e.g. user clicks a deep-link from the audit page).
  const focusId = searchParams.get('tracking');
  const [activeEvent, setActiveEvent] = useState<TrackingEvent | null>(null);

  useEffect(() => {
    if (!focusId || !q.data) return;
    const found = q.data.items.find((i) => i.event_id === focusId);
    if (found) handleClick(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, q.data]);

  function clearFocusParam(): void {
    if (!searchParams.has('tracking')) return;
    const sp = new URLSearchParams(searchParams);
    sp.delete('tracking');
    setSearchParams(sp, { replace: true });
  }

  function handleClick(ev: TrackingEvent): void {
    if (!ev.linkable) return; // locked attachment etc.
    switch (ev.type) {
      case 'COMMENT': {
        const p = ev.payload as CommentPayload;
        if (onJumpToComment) onJumpToComment(p.note_id);
        // Also sync URL so /tab=Investigation surfaces
        if (ev.href) navigate(ev.href);
        break;
      }
      case 'ATTACHMENT': {
        // For now: open the attachments tab on the same page so the user
        // can find the file. Real prod would resolve a presigned URL.
        navigate(`/cms/cases/${ev.case_id}?tab=Investigation&attachment=${
          encodeURIComponent((ev.payload as AttachmentPayload).attachment_id)
        }`);
        break;
      }
      case 'CAUSAL_ANALYSIS_UPDATE':
      case 'CAP_UPDATE':
        if (ev.href) navigate(ev.href);
        break;
      case 'STATUS_CHANGE':
      case 'ESCALATION':
      case 'ASSIGNMENT_CHANGE':
      case 'APPROVAL':
      default:
        setActiveEvent(ev);
        break;
    }
  }

  const items = q.data?.items ?? [];
  const hasStubs = useMemo(
    () => items.some((i) =>
      i.type === 'CAUSAL_ANALYSIS_UPDATE' ||
      i.type === 'CAP_UPDATE' ||
      i.type === 'APPROVAL'),
    [items],
  );

  return (
    <Panel
      title="Tracking timeline"
      data-testid="case-tracking-timeline"
      action={
        <label className="flex items-center gap-1 text-[11px] text-slate-500">
          <input
            type="checkbox"
            data-testid="tracking-include-stubs"
            checked={showStubs}
            onChange={(e) => setShowStubs(e.target.checked)}
          />
          Include CAS / CAP / approval stubs
        </label>
      }
    >
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-slate-500" data-testid="tracking-loading">
          Loading timeline…
        </p>
      ) : q.isError ? (
        <p
          role="alert"
          className="py-6 text-center text-sm text-rose-700"
          data-testid="tracking-error"
        >
          Failed to load tracking: {(q.error as Error)?.message}
        </p>
      ) : items.length === 0 ? (
        <p
          className="py-6 text-center text-sm text-slate-500"
          data-testid="tracking-empty"
        >
          No tracking events yet — assign, escalate, comment, or attach a file to
          populate this timeline.
        </p>
      ) : (
        <ol className="space-y-2" data-testid="tracking-list">
          {items.map((ev) => (
            <TimelineCard key={ev.event_id} ev={ev} onClick={() => handleClick(ev)} />
          ))}
        </ol>
      )}

      {showStubs && hasStubs && (
        <p className="mt-3 text-[11px] italic text-slate-500">
          Stub events (CAS / CAP / approval) come from{' '}
          <code>services/regulatory-svc/cases</code> and aren't joined into the BFF
          feed yet — clicks navigate to placeholder pages.
        </p>
      )}

      {activeEvent && (
        <EventDetailModal
          event={activeEvent}
          onClose={() => {
            setActiveEvent(null);
            clearFocusParam();
          }}
        />
      )}
    </Panel>
  );
}

// ── Card (the clickable button per event) ─────────────────────────────

function TimelineCard({ ev, onClick }: { ev: TrackingEvent; onClick: () => void }) {
  const meta = TYPE_META[ev.type];
  const Icon = meta.icon;
  const summary = summarise(ev);
  const disabled = !ev.linkable;
  const tooltip = ev.locked?.reason
    ? `Insufficient permission — ${ev.locked.reason}`
    : 'Click to view details';

  return (
    <li>
      <button
        type="button"
        data-testid={`tracking-card-${ev.event_id}`}
        data-event-type={ev.type}
        data-linkable={ev.linkable}
        onClick={onClick}
        disabled={disabled}
        title={tooltip}
        aria-label={`${meta.label} by ${ev.actor} at ${fmtTs(ev.ts)}`}
        className={`flex w-full min-h-[44px] items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-left transition-colors ${
          disabled
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:border-slate-400 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-300'
        }`}
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta.tint}`}
          aria-hidden
        >
          <Icon size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs text-slate-500">
            <Badge tone="neutral">{meta.label}</Badge>
            <span className="tabular">{fmtTs(ev.ts)}</span>
            <span>·</span>
            <span className="font-medium text-slate-700">{ev.actor}</span>
          </span>
          <span className="mt-0.5 block text-sm text-slate-800">{summary}</span>
        </span>
        {disabled ? (
          <Lock size={14} className="text-slate-400" data-testid={`tracking-locked-${ev.event_id}`} />
        ) : (
          <ChevronRight size={14} className="text-slate-400" />
        )}
      </button>
    </li>
  );
}

function summarise(ev: TrackingEvent): string {
  switch (ev.type) {
    case 'STATUS_CHANGE': {
      const p = ev.payload as StatusChangePayload;
      return `${p.from_status} → ${p.to_status}`;
    }
    case 'COMMENT': {
      const p = ev.payload as CommentPayload;
      return p.is_internal ? `(internal) ${p.snippet}` : p.snippet;
    }
    case 'ATTACHMENT': {
      const p = ev.payload as AttachmentPayload;
      return `${p.change === 'added' ? 'Added' : 'Deleted'} ${p.file_name} (${bytesPretty(p.size_bytes)})`;
    }
    case 'ASSIGNMENT_CHANGE': {
      const p = ev.payload as AssignmentChangePayload;
      return `${p.assigned_from ?? 'Unassigned'} → ${p.assigned_to ?? 'Unassigned'}`;
    }
    case 'ESCALATION': {
      const p = ev.payload as EscalationPayload;
      return p.reason ?? 'No reason recorded';
    }
    case 'CAUSAL_ANALYSIS_UPDATE':
    case 'CAP_UPDATE':
    case 'APPROVAL': {
      const p = ev.payload as StubPayload;
      return p.message;
    }
  }
}

// ── Detail modal — common fallback for events that show a popover ────

function EventDetailModal({
  event,
  onClose,
}: {
  event: TrackingEvent;
  onClose: () => void;
}) {
  const meta = TYPE_META[event.type];
  return (
    <div
      role="dialog"
      aria-label={`${meta.label} detail`}
      data-testid={`tracking-modal-${event.event_id}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-md bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-semibold">{meta.label}</h3>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X size={14} />
          </Button>
        </div>
        <ModalBody event={event} />
        <div className="mt-2 text-xs text-slate-500">
          Performed by <span className="font-medium">{event.actor}</span>{' '}
          at {fmtTs(event.ts)}
        </div>
        {event.href && event.type !== 'CAUSAL_ANALYSIS_UPDATE' && event.type !== 'CAP_UPDATE' && (
          <div className="mt-3">
            <Link
              to={event.href}
              onClick={onClose}
              className="text-xs text-blue-600 hover:underline"
            >
              Open in source view →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function ModalBody({ event }: { event: TrackingEvent }) {
  switch (event.type) {
    case 'STATUS_CHANGE': {
      const p = event.payload as StatusChangePayload;
      return (
        <p className="text-sm">
          Case moved from <Badge tone="neutral">{p.from_status}</Badge> to{' '}
          <Badge tone="success">{p.to_status}</Badge>.
        </p>
      );
    }
    case 'ESCALATION': {
      const p = event.payload as EscalationPayload;
      return (
        <p className="text-sm">
          <span className="font-semibold text-rose-700">Escalation reason:</span>{' '}
          {p.reason ?? <em className="text-slate-500">No reason recorded</em>}
        </p>
      );
    }
    case 'ASSIGNMENT_CHANGE': {
      const p = event.payload as AssignmentChangePayload;
      return (
        <div className="text-sm space-y-1">
          <p>
            <span className="text-slate-500">From:</span>{' '}
            <span className="font-medium">{p.assigned_from ?? '(unassigned)'}</span>
          </p>
          <p>
            <span className="text-slate-500">To:</span>{' '}
            <span className="font-medium">{p.assigned_to ?? '(unassigned)'}</span>
          </p>
        </div>
      );
    }
    case 'APPROVAL': {
      const p = event.payload as StubPayload;
      return (
        <p className="text-sm text-slate-600 italic">{p.message}</p>
      );
    }
    default:
      // STATUS_CHANGE / ATTACHMENT / COMMENT / CAS / CAP have their own click
      // paths and don't reach this modal — but render a generic body in case.
      return (
        <pre className="whitespace-pre-wrap text-xs text-slate-600">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      );
  }
}
