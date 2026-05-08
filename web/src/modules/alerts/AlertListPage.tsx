import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, Link2, MoreHorizontal } from 'lucide-react';
import { api, type Alert, type Severity } from '@/lib/api';
import { Badge, type BadgeTone, Button, DataTable, type Column, FilterChip, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';
import { useAlertStream } from '@/components/notifications/useAlertStream';
import { bandFor, type SortKey } from '@/lib/criticality';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

const ASSIGNEES: ReadonlyArray<string | null> = [null, 'risk', 'field'];
const ageLabel = (m: number) =>
  m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;

function isSeverity(v: string | null): v is Severity {
  return v !== null && (SEVERITY_ORDER as string[]).includes(v);
}

function isSortKey(v: string | null): v is SortKey {
  return v === 'criticality' || v === 'severity' || v === 'age';
}

const SCORE_BAND_TONE: Record<ReturnType<typeof bandFor>, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'success',
};

export function AlertListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-driven so dashboard KPI cards can deep-link (e.g. /alerts?severity=critical).
  const severityParam = searchParams.get('severity');
  const severity: Severity | null = isSeverity(severityParam) ? severityParam : null;

  const assigneeParam = searchParams.get('assignee');
  // Three states: 'any' (no filter), null (unassigned only), or a specific
  // assignee. URL convention: ?assignee=unassigned for the null case.
  const assignee: string | null | 'any' =
    assigneeParam === null
      ? 'any'
      : assigneeParam === 'unassigned'
        ? null
        : assigneeParam;

  // Sort + dedup are URL-synced too so a deep-linked queue layout
  // survives bookmarks + browser-back. Defaults: sort=criticality (the
  // value-add of Task 6), dedup=true (most useful starting view).
  const sortParam = searchParams.get('sort');
  const sort: SortKey = isSortKey(sortParam) ? sortParam : 'criticality';
  const dedupParam = searchParams.get('dedup');
  const dedup: boolean = dedupParam === null ? true : dedupParam === 'true';

  const setSeverity = (next: Severity | null) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('severity', next);
    else sp.delete('severity');
    setSearchParams(sp, { replace: true });
  };

  const setAssignee = (next: string | null | 'any') => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'any') sp.delete('assignee');
    else if (next === null) sp.set('assignee', 'unassigned');
    else sp.set('assignee', next);
    setSearchParams(sp, { replace: true });
  };

  const setSort = (next: SortKey) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'criticality') sp.delete('sort');
    else sp.set('sort', next);
    setSearchParams(sp, { replace: true });
  };

  const setDedup = (next: boolean) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.delete('dedup');
    else sp.set('dedup', 'false');
    setSearchParams(sp, { replace: true });
  };

  const queryKey = ['alerts', severity, assignee, sort, dedup] as const;
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      api.alerts({
        severity: severity ?? undefined,
        assignee: typeof assignee === 'string' && assignee !== 'any' ? assignee : undefined,
        sort,
        dedup,
      }),
  });
  useChatContext({ page: 'alerts' });

  // T2.12 — live alert stream. Each `alert.created` event auto-invalidates
  // the query above so the table refreshes silently. The banner below
  // surfaces "+N new" so the operator can scroll to the top deliberately.
  const qc = useQueryClient();
  const stream = useAlertStream({ invalidateQueryKey: queryKey });

  const columns: Column<Alert>[] = [
    {
      key: 'criticality',
      header: 'Score',
      width: 110,
      render: (a) => {
        const band = bandFor(a.criticality_score);
        return (
          <div className="flex flex-col items-start gap-1">
            <Badge tone={SCORE_BAND_TONE[band]} className="uppercase tracking-wide">
              {a.criticality_score.toFixed(2)}
            </Badge>
            <span className="text-2xs text-muted">conf {(a.confidence * 100).toFixed(0)}%</span>
          </div>
        );
      },
    },
    {
      key: 'severity',
      header: 'Severity',
      width: 110,
      render: (a) => (
        <Badge tone={SEVERITY_TONE[a.severity]} className="uppercase tracking-wide">
          {a.severity}
        </Badge>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (a) => (
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-ink font-medium">{a.customer.name}</p>
            {a.linked_alert_ids.length > 0 && (
              <span data-testid={`linked-badge-${a.id}`}>
                <Badge tone="blue" className="inline-flex items-center gap-1">
                  <Link2 size={10} />+{a.linked_alert_ids.length}
                </Badge>
              </span>
            )}
          </div>
          <p className="text-2xs text-muted">{a.customer.id}</p>
        </div>
      ),
    },
    {
      key: 'rule',
      header: 'Rule',
      render: (a) => (
        <div>
          <p className="text-ink">{a.rule.name}</p>
          <p className="text-2xs text-muted">{a.rule.id}</p>
        </div>
      ),
    },
    {
      key: 'indicators',
      header: 'Indicators',
      render: (a) => (
        <div className="flex flex-wrap gap-1">
          {a.indicators.map((id) => (
            <Badge key={id} tone="blue" className="font-mono">
              {id}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: 'age',
      header: 'Age',
      width: 70,
      align: 'right',
      render: (a) => <span className="tabular text-ink-sub">{ageLabel(a.age_min)}</span>,
    },
    {
      key: 'assignee',
      header: 'Assignee',
      width: 120,
      render: (a) =>
        a.assignee ? (
          <Badge tone="neutral">{a.assignee}</Badge>
        ) : (
          <span className="text-2xs text-muted">unassigned</span>
        ),
    },
    {
      key: 'action',
      header: '',
      width: 40,
      align: 'right',
      render: () => (
        <button
          type="button"
          aria-label="Row actions"
          className="text-muted hover:text-ink-sub p-1 rounded"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal size={16} />
        </button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Alerts"
        subtitle={
          isLoading
            ? 'Loading…'
            : `${data?.total ?? 0} ${dedup ? 'customer-deduplicated' : 'individual'} alerts in queue`
        }
      />

      <Panel className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-sub mr-2">Severity</span>
          <FilterChip active={severity === null} onClick={() => setSeverity(null)}>
            All
          </FilterChip>
          {SEVERITY_ORDER.map((s) => (
            <FilterChip key={s} active={severity === s} onClick={() => setSeverity(s)}>
              {s}
            </FilterChip>
          ))}
          <span className="w-px h-5 bg-divider mx-2" />
          <span className="text-xs text-ink-sub mr-2">Assignee</span>
          <FilterChip active={assignee === 'any'} onClick={() => setAssignee('any')}>
            Any
          </FilterChip>
          {ASSIGNEES.map((a) => (
            <FilterChip
              key={a ?? 'unassigned'}
              active={assignee === a}
              onClick={() => setAssignee(a)}
            >
              {a ?? 'Unassigned'}
            </FilterChip>
          ))}
          <span className="w-px h-5 bg-divider mx-2" />
          <label className="text-xs text-ink-sub flex items-center gap-1.5">
            Sort by
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              data-testid="alerts-sort"
              className="bg-surface border border-divider rounded-input px-2 py-1 text-[11px] text-ink"
            >
              <option value="criticality">Criticality</option>
              <option value="severity">Severity</option>
              <option value="age">Age</option>
            </select>
          </label>
          <label className="text-xs text-ink-sub flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={dedup}
              onChange={(e) => setDedup(e.target.checked)}
              className="accent-brand-blue"
              data-testid="alerts-dedup-toggle"
            />
            Dedup by customer
          </label>
        </div>
      </Panel>

      {stream.pending.length > 0 && (
        <div
          role="status"
          data-testid="alerts-live-banner"
          className="mb-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <Bell size={14} className="text-amber-700" />
          <span>
            <span className="font-semibold tabular">+{stream.pending.length}</span>{' '}
            new alert{stream.pending.length === 1 ? '' : 's'} since you opened this view
          </span>
          <Button
            variant="ghost"
            data-testid="alerts-live-refresh"
            onClick={() => {
              void qc.invalidateQueries({ queryKey });
              stream.clear();
            }}
          >
            Show now
          </Button>
        </div>
      )}

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        empty={isLoading ? 'Loading alerts…' : 'No alerts match the filters'}
        onRowClick={(row) => navigate(`/customers/${row.customer.id}`)}
      />
      <p
        className="mt-2 text-[11px] text-ink-sub"
        data-testid="alerts-live-status"
      >
        Live stream:{' '}
        <span className={stream.connected ? 'text-emerald-700' : 'text-slate-500'}>
          {stream.connected ? 'connected' : 'disconnected'}
        </span>
        {stream.totalSeen > 0 && <span> · {stream.totalSeen} seen this session</span>}
      </p>
    </div>
  );
}
