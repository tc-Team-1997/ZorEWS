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
} from 'lucide-react';
import { Badge, Button, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  cmsApi,
  PRIORITY_TONE,
  STATUS_TONE,
  type CmsCase,
  type CmsCaseState,
  type CmsListFilters,
  type CmsPriority,
} from './api';

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

  const listQ = useQuery({
    queryKey: ['cms-cases', filters, q],
    queryFn: () => cmsApi.list({ ...filters, q: q || undefined }),
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

  // Deep-link filter from the dashboard SLA Breach Matrix tile
  // (BAC §3.1.9.1.4): /cms/cases?ageBucket=8-30d&breached=true.
  // Applied client-side on top of the server-side `filters` state.
  const [searchParams, setSearchParams] = useSearchParams();
  const ageBucket = (searchParams.get('ageBucket') as SlaBucketSlug | null) ?? null;
  const breachedOnly = searchParams.get('breached') === 'true';
  const ageBucketLabel = ageBucket ? SLA_BUCKET_LABEL[ageBucket] : null;

  const ageBucketRange = useMemo<{ min: number; max: number | null } | null>(() => {
    if (!ageBucket) return null;
    if (ageBucket === '0-7d')   return { min: 0,  max: 7   };
    if (ageBucket === '8-30d')  return { min: 8,  max: 30  };
    if (ageBucket === '31-90d') return { min: 31, max: 90  };
    return                            { min: 91, max: null };
  }, [ageBucket]);

  // Reset selection when the deep-link filter changes (the visible
  // rows are different, so a stale Set is misleading).
  useEffect(() => { setSelected(new Set()); }, [ageBucket, breachedOnly]);

  const allItems = listQ.data?.items ?? [];
  const items = useMemo(() => {
    if (!ageBucketRange && !breachedOnly) return allItems;
    const now = Date.now();
    return allItems.filter((c) => {
      const ageDays = Math.floor((now - new Date(c.created_at).getTime()) / 86_400_000);
      if (ageBucketRange) {
        if (ageDays < ageBucketRange.min) return false;
        if (ageBucketRange.max !== null && ageDays > ageBucketRange.max) return false;
      }
      if (breachedOnly) {
        // Heuristic without a server-computed flag: treat as breached
        // if status is not closed AND age > priority-derived target
        // (P1 1d / P2 3d / P3 7d / P4 14d). The dashboard endpoint
        // computes the *real* breach status against sla_config; this
        // is the in-list approximation while the row-level flag
        // ships.
        const target = c.priority === 'P1' ? 1 : c.priority === 'P2' ? 3 : c.priority === 'P3' ? 7 : 14;
        if (c.status === 'CLOSED') return false;
        if (ageDays <= target) return false;
      }
      return true;
    });
  }, [allItems, ageBucketRange, breachedOnly]);

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
            <Button onClick={() => void qc.invalidateQueries({ queryKey: ['cms-cases'] })}>
              <RefreshCw size={14} /> Refresh
            </Button>
          </div>
        }
      />

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

        {/* Bulk actions */}
        {selected.size > 0 ? (
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
                  <input
                    type="checkbox"
                    checked={selected.size === items.length && items.length > 0}
                    onChange={toggleAll}
                  />
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
}: {
  c: CmsCase;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="border-b border-slate-100">
      <td className="py-2 pr-2">
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </td>
      <td className="py-2 pr-2 font-mono text-xs">
        <Link to={`/cms/cases/${c.case_id}`} className="text-blue-600 hover:underline">
          {c.case_number}
        </Link>
      </td>
      <td className="py-2 pr-2">{c.title}</td>
      <td className="py-2 pr-2">
        <Badge tone={STATUS_TONE[c.status] as never}>{c.status}</Badge>
      </td>
      <td className="py-2 pr-2">
        <Badge tone={PRIORITY_TONE[c.priority] as never}>{c.priority}</Badge>
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
