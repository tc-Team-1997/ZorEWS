import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownNarrowWide, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  api,
  type EscalationMatrixRuleRow,
  type EscalationPriority,
  type EscalationStatus,
} from '@/lib/api';
import {
  Badge,
  Button,
  DataTable,
  Input,
  type BadgeTone,
  type Column,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { EscalationMatrixFormModal } from './EscalationMatrixFormModal';

const STATUS_TONE: Record<EscalationStatus, BadgeTone> = {
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
};

const PRIORITY_TONE: Record<EscalationPriority, BadgeTone> = {
  P1: 'danger',
  P2: 'warning',
  P3: 'blue',
  P4: 'neutral',
};

type StatusFilter = EscalationStatus | 'ALL';
type PriorityFilter = EscalationPriority | 'ALL';

export function EscalationMatrixPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [editing, setEditing] = useState<EscalationMatrixRuleRow | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['escalation-matrix', statusFilter, priorityFilter],
    queryFn: () =>
      api.escalationMatrixList({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        priority: priorityFilter === 'ALL' ? undefined : priorityFilter,
        page_size: 200,
      }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['escalation-matrix'] });

  const create = useMutation({
    mutationFn: api.escalationMatrixCreate,
    onSuccess: () => { setCreating(false); refresh(); },
  });
  const update = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof api.escalationMatrixUpdate>[1] }) =>
      api.escalationMatrixUpdate(input.id, input.patch),
    onSuccess: () => { setEditing(null); refresh(); },
  });
  const archive = useMutation({
    mutationFn: api.escalationMatrixArchive,
    onSuccess: refresh,
  });

  const filtered = useMemo(() => {
    const items = list.data?.items ?? [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.case_category.toLowerCase().includes(q) ||
        r.level_1_role.toLowerCase().includes(q),
    );
  }, [list.data?.items, search]);

  const counts = useMemo(() => {
    const items = list.data?.items ?? [];
    return {
      all: items.length,
      active: items.filter((r) => r.status === 'ACTIVE').length,
      archived: items.filter((r) => r.status === 'ARCHIVED').length,
    };
  }, [list.data?.items]);

  const columns: Column<EscalationMatrixRuleRow & { id: string }>[] = [
    {
      key: 'name',
      header: 'Rule',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-medium">{r.name}</span>
          <span className="text-2xs text-muted">
            {r.case_category} ·{' '}
            <Badge tone={PRIORITY_TONE[r.priority]} className="text-2xs">{r.priority}</Badge>
          </span>
        </div>
      ),
      width: 280,
    },
    {
      key: 'chain',
      header: 'Escalation chain',
      render: (r) => (
        <div className="flex flex-col text-2xs tabular-nums">
          <span><span className="text-muted">L1:</span> {fmtMin(r.level_1_after_minutes)} → {r.level_1_role}</span>
          {r.level_2_after_minutes !== null && (
            <span className="text-slate-700">
              <ArrowDownNarrowWide className="mr-0.5 inline h-3 w-3" />
              <span className="text-muted">L2:</span> {fmtMin(r.level_2_after_minutes)} → {r.level_2_role}
            </span>
          )}
          {r.level_3_after_minutes !== null && (
            <span className="text-slate-700">
              <ArrowDownNarrowWide className="mr-0.5 inline h-3 w-3" />
              <span className="text-muted">L3:</span> {fmtMin(r.level_3_after_minutes)} → {r.level_3_role}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge tone={STATUS_TONE[r.status]} className="uppercase tracking-wide text-2xs">
          {r.status.toLowerCase()}
        </Badge>
      ),
      width: 110,
    },
    {
      key: 'updated',
      header: 'Updated',
      render: (r) => (
        <div className="flex flex-col text-2xs">
          <span>{new Date(r.updated_at).toLocaleDateString()}</span>
          <span className="text-muted">{r.updated_by ?? r.created_by}</span>
        </div>
      ),
      width: 130,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          {r.status === 'ACTIVE' && (
            <>
              <button
                type="button"
                onClick={() => setEditing(r)}
                className="text-2xs text-blue-600 hover:underline inline-flex items-center gap-1"
                data-testid={`esc-edit-${r.escalation_id}`}
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => archive.mutate(r.escalation_id)}
                className="text-2xs text-rose-600 hover:underline inline-flex items-center gap-1"
                disabled={archive.isPending}
                data-testid={`esc-archive-${r.escalation_id}`}
              >
                <Trash2 className="w-3 h-3" /> Archive
              </button>
            </>
          )}
        </div>
      ),
      width: 160,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Escalation Matrix"
        subtitle="Per-(category, priority) escalation rules · referenced by case scenarios"
        actions={
          <Button onClick={() => setCreating(true)} data-testid="esc-new">
            <Plus className="w-4 h-4 mr-1" /> New rule
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {(['ALL', 'ACTIVE', 'ARCHIVED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`text-left rounded-md border px-3 py-2 ${
              statusFilter === s ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'
            }`}
            onClick={() => setStatusFilter(s)}
            data-testid={`esc-pivot-${s.toLowerCase()}`}
          >
            <div className="text-2xs uppercase tracking-wide text-muted">
              {s === 'ALL' ? 'All' : s.toLowerCase()}
            </div>
            <div className="text-2xl font-semibold">
              {s === 'ALL' ? counts.all : s === 'ACTIVE' ? counts.active : counts.archived}
            </div>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / category / role…"
          className="w-72"
          data-testid="esc-search"
        />
        <div className="flex gap-1">
          {(['ALL', 'P1', 'P2', 'P3', 'P4'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPriorityFilter(p)}
              className={`rounded border px-2 py-1 text-2xs uppercase tracking-wide ${
                priorityFilter === p
                  ? 'border-blue-400 bg-blue-50 text-blue-700'
                  : 'border-slate-200 bg-white text-slate-600'
              }`}
              data-testid={`esc-priority-filter-${p.toLowerCase()}`}
            >
              {p === 'ALL' ? 'all priorities' : p}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? (
        <p className="py-6 text-center text-sm text-muted">Loading rules…</p>
      ) : list.isError ? (
        <p className="py-6 text-center text-sm text-rose-700" role="alert">
          Failed to load rules: {(list.error as Error)?.message}
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted" data-testid="esc-empty">
          No escalation rules match the current filters.
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={filtered.map((r) => ({ ...r, id: r.escalation_id }))}
        />
      )}

      {creating && (
        <EscalationMatrixFormModal
          mode="create"
          existing={list.data?.items ?? []}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
          isPending={create.isPending}
          error={create.error}
        />
      )}
      {editing && (
        <EscalationMatrixFormModal
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => update.mutate({ id: editing.escalation_id, patch })}
          isPending={update.isPending}
          error={update.error}
        />
      )}
    </div>
  );
}

function fmtMin(m: number): string {
  if (m < 60) return `${m}m`;
  const hrs = m / 60;
  if (hrs < 24) return Number.isInteger(hrs) ? `${hrs}h` : `${hrs.toFixed(1)}h`;
  const days = hrs / 24;
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
}
