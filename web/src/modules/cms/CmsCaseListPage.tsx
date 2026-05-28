import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { SLA_BUCKET_LABEL, type SlaBucketSlug } from '@/lib/api';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  UserPlus,
  Zap,
  X,
} from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  cmsApi,
  PRIORITY_TONE,
  STATUS_TONE,
  type CmsAutoEscalateResult,
  type CmsCase,
  type CmsCaseState,
  type CmsListFilters,
  type CmsPriority,
} from './api';
import { resolveCaseQueues, caseMatchesQueue, type CaseQueueDef } from './caseQueues';
import { CaseStatusBadge, CasePriorityBadge } from '@/components/cms/CaseBadges';

const STATES: CmsCaseState[] = [
  'OPEN',
  'ASSIGNED',
  'INVESTIGATING',
  'PENDING_APPROVAL',
  'ESCALATED',
  'CLOSED',
];

const PRIORITIES: CmsPriority[] = ['P1', 'P2', 'P3', 'P4'];

export function CmsCaseListPage() {
  const qc = useQueryClient();

  const [filters, setFilters] = useState<CmsListFilters>({});
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAssignee, setBulkAssignee] = useState('');
  const [showAutoEscalate, setShowAutoEscalate] = useState(false);

  // M3.1 — auto-escalate is admin / supervisor only (matches the
  // RBAC posture on M13.1 cases.auto_escalate_at_pct config + the
  // sensitivity of bulk state transitions).
  const user = useAuth((s) => s.user);
  const canAutoEscalate =
    user?.roles.some((r) => ['admin', 'supervisor'].includes(r)) ?? false;

  // Read deep-link filters now so the server-side `breached` flag flows
  // into the query before client-side narrowing happens.
  const [searchParams, setSearchParams] = useSearchParams();
  const ageBucket = (searchParams.get('ageBucket') as SlaBucketSlug | null) ?? null;
  const breachedOnly = searchParams.get('breached') === 'true';
  const ageBucketLabel = ageBucket ? SLA_BUCKET_LABEL[ageBucket] : null;

  // Phase 4 — role-based case queues (additive lens). Resolve the queues
  // this viewer may see (default-first); the active queue comes from
  // ?queue= when it names a queue the user can actually see (guards
  // against URL tampering), else the default (first) queue. `user` is a
  // stable zustand reference so this memo only recomputes on login/out.
  const queues = useMemo(() => resolveCaseQueues(user?.roles ?? []), [user]);
  const queueParam = searchParams.get('queue');
  const activeQueue: CaseQueueDef | null =
    queues.find((q) => q.id === queueParam) ?? queues[0] ?? null;
  const readOnlyQueue = activeQueue?.readOnly ?? false;
  const myUsername = user?.username ?? null;
  const mineOnly = !!myUsername && filters.assigned_to === myUsername;

  const selectQueue = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('queue', id);
    setSearchParams(sp, { replace: true });
    setSelected(new Set());
  };

  const listQ = useQuery({
    queryKey: ['cms-cases', filters, q, breachedOnly],
    queryFn: () =>
      cmsApi.list({
        ...filters,
        q: q || undefined,
        // Server uses sla_config so the count agrees with the dashboard
        // SLA Breach Matrix tile that linked here.
        breached: breachedOnly || undefined,
      }),
  });
  const statsQ = useQuery({ queryKey: ['cms-stats'], queryFn: () => cmsApi.stats() });
  const slaQ = useQuery({ queryKey: ['cms-sla'], queryFn: () => cmsApi.slaBreaches() });

  const bulkAssignMut = useMutation({
    mutationFn: ({ case_ids, assigned_to }: { case_ids: string[]; assigned_to: string }) =>
      cmsApi.bulkAssign(case_ids, assigned_to),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['cms-cases'] });
      void qc.invalidateQueries({ queryKey: ['cms-stats'] });
    },
  });

  // Deep-link from the dashboard SLA Breach Matrix tile
  // (BAC §3.1.9.1.4): /cms/cases?ageBucket=8-30d&breached=true.
  //
  // - `breached` is server-side now (sent into cmsApi.list above) so the
  //   list count agrees with the dashboard tile, even when admins edit
  //   sla_config away from the priority defaults.
  // - `ageBucket` stays client-side because it's pure date math against
  //   created_at — no need for a server round-trip just to slice.

  const ageBucketRange = useMemo<{ min: number; max: number | null } | null>(() => {
    if (!ageBucket) return null;
    if (ageBucket === '0-7d')   return { min: 0,  max: 7   };
    if (ageBucket === '8-30d')  return { min: 8,  max: 30  };
    if (ageBucket === '31-90d') return { min: 31, max: 90  };
    return                            { min: 91, max: null };
  }, [ageBucket]);

  // Reset selection when the deep-link filter changes (the visible
  // rows are different, so a stale Set is misleading).
  useEffect(() => { setSelected(new Set()); }, [ageBucket, breachedOnly, queueParam]);

  const allItems = listQ.data?.items ?? [];
  const items = useMemo(() => {
    let rows = allItems;
    // Role-based queue lens: narrow to the active queue's categories
    // (client-side, mirroring the ageBucket slice — the list API has no
    // case_category param). '*' queues (all_cases / audit_review) pass
    // everything through, so the default view is unchanged.
    if (activeQueue) rows = rows.filter((c) => caseMatchesQueue(activeQueue, c));
    if (ageBucketRange) {
      const now = Date.now();
      rows = rows.filter((c) => {
        const ageDays = Math.floor((now - new Date(c.created_at).getTime()) / 86_400_000);
        if (ageDays < ageBucketRange.min) return false;
        if (ageBucketRange.max !== null && ageDays > ageBucketRange.max) return false;
        return true;
      });
    }
    return rows;
  }, [allItems, ageBucketRange, activeQueue]);

  const clearDeepLink = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('ageBucket');
    sp.delete('breached');
    setSearchParams(sp, { replace: true });
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((c) => c.case_id)));
  };

  const stats = statsQ.data;
  const slaCount = slaQ.data?.total ?? 0;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Case Management"
        subtitle="Alert-driven cases with full lifecycle, audit trail, and SLA tracking."
        actions={
          <div className="flex gap-2">
            <Link to="/cms/cases/kanban">
              <Button variant="ghost">Kanban view</Button>
            </Link>
            {canAutoEscalate && (
              <Button
                variant="ghost"
                onClick={() => setShowAutoEscalate(true)}
                data-testid="cms-auto-escalate-btn"
              >
                <Zap size={14} /> Auto-escalate SLA
              </Button>
            )}
            <Button onClick={() => void qc.invalidateQueries({ queryKey: ['cms-cases'] })}>
              <RefreshCw size={14} /> Refresh
            </Button>
          </div>
        }
      />

      {showAutoEscalate && (
        <AutoEscalateSlaModal
          onClose={() => setShowAutoEscalate(false)}
          onExecuted={() => {
            void qc.invalidateQueries({ queryKey: ['cms-cases'] });
            void qc.invalidateQueries({ queryKey: ['cms-stats'] });
            void qc.invalidateQueries({ queryKey: ['cms-sla'] });
          }}
        />
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          title="Total"
          value={stats?.total ?? 0}
          icon={<CheckCircle2 size={16} />}
        />
        <StatCard
          title="SLA Breached"
          value={stats?.sla_breached_count ?? slaCount}
          tone="danger"
          icon={<AlertTriangle size={16} />}
        />
        <StatCard
          title="SLA Warning"
          value={stats?.sla_warning_count ?? 0}
          tone="warning"
          icon={<Clock size={16} />}
        />
        <StatCard
          title="Open + Investigating"
          value={
            (stats?.by_status.OPEN ?? 0) +
            (stats?.by_status.ASSIGNED ?? 0) +
            (stats?.by_status.INVESTIGATING ?? 0)
          }
          icon={<UserPlus size={16} />}
        />
      </div>

      {/* Quick filters + search */}
      <Panel title="Cases">
        {/* Phase 4 — role-based case queue tabs (additive lens). Only shown
            when the viewer has more than one queue; live backend roles
            default to the 'All cases' tab so the view is unchanged. */}
        {queues.length > 1 && activeQueue && (
          <div
            className="mb-3 flex flex-wrap items-center gap-1"
            data-testid="cms-queue-tabs"
          >
            <span className="mr-1 text-xs font-medium uppercase text-slate-400">
              Queue
            </span>
            {queues.map((qd) => {
              const active = qd.id === activeQueue.id;
              return (
                <button
                  key={qd.id}
                  type="button"
                  onClick={() => selectQueue(qd.id)}
                  aria-pressed={active}
                  title={qd.description}
                  data-testid={`cms-queue-tab-${qd.id}`}
                  className={
                    active
                      ? 'rounded-md border border-blue-500 bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700'
                      : 'rounded-md border border-slate-300 px-3 py-1 text-sm text-slate-600 hover:border-blue-300'
                  }
                >
                  {qd.label}
                  {qd.readOnly && (
                    <span className="ml-1 text-2xs uppercase text-slate-400">
                      read-only
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {(ageBucketLabel || breachedOnly) && (
          <div
            className="mb-3 flex items-center gap-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm"
            data-testid="cms-deeplink-filter"
          >
            <span className="text-xs font-medium text-blue-800">
              Filtered from dashboard:
            </span>
            {ageBucketLabel && (
              <Badge tone="blue" className="text-2xs">
                Age {ageBucketLabel}
              </Badge>
            )}
            {breachedOnly && (
              <Badge tone="danger" className="text-2xs">
                Breached only
              </Badge>
            )}
            <span className="text-2xs text-blue-700">
              showing {items.length} of {allItems.length}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={clearDeepLink}
              className="text-xs text-blue-700 hover:underline"
              data-testid="cms-deeplink-clear"
            >
              Clear
            </button>
          </div>
        )}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-sm">
            <Search size={14} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search title, description, case#"
              className="w-64 outline-none"
            />
          </div>
          <select
            value={filters.status ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, status: (e.target.value || undefined) as CmsCaseState }))
            }
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">All statuses</option>
            {STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            value={filters.priority ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, priority: (e.target.value || undefined) as CmsPriority }))
            }
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            value={filters.assigned_to ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, assigned_to: e.target.value || undefined }))
            }
            placeholder="Assigned to…"
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          />
          {myUsername && (
            <Button
              variant={mineOnly ? 'primary' : 'ghost'}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  assigned_to: mineOnly ? undefined : myUsername,
                }))
              }
              data-testid="cms-my-cases-toggle"
            >
              My cases
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setFilters({});
              setQ('');
            }}
          >
            Clear
          </Button>
        </div>

        {/* Bulk actions — suppressed in read-only (auditor) queues */}
        {selected.size > 0 && !readOnlyQueue ? (
          <div className="mb-3 flex items-center gap-2 rounded-md bg-blue-50 p-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <input
              value={bulkAssignee}
              onChange={(e) => setBulkAssignee(e.target.value)}
              placeholder="Assign to…"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <Button
              onClick={() =>
                bulkAssignMut.mutate({
                  case_ids: Array.from(selected),
                  assigned_to: bulkAssignee.trim(),
                })
              }
              disabled={!bulkAssignee.trim() || bulkAssignMut.isPending}
            >
              Bulk assign
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        ) : null}

        {/* Table */}
        {listQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-slate-500">No cases match these filters.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-2 pr-2 w-6">
                  {!readOnlyQueue && (
                    <input
                      type="checkbox"
                      checked={selected.size === items.length && items.length > 0}
                      onChange={toggleAll}
                    />
                  )}
                </th>
                <th className="py-2 pr-2">Case #</th>
                <th className="py-2 pr-2">Title</th>
                <th className="py-2 pr-2">Status</th>
                <th className="py-2 pr-2">Priority</th>
                <th className="py-2 pr-2">Assigned</th>
                <th className="py-2 pr-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <CaseRow
                  key={c.case_id}
                  c={c}
                  selected={selected.has(c.case_id)}
                  onToggle={() => toggleSelected(c.case_id)}
                  readOnly={readOnlyQueue}
                />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function CaseRow({
  c,
  selected,
  onToggle,
  readOnly,
}: {
  c: CmsCase;
  selected: boolean;
  onToggle: () => void;
  readOnly?: boolean;
}) {
  return (
    <tr className="border-b border-slate-100">
      <td className="py-2 pr-2">
        {!readOnly && <input type="checkbox" checked={selected} onChange={onToggle} />}
      </td>
      <td className="py-2 pr-2 font-mono text-xs">
        <Link to={`/cms/cases/${c.case_id}`} className="text-blue-600 hover:underline">
          {c.case_number}
        </Link>
      </td>
      <td className="py-2 pr-2">{c.title}</td>
      <td className="py-2 pr-2">
        <CaseStatusBadge status={c.status} />
      </td>
      <td className="py-2 pr-2">
        <CasePriorityBadge priority={c.priority} />
      </td>
      <td className="py-2 pr-2 text-xs text-slate-600">{c.assigned_to ?? '—'}</td>
      <td className="py-2 pr-2 text-xs text-slate-500">
        {new Date(c.updated_at).toLocaleString()}
      </td>
    </tr>
  );
}

function StatCard({
  title,
  value,
  icon,
  tone,
}: {
  title: string;
  value: number | string;
  icon: React.ReactNode;
  tone?: 'danger' | 'warning';
}) {
  const toneClass =
    tone === 'danger'
      ? 'border-rose-300 bg-rose-50 text-rose-700'
      : tone === 'warning'
        ? 'border-amber-300 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-white text-slate-700';
  return (
    <div className={`flex items-center gap-3 rounded-md border p-3 ${toneClass}`}>
      <div className="rounded-full bg-white p-2">{icon}</div>
      <div>
        <div className="text-xs uppercase">{title}</div>
        <div className="text-2xl font-semibold">{value}</div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// M3.1 — Auto-escalate SLA modal
//
// Two-step UX: dry-run preview (mandatory first click) → operator
// reviews would-escalate count + candidates → "Execute" runs the
// real mutation. Escape-to-close. Per-row severity badge + threshold
// override slider (0..100% in 5pt steps; defaults to M13.1 config).
// ──────────────────────────────────────────────────────────────────

function AutoEscalateSlaModal({
  onClose,
  onExecuted,
}: {
  onClose: () => void;
  onExecuted: () => void;
}) {
  const [thresholdPct, setThresholdPct] = useState<number | null>(null); // null = use server default
  const [plan, setPlan] = useState<CmsAutoEscalateResult | null>(null);
  const [result, setResult] = useState<CmsAutoEscalateResult | null>(null);

  const dryRunMut = useMutation({
    mutationFn: () =>
      cmsApi.autoEscalateSla({
        dry_run: true,
        threshold_pct_override: thresholdPct !== null ? thresholdPct / 100 : undefined,
      }),
    onSuccess: (data) => setPlan(data),
  });
  const executeMut = useMutation({
    mutationFn: () =>
      cmsApi.autoEscalateSla({
        dry_run: false,
        threshold_pct_override: thresholdPct !== null ? thresholdPct / 100 : undefined,
      }),
    onSuccess: (data) => {
      setResult(data);
      onExecuted();
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const view = result ?? plan;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Auto-escalate SLA breaches"
      data-testid="cms-auto-escalate-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-lg border border-slate-300 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Auto-escalate SLA breaches</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        <p className="text-sm text-slate-600">
          Walks non-closed cases and escalates those whose SLA progress
          (elapsed ÷ total) reaches the threshold. Default lives at the
          M13.1 config key <code>cases.auto_escalate_at_pct</code> (typically 80%).
          Override below for a one-off run.{' '}
          <strong>Run a dry-run first</strong> to preview the impact.
        </p>

        <div className="mt-4 flex items-center gap-3" data-testid="cms-auto-escalate-threshold-row">
          <label className="text-sm font-medium">Threshold override:</label>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={thresholdPct ?? 80}
            onChange={(e) => setThresholdPct(Number(e.target.value))}
            disabled={result !== null}
            className="w-48"
          />
          <span className="text-sm tabular-nums" data-testid="cms-auto-escalate-threshold-value">
            {thresholdPct !== null ? `${thresholdPct}%` : 'config default'}
          </span>
          {thresholdPct !== null && result === null && (
            <Button variant="ghost" onClick={() => setThresholdPct(null)}>
              Reset
            </Button>
          )}
        </div>

        {!view ? (
          <div className="mt-6 rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            Click <strong>Preview</strong> to see which cases would escalate.
          </div>
        ) : (
          <div className="mt-6 space-y-4" data-testid="cms-auto-escalate-result">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <SummaryStat label="Threshold" value={`${view.threshold_pct}%`} />
              <SummaryStat label="Considered" value={view.total_considered.toString()} />
              <SummaryStat
                label={result ? 'Escalated' : 'Would escalate'}
                value={(result ? result.escalated.length : view.would_escalate).toString()}
                tone={result ? 'success' : 'warning'}
              />
              <SummaryStat
                label="Skipped"
                value={view.skipped.length.toString()}
              />
            </div>

            {view.candidates.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold uppercase text-slate-500">Candidates</h3>
                <div className="max-h-64 overflow-y-auto rounded border border-slate-200">
                  <table className="min-w-full text-sm" data-testid="cms-auto-escalate-candidates">
                    <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Case</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Priority</th>
                        <th className="px-3 py-2">Progress</th>
                        <th className="px-3 py-2">Severity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.candidates.map((c) => (
                        <tr key={c.case_id} className="border-t border-slate-200">
                          <td className="px-3 py-2 font-medium">{c.case_number}</td>
                          <td className="px-3 py-2">
                            <Badge tone={STATUS_TONE[c.status] as never}>{c.status}</Badge>
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={PRIORITY_TONE[c.priority] as never}>{c.priority}</Badge>
                          </td>
                          <td className="px-3 py-2 tabular-nums">{c.current_progress_pct}%</td>
                          <td className="px-3 py-2">
                            <Badge tone={c.breach_severity === 'breached' ? 'danger' : 'warning'}>
                              {c.breach_severity}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {result && result.errors.length > 0 && (
              <div
                className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700"
                data-testid="cms-auto-escalate-errors"
              >
                <strong>{result.errors.length} error(s):</strong>
                <ul className="mt-1 list-disc pl-5">
                  {result.errors.map((e) => (
                    <li key={e.case_id}>
                      {e.case_id}: {e.code} — {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!plan && (
            <Button
              onClick={() => dryRunMut.mutate()}
              disabled={dryRunMut.isPending}
              data-testid="cms-auto-escalate-preview"
            >
              {dryRunMut.isPending ? 'Previewing…' : 'Preview'}
            </Button>
          )}
          {plan && !result && plan.candidates.length > 0 && (
            <Button
              onClick={() => executeMut.mutate()}
              disabled={executeMut.isPending}
              data-testid="cms-auto-escalate-execute"
            >
              {executeMut.isPending ? 'Escalating…' : `Execute (${plan.candidates.length})`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning';
}) {
  const toneClass =
    tone === 'success'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
      : tone === 'warning'
        ? 'border-amber-300 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-white text-slate-700';
  return (
    <div className={`rounded border p-3 ${toneClass}`}>
      <div className="text-xs uppercase opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
