import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { useAuth } from '@/store/auth';
import { SetCategoryModal } from './SetCategoryModal';
import { CaseTrackingTimeline } from './CaseTrackingTimeline';
import { CaseActivityTimeline } from '@/components/cms/CaseActivityTimeline';
import {
  ArrowLeft,
  AlertTriangle,
  Clock,
  Send,
  ShieldAlert,
  UserPlus,
  X,
} from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { api } from '@/lib/api';
import {
  cmsApi,
  PRIORITY_TONE,
  STATUS_TONE,
  type CmsCaseState,
  type CmsResolutionCategory,
} from './api';

// "Activity" added 2026-05-18 — chronologically grouped feed with filter
// chips + expandable detail rows. Lives alongside "Timeline" (per-event
// card view); both read the same cmsApi.tracking() query via React Query
// dedup, so no extra network call.
const TABS = ['Overview', 'Investigation', 'Timeline', 'Activity', 'Related'] as const;
type Tab = (typeof TABS)[number];

export function CmsCaseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Tab + Investigation-row deep-link state.
  // ?tab=Investigation + ?note= / ?attachment= comes from the
  // CaseTrackingTimeline COMMENT/ATTACHMENT click handlers — auto-jump
  // to the Investigation tab and scroll-highlight the row.
  const tabParam = searchParams.get('tab') as Tab | null;
  const noteHighlight = searchParams.get('note');
  const attachmentHighlight = searchParams.get('attachment');
  const initialTab: Tab =
    tabParam && (TABS as readonly string[]).includes(tabParam)
      ? tabParam
      : noteHighlight || attachmentHighlight
        ? 'Investigation'
        : 'Overview';
  const [tab, setTab] = useState<Tab>(initialTab);

  // Live URL → tab sync: when the timeline navigates to
  // ?tab=Investigation&note=... while the user is already on the page,
  // honour the param without a remount.
  useEffect(() => {
    if (tabParam && (TABS as readonly string[]).includes(tabParam) && tabParam !== tab) {
      setTab(tabParam);
    } else if ((noteHighlight || attachmentHighlight) && tab !== 'Investigation') {
      setTab('Investigation');
    }
    // We intentionally don't depend on `tab` — that would force the tab
    // back whenever the user manually clicks a different tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam, noteHighlight, attachmentHighlight]);

  const [assigneeInput, setAssigneeInput] = useState('');
  const [assignReason, setAssignReason] = useState('');
  const [escalateReason, setEscalateReason] = useState('');
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState(false);
  const me = useAuth((s) => s.user);
  const canSetCategory =
    !!me && (me.roles.includes('admin') || me.roles.includes('supervisor'));

  const detailQ = useQuery({
    queryKey: ['cms-case', id],
    queryFn: () => cmsApi.detail(id),
    enabled: !!id,
  });
  const notesQ = useQuery({
    queryKey: ['cms-case-notes', id],
    queryFn: () => cmsApi.notes.list(id),
    enabled: !!id,
  });
  // Dispatches fired for this case. Reference convention is
  // `case:<id>[:lvl:N]` — the list endpoint accepts an exact reference
  // match, so this only finds the bare `case:<id>` entries. The
  // ":lvl:N" rows from escalations are still discoverable via the
  // full Dispatches log (linked via "View all" below).
  const dispatchesQ = useQuery({
    queryKey: ['cms-case-dispatches', id],
    queryFn: () =>
      api.notificationDispatchesList({
        reference: `case:${id}`,
        page_size: 50,
      }),
    enabled: !!id,
  });
  const attachmentsQ = useQuery({
    queryKey: ['cms-case-attachments', id],
    queryFn: () => cmsApi.attachments.list(id),
    enabled: !!id,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['cms-case', id] });
    void qc.invalidateQueries({ queryKey: ['cms-cases'] });
  };

  const transitionMut = useMutation({
    mutationFn: (target: CmsCaseState) => cmsApi.transition(id, target),
    onSuccess: invalidate,
  });
  const setCategoryMut = useMutation({
    mutationFn: ({ category, reason }: { category: string | null; reason: string | null }) =>
      cmsApi.setCategory(id, category, reason ?? undefined),
    onSuccess: () => {
      setEditingCategory(false);
      invalidate();
    },
  });
  const assignMut = useMutation({
    mutationFn: ({ assigned_to, reason }: { assigned_to: string; reason?: string }) =>
      cmsApi.assign(id, assigned_to, reason),
    onSuccess: () => {
      setAssigneeInput('');
      setAssignReason('');
      invalidate();
    },
  });
  const escalateMut = useMutation({
    mutationFn: (reason: string) => cmsApi.escalate(id, reason || undefined),
    onSuccess: () => {
      setEscalateReason('');
      invalidate();
    },
  });
  const closeMut = useMutation({
    mutationFn: ({ category, notes }: { category: CmsResolutionCategory; notes: string }) =>
      cmsApi.close(id, category, notes),
    onSuccess: () => {
      setShowCloseForm(false);
      invalidate();
    },
  });

  if (detailQ.isLoading) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  if (detailQ.isError || !detailQ.data) {
    return (
      <div className="p-6">
        <Link to="/cms/cases" className="text-sm text-blue-600">
          <ArrowLeft size={14} className="inline" /> Back to list
        </Link>
        <div className="mt-2 text-sm text-rose-700">Case not found.</div>
      </div>
    );
  }

  const c = detailQ.data;
  const sla = c.sla;
  const isLocked = c.is_locked;

  return (
    <div className="space-y-4 p-6">
      <Link to="/cms/cases" className="text-sm text-blue-600 hover:underline">
        <ArrowLeft size={14} className="inline" /> Back to list
      </Link>

      <PageHeader
        title={`${c.case_number} · ${c.title}${isLocked ? ' [LOCKED]' : ''}`}
        subtitle={`Created by ${c.created_by} · ${new Date(c.created_at).toLocaleString()}`}
        actions={
          <div className="flex gap-2">
            <Badge tone={STATUS_TONE[c.status] as never}>{c.status}</Badge>
            <Badge tone={PRIORITY_TONE[c.priority] as never}>{c.priority}</Badge>
            {sla.breached ? (
              <Badge tone={'danger' as never}>
                <AlertTriangle size={11} className="inline" /> SLA breached
              </Badge>
            ) : sla.warning ? (
              <Badge tone={'warning' as never}>
                <Clock size={11} className="inline" /> SLA warn ({sla.progress_pct}%)
              </Badge>
            ) : (
              <Badge tone={'success' as never}>SLA {sla.progress_pct}%</Badge>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Tabs */}
        <div>
          <div className="mb-3 flex gap-1 border-b border-slate-200">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-sm ${
                  tab === t
                    ? 'border-b-2 border-blue-500 font-semibold'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'Overview' ? (
            <Panel title="Overview">
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <Field label="Description">{c.description || '—'}</Field>
                <Field label="Alert ID">{c.alert_id ?? '—'}</Field>
                <Field label="Assigned to">{c.assigned_to ?? '—'}</Field>
                <Field label="Priority">{c.priority}</Field>
                <Field label="SLA due">{new Date(c.sla_due_at).toLocaleString()}</Field>
                <Field label="Category">
                  <span className="font-mono text-xs">
                    {c.case_category ?? <em className="text-muted">none (default_fallback)</em>}
                  </span>
                  {canSetCategory && !isLocked && (
                    <button
                      type="button"
                      onClick={() => setEditingCategory(true)}
                      className="ml-2 text-2xs text-blue-600 hover:underline inline-flex items-center gap-1"
                      data-testid="cms-set-category-btn"
                    >
                      <Pencil className="w-3 h-3" />
                      Edit
                    </button>
                  )}
                </Field>
                <Field label="Tags">
                  {c.tags.length === 0 ? '—' : c.tags.join(', ')}
                </Field>
                {c.resolution_category ? (
                  <Field label="Resolution">
                    {c.resolution_category} — {c.resolution_notes}
                  </Field>
                ) : null}
              </dl>
            </Panel>
          ) : null}

          {tab === 'Investigation' ? (
            <InvestigationTab
              caseId={id}
              isLocked={isLocked}
              notes={notesQ.data?.items ?? []}
              attachments={attachmentsQ.data?.items ?? []}
              highlightNoteId={noteHighlight}
              highlightAttachmentId={attachmentHighlight}
              onHighlightConsumed={() => {
                // Strip the deep-link params after we've scrolled +
                // flashed, so a manual reload doesn't re-trigger the
                // animation and the URL stays clean for sharing.
                const next = new URLSearchParams(searchParams);
                let dirty = false;
                if (next.has('note')) { next.delete('note'); dirty = true; }
                if (next.has('attachment')) { next.delete('attachment'); dirty = true; }
                if (dirty) setSearchParams(next, { replace: true });
              }}
              onNoteAdd={() => {
                void qc.invalidateQueries({ queryKey: ['cms-case-notes', id] });
              }}
              onAttachmentAdd={() => {
                void qc.invalidateQueries({ queryKey: ['cms-case-attachments', id] });
              }}
            />
          ) : null}

          {tab === 'Timeline' ? (
            <CaseTrackingTimeline
              caseId={id}
              onJumpToComment={() => {
                // Switch to Investigation tab so the note panel is
                // visible. The note_id stays on the URL (?note=...) so
                // InvestigationTab's scroll-and-flash effect catches it.
                setTab('Investigation');
              }}
            />
          ) : null}

          {tab === 'Activity' ? (
            <CaseActivityTimeline
              caseId={id}
              creationSeed={{
                case_id: c.case_id,
                created_by: c.created_by,
                created_at: c.created_at,
              }}
            />
          ) : null}

          {tab === 'Related' ? (
            <Panel title={`Notifications fired for ${id}`}>
              {dispatchesQ.isLoading ? (
                <p className="py-4 text-center text-sm text-slate-500">
                  Loading dispatches…
                </p>
              ) : dispatchesQ.isError ? (
                <p
                  className="py-4 text-center text-sm text-rose-700"
                  role="alert"
                  data-testid="related-dispatches-error"
                >
                  Failed to load dispatches.
                </p>
              ) : (dispatchesQ.data?.items ?? []).length === 0 ? (
                <p
                  className="py-4 text-center text-sm text-slate-500"
                  data-testid="related-dispatches-empty"
                >
                  No notifications have been fired for this case yet. The
                  case_create pipeline + escalation worker write here as
                  they fan out.
                </p>
              ) : (
                <>
                  <ul
                    className="divide-y divide-slate-100"
                    data-testid="related-dispatches-list"
                  >
                    {(dispatchesQ.data?.items ?? []).slice(0, 20).map((d) => (
                      <li
                        key={d.dispatch_id}
                        className="flex flex-wrap items-center gap-3 py-2 text-2xs"
                      >
                        <span className="w-32 shrink-0 font-mono text-slate-500">
                          {new Date(d.performed_at).toLocaleString()}
                        </span>
                        <Link
                          to={`/admin/notification-templates?focus=${encodeURIComponent(d.template_id)}`}
                          className="w-56 shrink-0 truncate font-medium text-blue-700 hover:underline"
                          title={d.template_name}
                        >
                          {d.template_name}
                        </Link>
                        <span className="w-20 shrink-0 font-mono text-slate-500">
                          {d.channel}
                        </span>
                        <span className="flex-1 truncate text-slate-600" title={d.recipient}>
                          {d.recipient}
                        </span>
                        <Badge
                          tone={
                            d.status === 'sent'
                              ? 'success'
                              : d.status === 'failed'
                                ? 'danger'
                                : 'neutral'
                          }
                          className="text-2xs uppercase"
                        >
                          {d.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={`/admin/notification-dispatches?reference=${encodeURIComponent(`case:${id}`)}`}
                    className="mt-3 inline-block text-2xs text-blue-700 hover:underline"
                    data-testid="related-dispatches-viewall"
                  >
                    View full log (including escalation levels) →
                  </Link>
                </>
              )}
            </Panel>
          ) : null}
        </div>

        {/* Quick Actions sidebar */}
        <Panel title="Quick actions">
          {isLocked ? (
            <div className="space-y-2">
              <div className="text-xs text-slate-500">
                Closed cases are locked. Reopen to make changes.
              </div>
              <Button onClick={() => transitionMut.mutate('OPEN')}>Reopen case</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div data-testid="cms-assign-section">
                <div className="mb-1 text-xs font-semibold uppercase text-slate-500">
                  {c.assigned_to ? 'Reassign' : 'Assign'}
                </div>
                {c.assigned_to && (
                  <p className="mb-1 text-2xs text-slate-500">
                    Currently: <span className="font-medium text-slate-700">{c.assigned_to}</span>
                  </p>
                )}
                <div className="flex gap-1">
                  <input
                    value={assigneeInput}
                    onChange={(e) => setAssigneeInput(e.target.value)}
                    placeholder={c.assigned_to ? 'new assignee username' : 'username'}
                    className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                    data-testid="cms-assign-username"
                  />
                  <Button
                    onClick={() =>
                      assignMut.mutate({
                        assigned_to: assigneeInput.trim(),
                        reason: assignReason.trim() || undefined,
                      })
                    }
                    disabled={!assigneeInput.trim() || assignMut.isPending}
                    data-testid="cms-assign-submit"
                  >
                    <UserPlus size={12} />
                  </Button>
                </div>
                <input
                  value={assignReason}
                  onChange={(e) => setAssignReason(e.target.value)}
                  placeholder="reason (optional)"
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-xs"
                  data-testid="cms-assign-reason"
                />
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Transition</div>
                <div className="flex flex-wrap gap-1">
                  {(['ASSIGNED', 'INVESTIGATING', 'PENDING_APPROVAL'] as const).map((s) => (
                    <Button
                      key={s}
                      variant="ghost"
                      onClick={() => transitionMut.mutate(s)}
                    >
                      → {s}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Escalate</div>
                <div className="flex gap-1">
                  <input
                    value={escalateReason}
                    onChange={(e) => setEscalateReason(e.target.value)}
                    placeholder="reason (optional)"
                    className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                  <Button
                    onClick={() => escalateMut.mutate(escalateReason)}
                    disabled={escalateMut.isPending}
                  >
                    <ShieldAlert size={12} />
                  </Button>
                </div>
              </div>
              <div className="border-t border-slate-200 pt-2">
                {showCloseForm ? (
                  <CloseForm
                    onCancel={() => setShowCloseForm(false)}
                    onSubmit={(category, notes) =>
                      closeMut.mutate({ category, notes })
                    }
                    submitting={closeMut.isPending}
                  />
                ) : (
                  <Button onClick={() => setShowCloseForm(true)}>
                    Close case
                  </Button>
                )}
              </div>
            </div>
          )}
        </Panel>
      </div>

      {editingCategory && (
        <SetCategoryModal
          caseId={id}
          caseNumber={c.case_number}
          currentCategory={c.case_category ?? null}
          onClose={() => setEditingCategory(false)}
          onSubmit={(category, reason) =>
            setCategoryMut.mutate({ category, reason })
          }
          isPending={setCategoryMut.isPending}
          error={setCategoryMut.error}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase text-slate-500">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CloseForm({
  onCancel,
  onSubmit,
  submitting,
}: {
  onCancel: () => void;
  onSubmit: (cat: CmsResolutionCategory, notes: string) => void;
  submitting: boolean;
}) {
  const [category, setCategory] = useState<CmsResolutionCategory>('mitigated');
  const [notes, setNotes] = useState('');
  return (
    <div className="space-y-2">
      <label className="block text-xs">
        <span className="font-semibold uppercase text-slate-500">Resolution</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as CmsResolutionCategory)}
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
        >
          <option value="mitigated">Mitigated</option>
          <option value="false_positive">False positive</option>
          <option value="confirmed_risk">Confirmed risk</option>
        </select>
      </label>
      <label className="block text-xs">
        <span className="font-semibold uppercase text-slate-500">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <div className="flex gap-1">
        <Button
          onClick={() => onSubmit(category, notes.trim())}
          disabled={!notes.trim() || submitting}
        >
          Confirm close
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <X size={12} /> Cancel
        </Button>
      </div>
    </div>
  );
}

function InvestigationTab({
  caseId,
  isLocked,
  notes,
  attachments,
  highlightNoteId,
  highlightAttachmentId,
  onHighlightConsumed,
  onNoteAdd,
  onAttachmentAdd,
}: {
  caseId: string;
  isLocked: boolean;
  notes: ReturnType<typeof cmsApi.notes.list> extends Promise<infer R>
    ? R extends { items: infer X } ? X : never : never;
  attachments: ReturnType<typeof cmsApi.attachments.list> extends Promise<infer R>
    ? R extends { items: infer X } ? X : never : never;
  highlightNoteId: string | null;
  highlightAttachmentId: string | null;
  onHighlightConsumed: () => void;
  onNoteAdd: () => void;
  onAttachmentAdd: () => void;
}) {
  const [noteText, setNoteText] = useState('');
  const [noteInternal, setNoteInternal] = useState(false);
  const [noteVisibility, setNoteVisibility] = useState<'all' | 'public' | 'internal'>('all');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(1024);
  const [mimeType, setMimeType] = useState('application/pdf');

  // Track which row key is currently flashing — drives the highlight
  // ring class. Cleared after the animation window so the row settles
  // back to its normal style.
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Scroll-to-and-flash for ?note=<id> / ?attachment=<id> deep links.
  // Runs once per (highlight, list-loaded) pair: we wait for the row
  // to be in the DOM, then scroll + apply the flash class for ~1.8s,
  // then ask the parent to drop the URL param.
  const noteCount = (notes as { length: number }).length;
  const attCount = (attachments as { length: number }).length;
  useEffect(() => {
    const target = highlightNoteId
      ? `note:${highlightNoteId}`
      : highlightAttachmentId
        ? `att:${highlightAttachmentId}`
        : null;
    if (!target) return;
    const container = containerRef.current;
    if (!container) return;
    const node = container.querySelector<HTMLElement>(`[data-row-key="${target}"]`);
    if (!node) return; // list not loaded yet — effect re-runs when counts change
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashKey(target);
    const t = window.setTimeout(() => {
      setFlashKey(null);
      onHighlightConsumed();
    }, 1800);
    return () => window.clearTimeout(t);
  }, [highlightNoteId, highlightAttachmentId, noteCount, attCount, onHighlightConsumed]);

  const flashClass = (key: string) =>
    flashKey === key
      ? ' ring-2 ring-blue-400 ring-offset-1 bg-blue-50 transition-shadow duration-500'
      : '';

  const noteAddMut = useMutation({
    mutationFn: () => cmsApi.notes.add(caseId, noteText.trim(), noteInternal),
    onSuccess: () => {
      setNoteText('');
      setNoteInternal(false);
      onNoteAdd();
    },
  });

  const attachmentAddMut = useMutation({
    mutationFn: () =>
      cmsApi.attachments.add(caseId, {
        file_name: fileName.trim(),
        file_size: fileSize,
        mime_type: mimeType,
      }),
    onSuccess: () => {
      setFileName('');
      onAttachmentAdd();
    },
  });

  return (
    <div className="space-y-4" ref={containerRef}>
      <Panel title={`Notes (${(notes as { length: number }).length})`}>
        {!isLocked ? (
          <div className="mb-3 space-y-1">
            <div className="flex gap-1">
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={2}
                placeholder="Add a note…"
                className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
              />
              <Button
                onClick={() => noteAddMut.mutate()}
                disabled={!noteText.trim() || noteAddMut.isPending}
                data-testid="cms-note-add"
              >
                <Send size={12} />
              </Button>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={noteInternal}
                onChange={(e) => setNoteInternal(e.target.checked)}
                data-testid="cms-note-internal-toggle"
              />
              Internal note (hidden from external view)
            </label>
          </div>
        ) : null}
        {/* Visibility filter — show all / public-only / internal-only. */}
        <div className="mb-2 flex items-center gap-1" data-testid="cms-note-visibility">
          {(['all', 'public', 'internal'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setNoteVisibility(v)}
              aria-pressed={noteVisibility === v}
              data-testid={`cms-note-visibility-${v}`}
              className={
                noteVisibility === v
                  ? 'rounded border border-blue-500 bg-blue-50 px-2 py-0.5 text-xs font-medium capitalize text-blue-700'
                  : 'rounded border border-slate-300 px-2 py-0.5 text-xs capitalize text-slate-600 hover:border-blue-300'
              }
            >
              {v}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          {(notes as Array<{ note_id: string; user_id: string; note_text: string; created_at: string; is_internal: boolean }>)
            .filter((n) =>
              noteVisibility === 'all'
                ? true
                : noteVisibility === 'internal'
                  ? n.is_internal
                  : !n.is_internal,
            )
            .map((n) => (
              <div
                key={n.note_id}
                data-row-key={`note:${n.note_id}`}
                data-testid={`investigation-note-${n.note_id}`}
                className={`rounded border border-slate-200 p-2 text-sm${flashClass(`note:${n.note_id}`)}`}
              >
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span>{n.user_id}</span>
                  <span>{new Date(n.created_at).toLocaleString()}</span>
                  {n.is_internal ? (
                    <span className="rounded bg-slate-200 px-1 text-[10px]">INTERNAL</span>
                  ) : null}
                </div>
                <div className="mt-1 whitespace-pre-wrap">{n.note_text}</div>
              </div>
            ))}
        </div>
      </Panel>

      <Panel title={`Attachments (${(attachments as { length: number }).length})`}>
        {!isLocked ? (
          <div className="mb-3 grid grid-cols-[1fr_120px_180px_auto] gap-1 text-sm">
            <input
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="file_name.pdf"
              className="rounded border border-slate-300 px-2 py-1"
            />
            <input
              type="number"
              value={fileSize}
              onChange={(e) => setFileSize(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1"
            />
            <select
              value={mimeType}
              onChange={(e) => setMimeType(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1"
            >
              <option value="application/pdf">PDF</option>
              <option value="image/png">PNG</option>
              <option value="image/jpeg">JPEG</option>
              <option value="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">XLSX</option>
              <option value="text/csv">CSV</option>
              <option value="text/plain">TXT</option>
            </select>
            <Button
              onClick={() => attachmentAddMut.mutate()}
              disabled={!fileName.trim() || attachmentAddMut.isPending}
            >
              Upload
            </Button>
          </div>
        ) : null}
        <div className="space-y-1">
          {(attachments as Array<{ attachment_id: string; file_name: string; file_size: number; mime_type: string; virus_scan_status: string; uploaded_by: string }>)
            .map((a) => (
              <div
                key={a.attachment_id}
                data-row-key={`att:${a.attachment_id}`}
                data-testid={`investigation-attachment-${a.attachment_id}`}
                className={`flex items-center justify-between rounded border border-slate-200 p-2 text-sm${flashClass(`att:${a.attachment_id}`)}`}
              >
                <div>
                  <span className="font-mono text-xs">{a.file_name}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {Math.round(a.file_size / 1024)} KB · {a.mime_type}
                  </span>
                </div>
                <Badge
                  tone={
                    (a.virus_scan_status === 'clean'
                      ? 'success'
                      : a.virus_scan_status === 'infected'
                        ? 'danger'
                        : 'neutral') as never
                  }
                >
                  {a.virus_scan_status}
                </Badge>
              </div>
            ))}
        </div>
      </Panel>
    </div>
  );
}
