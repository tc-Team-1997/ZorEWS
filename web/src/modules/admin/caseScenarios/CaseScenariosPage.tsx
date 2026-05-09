import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  api,
  type CaseScenarioPriority,
  type CaseScenarioRow,
  type CaseScenarioStatus,
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
import { CaseScenarioFormModal } from './CaseScenarioFormModal';
import { CaseScenarioHistoryModal } from './CaseScenarioHistoryModal';

const STATUS_TONE: Record<CaseScenarioStatus, BadgeTone> = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  ARCHIVED: 'neutral',
};

const PRIORITY_TONE: Record<CaseScenarioPriority, BadgeTone> = {
  P1: 'danger',
  P2: 'warning',
  P3: 'blue',
  P4: 'neutral',
};

type StatusFilter = CaseScenarioStatus | 'ALL';
type PriorityFilter = CaseScenarioPriority | 'ALL';

export function CaseScenariosPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [editing, setEditing] = useState<CaseScenarioRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [viewingHistory, setViewingHistory] = useState<CaseScenarioRow | null>(null);

  const list = useQuery({
    queryKey: ['case-scenarios', statusFilter, priorityFilter],
    queryFn: () =>
      api.caseScenariosList({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        priority: priorityFilter === 'ALL' ? undefined : priorityFilter,
        include_deleted: statusFilter === 'ARCHIVED' || statusFilter === 'ALL',
        page_size: 200,
      }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['case-scenarios'] });

  const create = useMutation({
    mutationFn: api.caseScenarioCreate,
    onSuccess: () => { setCreating(false); refresh(); },
  });
  const update = useMutation({
    mutationFn: (input: { id: string; patch: Parameters<typeof api.caseScenarioUpdate>[1] }) =>
      api.caseScenarioUpdate(input.id, input.patch),
    onSuccess: () => { setEditing(null); refresh(); },
  });
  const activate = useMutation({ mutationFn: api.caseScenarioActivate, onSuccess: refresh });
  const archive = useMutation({ mutationFn: api.caseScenarioArchive, onSuccess: refresh });
  const restore = useMutation({ mutationFn: api.caseScenarioRestore, onSuccess: refresh });

  const filtered = useMemo(() => {
    const items = list.data?.items ?? [];
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.case_category.toLowerCase().includes(q) ||
        (r.trigger_indicator_id ?? '').toLowerCase().includes(q),
    );
  }, [list.data?.items, search]);

  const counts = useMemo(() => {
    const items = list.data?.items ?? [];
    return {
      all: items.length,
      draft: items.filter((r) => r.status === 'DRAFT').length,
      active: items.filter((r) => r.status === 'ACTIVE').length,
      archived: items.filter((r) => r.status === 'ARCHIVED').length,
    };
  }, [list.data?.items]);

  const columns: Column<CaseScenarioRow & { id: string }>[] = [
    {
      key: 'name',
      header: 'Scenario',
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
      key: 'trigger',
      header: 'Trigger',
      render: (r) =>
        r.trigger_indicator_id ? (
          <div className="flex flex-col text-2xs tabular-nums">
            <span className="font-mono">{r.trigger_indicator_id}</span>
            <span className="text-muted">≥ {r.trigger_threshold}</span>
          </div>
        ) : (
          <span className="text-2xs italic text-muted">manual</span>
        ),
      width: 130,
    },
    {
      key: 'checklist',
      header: 'Checklist',
      render: (r) => (
        <div className="flex flex-col text-2xs">
          <span className="tabular-nums">{r.checklist.length} items</span>
          <span className="text-muted">
            {r.checklist.filter((c) => c.required).length} required
          </span>
        </div>
      ),
      width: 100,
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
      width: 120,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setViewingHistory(r)}
            className="text-2xs text-slate-600 hover:underline inline-flex items-center gap-1"
            data-testid={`cs-history-${r.scenario_id}`}
          >
            <History className="w-3 h-3" /> History
          </button>
          {r.deleted_at === null && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => setEditing(r)}
                className="text-2xs text-blue-600 hover:underline inline-flex items-center gap-1"
                data-testid={`cs-edit-${r.scenario_id}`}
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
            </>
          )}
          {r.status === 'DRAFT' && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => activate.mutate(r.scenario_id)}
                className="text-2xs text-emerald-700 hover:underline inline-flex items-center gap-1"
                disabled={activate.isPending}
                data-testid={`cs-activate-${r.scenario_id}`}
              >
                <CheckCircle2 className="w-3 h-3" /> Activate
              </button>
            </>
          )}
          {r.deleted_at === null && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => archive.mutate(r.scenario_id)}
                className="text-2xs text-rose-600 hover:underline inline-flex items-center gap-1"
                disabled={archive.isPending}
                data-testid={`cs-archive-${r.scenario_id}`}
              >
                <Trash2 className="w-3 h-3" /> Archive
              </button>
            </>
          )}
          {r.deleted_at !== null && (
            <>
              <span className="text-2xs text-muted">·</span>
              <button
                type="button"
                onClick={() => restore.mutate(r.scenario_id)}
                className="text-2xs text-emerald-700 hover:underline inline-flex items-center gap-1"
                disabled={restore.isPending}
                data-testid={`cs-restore-${r.scenario_id}`}
              >
                <RotateCcw className="w-3 h-3" /> Restore
              </button>
            </>
          )}
        </div>
      ),
      width: 280,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Case Scenarios"
        subtitle="Admin-curated case templates · auto-trigger + escalation + checklist + notification"
        actions={
          <Button onClick={() => setCreating(true)} data-testid="cs-new">
            <Plus className="w-4 h-4 mr-1" /> New scenario
          </Button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4">
        {(['ALL', 'DRAFT', 'ACTIVE', 'ARCHIVED'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`text-left rounded-md border px-3 py-2 ${
              statusFilter === s ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-white'
            }`}
            onClick={() => setStatusFilter(s)}
            data-testid={`cs-pivot-${s.toLowerCase()}`}
          >
            <div className="text-2xs uppercase tracking-wide text-muted">
              {s === 'ALL' ? 'All' : s.toLowerCase()}
            </div>
            <div className="text-2xl font-semibold">
              {s === 'ALL'
                ? counts.all
                : s === 'DRAFT'
                  ? counts.draft
                  : s === 'ACTIVE'
                    ? counts.active
                    : counts.archived}
            </div>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / category / indicator…"
          className="w-72"
          data-testid="cs-search"
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
              data-testid={`cs-priority-filter-${p.toLowerCase()}`}
            >
              {p === 'ALL' ? 'all priorities' : p}
            </button>
          ))}
        </div>
      </div>

      {list.isLoading ? (
        <p className="py-6 text-center text-sm text-muted">Loading scenarios…</p>
      ) : list.isError ? (
        <p className="py-6 text-center text-sm text-rose-700" role="alert">
          Failed to load scenarios: {(list.error as Error)?.message}
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted" data-testid="cs-empty">
          <Zap className="mx-auto h-8 w-8 text-slate-300" />
          No scenarios match the current filters.
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={filtered.map((r) => ({ ...r, id: r.scenario_id }))}
        />
      )}

      {creating && (
        <CaseScenarioFormModal
          mode="create"
          existing={list.data?.items ?? []}
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
          isPending={create.isPending}
          error={create.error}
        />
      )}
      {editing && (
        <CaseScenarioFormModal
          mode="edit"
          row={editing}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => update.mutate({ id: editing.scenario_id, patch })}
          isPending={update.isPending}
          error={update.error}
        />
      )}
      {viewingHistory && (
        <CaseScenarioHistoryModal
          scenario={viewingHistory}
          onClose={() => setViewingHistory(null)}
        />
      )}
    </div>
  );
}
