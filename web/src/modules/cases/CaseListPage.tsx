import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api,
  type CaseState,
  type CaseSummary,
  type SlaStatus,
} from '@/lib/api';
import {
  ActiveFilterChip,
  Badge,
  type BadgeTone,
  DataTable,
  type Column,
  FilterChip,
  Panel,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useChatContext } from '@/components/copilot/useChatContext';

const STATE_TONE: Record<CaseState, BadgeTone> = {
  open: 'blue',
  assigned: 'warning',
  in_action: 'purple',
  monitored: 'success',
  closed: 'neutral',
};

const SLA_TONE: Record<SlaStatus, BadgeTone> = {
  on_track: 'success',
  approaching: 'warning',
  breached: 'danger',
  closed: 'neutral',
};

const STATE_OPTIONS: ReadonlyArray<CaseState> = [
  'open',
  'assigned',
  'in_action',
  'monitored',
  'closed',
];

const ageLabel = (m: number) =>
  m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;

export function CaseListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const stateParam = searchParams.get('state');
  const slaParam = searchParams.get('sla');

  const stateSet = stateParam
    ? new Set(stateParam.split(',').map((s) => s.trim()) as CaseState[])
    : null;
  const slaSet = slaParam
    ? new Set(slaParam.split(',').map((s) => s.trim()) as SlaStatus[])
    : null;

  const { data, isLoading } = useQuery({
    queryKey: ['cases', stateParam, slaParam],
    queryFn: () =>
      api.cases({
        state: stateParam ?? undefined,
        sla: slaParam ?? undefined,
      }),
  });
  useChatContext({ page: 'cases' });

  const toggleState = (s: CaseState) => {
    const sp = new URLSearchParams(searchParams);
    const next = new Set(stateSet ?? []);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    if (next.size === 0) sp.delete('state');
    else sp.set('state', Array.from(next).join(','));
    setSearchParams(sp, { replace: true });
  };

  const clearStates = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('state');
    setSearchParams(sp, { replace: true });
  };

  const clearSla = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('sla');
    setSearchParams(sp, { replace: true });
  };

  const slaSummaryLabel = useMemo(() => {
    if (!slaSet) return null;
    return Array.from(slaSet).join(', ').replace(/_/g, ' ');
  }, [slaSet]);

  const columns: Column<CaseSummary>[] = [
    {
      key: 'id',
      header: 'Case',
      width: 130,
      render: (c) => (
        <Link to={`/cases/${c.id}`} className="font-mono text-xs text-brand-blue hover:underline">
          {c.id}
        </Link>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (c) => (
        <Link to={`/cases/${c.id}`} className="block">
          <p className="text-ink font-medium">{c.customer.name}</p>
          <p className="text-2xs text-muted">{c.customer.id}</p>
        </Link>
      ),
    },
    {
      key: 'alert',
      header: 'Origin alert',
      width: 110,
      render: (c) => <span className="font-mono text-2xs text-muted">{c.alert_id}</span>,
    },
    {
      key: 'state',
      header: 'State',
      width: 110,
      render: (c) => (
        <Badge tone={STATE_TONE[c.state]} className="uppercase tracking-wide">
          {c.state.replace('_', ' ')}
        </Badge>
      ),
    },
    {
      key: 'sla',
      header: 'SLA',
      width: 120,
      render: (c) =>
        c.sla_status ? (
          <Badge tone={SLA_TONE[c.sla_status]} className="uppercase tracking-wide">
            {c.sla_status.replace('_', ' ')}
          </Badge>
        ) : (
          <span className="text-2xs text-muted">—</span>
        ),
    },
    {
      key: 'assignee',
      header: 'Assignee',
      width: 130,
      render: (c) =>
        c.assignee ? (
          <Badge tone="neutral">{c.assignee}</Badge>
        ) : (
          <span className="text-2xs text-muted">unassigned</span>
        ),
    },
    {
      key: 'age',
      header: 'Age',
      width: 70,
      align: 'right',
      render: (c) => <span className="tabular text-ink-sub">{ageLabel(c.age_min)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Cases"
        subtitle={isLoading ? 'Loading…' : `${data?.items.length ?? 0} cases match current filters`}
      />

      <Panel className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-sub mr-2">State</span>
          <FilterChip active={stateSet === null} onClick={clearStates}>
            All
          </FilterChip>
          {STATE_OPTIONS.map((s) => (
            <FilterChip key={s} active={stateSet?.has(s) ?? false} onClick={() => toggleState(s)}>
              {s.replace('_', ' ')}
            </FilterChip>
          ))}
          {slaSummaryLabel && (
            <>
              <span className="w-px h-5 bg-divider mx-2" />
              <ActiveFilterChip
                label={`SLA: ${slaSummaryLabel}`}
                onClear={clearSla}
                testId="active-chip-sla"
              />
            </>
          )}
        </div>
      </Panel>

      <DataTable columns={columns} data={data?.items ?? []} empty="No cases match the current filters." />
    </div>
  );
}
