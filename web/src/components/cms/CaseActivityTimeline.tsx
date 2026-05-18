// web/src/components/cms/CaseActivityTimeline.tsx
//
// Activity feed for a single CMS case. Companion to <CaseTrackingTimeline>
// (which is the per-event "card + modal" investigation view) — this one
// is a chronologically grouped scrollable feed designed for "scan
// everything that happened" rather than "drill into one event".
//
// Reuses cmsApi.tracking() via the EXACT same queryKey as
// CaseTrackingTimeline so React Query dedups the underlying network
// request — both tabs share a single fetch.
//
// Adds (vs the existing Timeline tab):
//   - Chronological grouping (Today / Yesterday / This week / Older)
//   - Filter chips by event type (multi-select)
//   - Expandable detail per row showing raw payload
//   - Synthesised "Case created" event at the very top (from case.created_at)
//   - Client-side "Load more" pagination (50 at a time) so very long
//     histories stay snappy. The underlying endpoint returns everything
//     in one go today; switching to server-side pagination is a one-line
//     swap in cmsApi.tracking when the BFF grows ?limit=&offset=.
//
// Audit-log cross-reference (BFF would need to expose
// `/v1/audit/events?resource_type=case&resource_id=<case_id>` for this
// case-id) is intentionally deferred — see the "Deferred" note in the
// activity-feed write-up.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Filter,
  MessageSquare,
  Paperclip,
  PlusCircle,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { Button, Panel } from '@/components/ui';
import {
  cmsApi,
  type AttachmentPayload,
  type AssignmentChangePayload,
  type CommentPayload,
  type EscalationPayload,
  type StatusChangePayload,
  type StubPayload,
  type TrackingEvent,
  type TrackingEventType,
} from '@/modules/cms/api';

// ─── Visual mapping (mirrors CaseTrackingTimeline's TYPE_META) ───────

interface TypeMeta {
  label: string;
  icon: typeof FileText;
  tint: string;
  dot: string;
}

const TYPE_META: Record<TrackingEventType, TypeMeta> = {
  STATUS_CHANGE:          { label: 'Status change',   icon: ArrowRight,    tint: 'text-blue-700 bg-blue-50',     dot: 'bg-blue-500' },
  COMMENT:                { label: 'Note added',      icon: MessageSquare, tint: 'text-slate-700 bg-slate-100',  dot: 'bg-slate-400' },
  ATTACHMENT:             { label: 'Attachment',      icon: Paperclip,     tint: 'text-amber-700 bg-amber-50',   dot: 'bg-amber-500' },
  ASSIGNMENT_CHANGE:      { label: 'Assignment',      icon: UserPlus,      tint: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500' },
  ESCALATION:             { label: 'Escalation',      icon: AlertTriangle, tint: 'text-rose-700 bg-rose-50',     dot: 'bg-rose-500' },
  CAUSAL_ANALYSIS_UPDATE: { label: 'Causal analysis', icon: Sparkles,      tint: 'text-violet-700 bg-violet-50', dot: 'bg-violet-500' },
  CAP_UPDATE:             { label: 'CAP update',      icon: FileText,      tint: 'text-violet-700 bg-violet-50', dot: 'bg-violet-500' },
  APPROVAL:               { label: 'Approval',        icon: ShieldCheck,   tint: 'text-emerald-700 bg-emerald-50', dot: 'bg-emerald-500' },
};

const CREATION_META: TypeMeta = {
  label: 'Case created',
  icon: PlusCircle,
  tint: 'text-indigo-700 bg-indigo-50',
  dot: 'bg-indigo-500',
};

// ─── Synthesised "Case created" event ────────────────────────────────

const CREATION_EVENT_TYPE = 'CASE_CREATED' as const;
type ExtendedEventType = TrackingEventType | typeof CREATION_EVENT_TYPE;

interface CaseCreatedSynthEvent {
  event_id: string;
  case_id: string;
  type: typeof CREATION_EVENT_TYPE;
  ts: string;
  actor: string;
  /** Display-only label; CASE_CREATED has no payload. */
  payload: null;
}

type ActivityEvent = TrackingEvent | CaseCreatedSynthEvent;

interface CaseCreationSeed {
  case_id: string;
  created_by: string;
  created_at: string;
}

// ─── Time bucketing ──────────────────────────────────────────────────

type BucketKey = 'today' | 'yesterday' | 'this_week' | 'older';

const BUCKET_LABEL: Record<BucketKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'Earlier this week',
  older: 'Older',
};

