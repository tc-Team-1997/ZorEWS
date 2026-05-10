import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArrowDownNarrowWide, Copy, Pencil, Plus, Search, Trash2 } from 'lucide-react';
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
  const [searchParams] = useSearchParams();
  // M14.32 — `?focus=<escalation_id>` scrolls + flash-highlights the
  // matching row. Set by the M14.31 cross-link from Case Scenarios.
  const focusRowId = searchParams.get('focus');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ACTIVE');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [editing, setEditing] = useState<EscalationMatrixRuleRow | null>(null);
  const [creating, setCreating] = useState(false);
  // M14.28 — clone-as-new flow: prefill the create modal with this row's
  // level timings + roles. Identity fields stay blank so the operator
  // must clear the (case_category, priority) + name uniqueness checks.
  const [duplicating, setDuplicating] = useState<EscalationMatrixRuleRow | null>(null);
  // M14.30 — Test resolver: type a (case_category, priority) and see
  // which rule the BFF would dispatch on. Surfaces the same lookup the
  // case_create_pipeline uses, so ops can validate coverage without
  // firing a real case.
  const [resolverCategory, setResolverCategory] = useState('fraud');
  const [resolverPriority, setResolverPriority] = useState<EscalationPriority>('P1');
  const [resolverResult, setResolverResult] = useState<EscalationMatrixRuleRow | null | undefined>(undefined);

  const list = useQuery({
    queryKey: ['escalation-matrix', statusFilter, priorityFilter],
    queryFn: () =>
      api.escalationMatrixList({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        priority: priorityFilter === 'ALL' ? undefined : priorityFilter,
        page_size: 200,
      }),
  });

  // M14.32 — when navigated with ?focus=<id>, broaden the pivot to
  // ALL on first render so an archived rule still appears + can be
  // highlighted. Runs once per focusRowId — switching pivot manually
  // afterwards is honoured because the dependency array is the id.
  useEffect(() => {
    if (focusRowId) setStatusFilter('ALL');
  }, [focusRowId]);

  // After the page renders the data, scroll the focused row into view.
  // Defers via requestAnimationFrame so the DOM has the row mounted by
  // the time we look it up.
  useEffect(() => {
    if (!focusRowId || list.isLoading) return;
    const handle = requestAnimationFrame(() => {
      const el = document.querySelector('[data-focus-row="true"]');
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [focusRowId, list.isLoading, list.data]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['escalation-matrix'] });

  const create = useMutation({
    mutationFn: api.escalationMatrixCreate,
    onSuccess: () => { setCreating(false); setDuplicating(null); refresh(); },
  });
  const resolve = useMutation({
    mutationFn: ({ category, priority }: { category: string; priority: EscalationPriority }) =>
      api.escalationMatrixResolve(category, priority),
    onSuccess: (data) => setResolverResult(data.rule),
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

  // M14.33 — load all case scenarios once so we can show a "Used by N
  // scenarios" count per rule. Surfaces dependencies before archiving
  // a rule (the BFF doesn't 409 on archive-with-dependents today, so
  // ops need to see this themselves).
  const scenariosForUsage = useQuery({
    queryKey: ['case-scenarios', 'all-for-matrix-usage'],
    queryFn: () =>
      api.caseScenariosList({ include_deleted: true, page_size: 200 }),
  });
  const usageByEscalationId = useMemo(() => {
    const out = new Map<string, number>();
    for (const sc of scenariosForUsage.data?.items ?? []) {
      // Only count non-deleted scenarios — soft-deleted ones aren't a
      // live dependency.
      if (sc.deleted_at !== null) continue;
      out.set(
        sc.default_escalation_id,
        (out.get(sc.default_escalation_id) ?? 0) + 1,
      );
    }
    return out;
  }, [scenariosForUsage.data]);

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
      render: (r) => {
        const usage = usageByEscalationId.get(r.escalation_id) ?? 0;
        return (
          <div className="flex flex-col">
            <span className="font-medium">{r.name}</span>
            <span className="text-2xs text-muted">
              {r.case_category} ·{' '}
              <Badge tone={PRIORITY_TONE[r.priority]} className="text-2xs">{r.priority}</Badge>
            </span>
            <span
              className={`mt-0.5 text-2xs ${usage > 0 ? 'text-blue-700' : 'text-muted italic'}`}
              data-testid={`esc-usage-${r.escalation_id}`}
              title={
                usage > 0
                  ? 'Active scenarios that reference this rule. Archiving will leave them without escalation routing.'
                  : 'No active scenarios reference this rule yet.'
              }
            >
              {usage > 0
                ? `Used by ${usage} scenario${usage === 1 ? '' : 's'}`
                : 'Unused'}
            </span>
          </div>
        );
      },
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
                onClick={() => setDuplicating(r)}
                className="text-2xs text-slate-700 hover:underline inline-flex items-center gap-1"
                data-testid={`esc-duplicate-${r.escalation_id}`}
                title="Open the create form pre-filled with this rule's timings + roles"
              >
                <Copy className="w-3 h-3" /> Duplicate
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

      {/* ── M14.30 Test resolver — preview which rule fires for a (category, priority) ── */}
      <div
        className="mb-4 rounded-md border border-slate-200 bg-white p-3"
        data-testid="esc-resolver-panel"
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Test resolver</h3>
          <span className="text-2xs text-muted">
            Preview the rule that fires for a (case_category, priority) pair
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={resolverCategory}
            onChange={(e) => setResolverCategory(e.target.value)}
            placeholder="case_category"
            className="w-48 text-sm"
            data-testid="esc-resolver-category"
          />
          <select
            value={resolverPriority}
            onChange={(e) => setResolverPriority(e.target.value as EscalationPriority)}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            data-testid="esc-resolver-priority"
          >
            {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <Button
            type="button"
            onClick={() =>
              resolve.mutate({
                category: resolverCategory.trim(),
                priority: resolverPriority,
              })
            }
            disabled={resolve.isPending || !resolverCategory.trim()}
            data-testid="esc-resolver-run"
          >
            <Search className="mr-1 h-3 w-3" /> Resolve
          </Button>
        </div>
        {resolverResult === undefined && (
          <p className="mt-2 text-2xs text-muted" data-testid="esc-resolver-empty">
            No lookup yet — click Resolve to see which rule covers this pair.
          </p>
        )}
        {resolverResult === null && (
          <p className="mt-2 text-2xs text-rose-700" data-testid="esc-resolver-no-match">
            No active rule for ({resolverCategory.trim() || '—'}, {resolverPriority}) — open
            cases on this combo will not escalate. Add a rule to close the gap.
          </p>
        )}
        {resolverResult && (
          <div
            className="mt-2 flex flex-col gap-0.5 text-2xs"
            data-testid="esc-resolver-match"
          >
            <span>
              <span className="font-semibold">{resolverResult.name}</span>
              {' · '}
              <span className="font-mono text-muted">{resolverResult.escalation_id.slice(0, 24)}…</span>
            </span>
            <span>
              <span className="text-muted">L1:</span> {fmtMin(resolverResult.level_1_after_minutes)} → {resolverResult.level_1_role}
              {resolverResult.level_2_after_minutes !== null && (
                <>
                  {' · '}
                  <span className="text-muted">L2:</span> {fmtMin(resolverResult.level_2_after_minutes)} → {resolverResult.level_2_role}
                </>
              )}
              {resolverResult.level_3_after_minutes !== null && (
                <>
                  {' · '}
                  <span className="text-muted">L3:</span> {fmtMin(resolverResult.level_3_after_minutes)} → {resolverResult.level_3_role}
                </>
              )}
            </span>
          </div>
        )}
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
          focusRowId={focusRowId}
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
      {duplicating && (
        <EscalationMatrixFormModal
          mode="create"
          existing={list.data?.items ?? []}
          prefill={duplicating}
          onClose={() => setDuplicating(null)}
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