function bucketFor(ts: string, now: Date): BucketKey {
  const d = new Date(ts);
  if (!isFinite(d.getTime())) return 'older';
  const dDay = startOfDay(d);
  const nowDay = startOfDay(now);
  const diffDays = Math.floor((nowDay.getTime() - dDay.getTime()) / 86_400_000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 7) return 'this_week';
  return 'older';
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtFullTs(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return iso;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

// ─── Payload renderer (the expandable detail panel) ──────────────────

function renderHeadline(ev: ActivityEvent): string {
  if (ev.type === CREATION_EVENT_TYPE) return 'Case created';
  switch (ev.type) {
    case 'STATUS_CHANGE': {
      const p = ev.payload as StatusChangePayload;
      return `${p.from_status} → ${p.to_status}`;
    }
    case 'COMMENT': {
      const p = ev.payload as CommentPayload;
      return p.snippet || 'Note added';
    }
    case 'ATTACHMENT': {
      const p = ev.payload as AttachmentPayload;
      return `${p.change === 'deleted' ? 'Removed' : 'Uploaded'} ${p.file_name}`;
    }
    case 'ASSIGNMENT_CHANGE': {
      const p = ev.payload as AssignmentChangePayload;
      const target = p.assigned_to ?? 'unassigned';
      return p.assigned_from ? `Reassigned from ${p.assigned_from} to ${target}` : `Assigned to ${target}`;
    }
    case 'ESCALATION': {
      const p = ev.payload as EscalationPayload;
      return p.reason ? `Escalated: ${p.reason}` : 'Escalated';
    }
    case 'CAUSAL_ANALYSIS_UPDATE':
    case 'CAP_UPDATE':
    case 'APPROVAL': {
      const p = ev.payload as StubPayload;
      return p.message || TYPE_META[ev.type].label;
    }
  }
}

function renderDetail(ev: ActivityEvent): React.ReactNode {
  if (ev.type === CREATION_EVENT_TYPE) {
    return (
      <div className="text-[12px] text-slate-700">
        Case opened by <span className="font-medium">{ev.actor}</span> at{' '}
        <span className="tabular">{fmtFullTs(ev.ts)}</span>.
      </div>
    );
  }
  return (
    <pre
      className="overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700"
      data-testid={`activity-detail-${ev.event_id}`}
    >
      {JSON.stringify(ev.payload, null, 2)}
    </pre>
  );
}

// ─── Component ───────────────────────────────────────────────────────

export interface CaseActivityTimelineProps {
  caseId: string;
  /** Synthesises a CASE_CREATED event at the top of the feed when set. */
  creationSeed?: CaseCreationSeed | null;
  /** Number of events to reveal per "Load more" click. Default 50. */
  pageSize?: number;
  /** Test id appended to the root container. */
  testId?: string;
}

export function CaseActivityTimeline({
  caseId,
  creationSeed = null,
  pageSize = 50,
  testId = 'case-activity-timeline',
}: CaseActivityTimelineProps) {
  // Same queryKey as CaseTrackingTimeline → React Query dedup.
  // We pass include_stubs=false by default (matches Timeline's default
  // initial render) so both tabs hit the cache without contention.
  const q = useQuery({
    queryKey: ['cms-case-tracking', caseId, false],
    queryFn: () => cmsApi.tracking(caseId, false),
  });

  const [filter, setFilter] = useState<Set<ExtendedEventType>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(pageSize);

  // Build the merged events array: synthesised creation + real events.
  // Sorted newest-first to match the user's mental model ("most recent
  // first") which matches every other audit/activity feed in the app.
  const allEvents = useMemo<ActivityEvent[]>(() => {
    const real = q.data?.items ?? [];
    const synth: ActivityEvent[] = creationSeed
      ? [
          {
            event_id: `synth-created-${creationSeed.case_id}`,
            case_id: creationSeed.case_id,
            type: CREATION_EVENT_TYPE,
            ts: creationSeed.created_at,
            actor: creationSeed.created_by,
            payload: null,
          },
        ]
      : [];
    return [...synth, ...real].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }, [q.data, creationSeed]);

  // Filter narrowing
  const filtered = useMemo<ActivityEvent[]>(() => {
    if (filter.size === 0) return allEvents;
    return allEvents.filter((e) => filter.has(e.type));
  }, [allEvents, filter]);

  // Paginate (client-side)
  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = filtered.length > visibleCount;

  // Bucket the visible slice
  const buckets = useMemo(() => bucketGroups(visible), [visible]);

  // ── States ────────────────────────────────────────────────────────

  if (q.isLoading) {
    return (
      <Panel title="Activity" data-testid={testId}>
        <div className="py-12 text-center text-[12px] text-muted">Loading activity…</div>
      </Panel>
    );
  }

  if (q.isError) {
    return (
      <Panel title="Activity" data-testid={testId}>
        <div
          className="py-12 text-center text-[12px] text-rose-600"
          data-testid={`${testId}-error`}
        >
          Couldn't load activity. Retry the page.
        </div>
      </Panel>
    );
  }

  if (allEvents.length === 0) {
    return (
      <Panel title="Activity" data-testid={testId}>
        <div
          className="py-12 text-center text-[12px] text-muted"
          data-testid={`${testId}-empty`}
        >
          No activity recorded for this case yet.
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-slate-500" aria-hidden />
          Activity
          <span className="text-muted text-[11px] font-normal">
            · {allEvents.length} event{allEvents.length === 1 ? '' : 's'}
            {filter.size > 0 && filtered.length !== allEvents.length
              ? ` (showing ${filtered.length} after filter)`
              : ''}
          </span>
        </span>
      }
      data-testid={testId}
    >
      <FilterChips
        events={allEvents}
        filter={filter}
        onChange={(next) => {
          setFilter(next);
          setVisibleCount(pageSize); // reset paging when filter changes
        }}
        testId={`${testId}-filters`}
      />

      <div className="mt-4 space-y-6" data-testid={`${testId}-feed`}>
        {(['today', 'yesterday', 'this_week', 'older'] as BucketKey[]).map((bucket) =>
          buckets.get(bucket)?.length ? (
            <BucketSection
              key={bucket}
              title={BUCKET_LABEL[bucket]}
              events={buckets.get(bucket)!}
              expanded={expanded}
              onToggle={(id) => {
                const next = new Set(expanded);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                setExpanded(next);
              }}
              testId={`${testId}-bucket-${bucket}`}
            />
          ) : null,
        )}
      </div>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="ghost"
            onClick={() => setVisibleCount((c) => c + pageSize)}
            data-testid={`${testId}-load-more`}
          >
            Load {Math.min(pageSize, filtered.length - visibleCount)} more
          </Button>
        </div>
      )}
    </Panel>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

interface FilterChipsProps {
  events: readonly ActivityEvent[];
  filter: Set<ExtendedEventType>;
  onChange: (next: Set<ExtendedEventType>) => void;
  testId: string;
}

function FilterChips({ events, filter, onChange, testId }: FilterChipsProps) {
  // Count per type so chips show their badge count; only render chips
  // for types that actually appear in this case's history.
  const counts = useMemo(() => {
    const m = new Map<ExtendedEventType, number>();
    for (const e of events) m.set(e.type, (m.get(e.type) ?? 0) + 1);
    return m;
  }, [events]);

  const ordered: ExtendedEventType[] = [
    CREATION_EVENT_TYPE,
    'STATUS_CHANGE',
    'ASSIGNMENT_CHANGE',
    'COMMENT',
    'ATTACHMENT',
    'ESCALATION',
    'APPROVAL',
    'CAUSAL_ANALYSIS_UPDATE',
    'CAP_UPDATE',
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid={testId}>
      <Filter className="h-3.5 w-3.5 text-slate-400" aria-hidden />
      <span className="text-muted mr-1">Filter:</span>
      {ordered
        .filter((t) => (counts.get(t) ?? 0) > 0)
        .map((t) => {
          const meta = t === CREATION_EVENT_TYPE ? CREATION_META : TYPE_META[t];
          const active = filter.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => {
                const next = new Set(filter);
                if (next.has(t)) next.delete(t);
                else next.add(t);
                onChange(next);
              }}
              data-testid={`${testId}-chip-${t}`}
              aria-pressed={active}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${
                active
                  ? 'border-action bg-action/10 text-action'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {meta.label}
              <span
                className={`tabular ${active ? 'text-action' : 'text-slate-400'}`}
                aria-hidden
              >
                {counts.get(t)}
              </span>
            </button>
          );
        })}
      {filter.size > 0 && (
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="text-muted hover:text-ink ml-1"
          data-testid={`${testId}-clear`}
        >
          Clear
        </button>
      )}
    </div>
  );
}

interface BucketSectionProps {
  title: string;
  events: ActivityEvent[];
  expanded: Set<string>;
  onToggle: (event_id: string) => void;
  testId: string;
}

function BucketSection({ title, events, expanded, onToggle, testId }: BucketSectionProps) {
  return (
    <section data-testid={testId}>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title} <span className="ml-1 text-slate-400">· {events.length}</span>
      </h4>
      <ol className="relative ml-2 border-l border-slate-200">
        {events.map((ev) => {
          const meta = ev.type === CREATION_EVENT_TYPE ? CREATION_META : TYPE_META[ev.type];
          const Icon = meta.icon;
          const isExpanded = expanded.has(ev.event_id);
          return (
            <li
              key={ev.event_id}
              className="relative pl-6 pb-3 last:pb-0"
              data-testid={`${testId}-row-${ev.event_id}`}
            >
              {/* Dot on the rail */}
              <span
                className={`absolute -left-[5px] top-2 h-2.5 w-2.5 rounded-full ring-2 ring-white ${meta.dot}`}
                aria-hidden
              />
              <button
                type="button"
                onClick={() => onToggle(ev.event_id)}
                aria-expanded={isExpanded}
                data-testid={`${testId}-toggle-${ev.event_id}`}
                className="group flex w-full items-start gap-2 rounded text-left hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-action/30"
              >
                <span
                  className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded ${meta.tint}`}
                  aria-hidden
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-[12px] font-semibold text-ink">{meta.label}</span>
                    <span className="text-[11px] text-muted tabular">{fmtTime(ev.ts)}</span>
                    <span className="text-[11px] text-muted">· {ev.actor}</span>
                  </span>
                  <span className="block text-[12px] text-slate-700 truncate">
                    {renderHeadline(ev)}
                  </span>
                </span>
                <span className="text-slate-400 group-hover:text-slate-600" aria-hidden>
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </span>
              </button>
              {isExpanded && (
                <div
                  className="mt-1.5 ml-8 rounded border border-slate-200 bg-white p-2"
                  data-testid={`${testId}-expanded-${ev.event_id}`}
                >
                  {renderDetail(ev)}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ─── Pure helper ─────────────────────────────────────────────────────

/**
 * Group events into time buckets. Pure (uses real Date.now via the
 * caller's `now` if injected, else the actual current time — keeps
 * tests deterministic when needed).
 */
export function bucketGroups(
  events: readonly ActivityEvent[],
  now: Date = new Date(),
): Map<BucketKey, ActivityEvent[]> {
  const out = new Map<BucketKey, ActivityEvent[]>([
    ['today', []],
    ['yesterday', []],
    ['this_week', []],
    ['older', []],
  ]);
  for (const e of events) {
    out.get(bucketFor(e.ts, now))!.push(e);
  }
  return out;
}
