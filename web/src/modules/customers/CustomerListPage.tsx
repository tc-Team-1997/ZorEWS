import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type CustomerListRow } from '@/lib/api';
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
import { fmtKES } from '@/lib/currency';

const LEVEL_TONE: Record<CustomerListRow['level'], BadgeTone> = {
  Low: 'success',
  Medium: 'warning',
  High: 'danger',
};

const LEVELS: ReadonlyArray<CustomerListRow['level']> = ['Low', 'Medium', 'High'];

// Compact currency — delegates to canonical @/lib/currency fmtKES
const fmtCurrency = fmtKES;

export function CustomerListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const levelParam = searchParams.get('level');
  const pdMinParam = searchParams.get('pdMin');
  const pdMin = pdMinParam !== null ? Number(pdMinParam) : null;

  // The KPI card "High-risk customers" deep-links to ?pdMin=0.5; the chip
  // bar lets the user narrow further or switch to a single risk band.
  const { data, isLoading } = useQuery({
    queryKey: ['customers.list', levelParam, pdMin],
    queryFn: () =>
      api.customerList({
        level: levelParam ?? undefined,
        pdMin: pdMin !== null && !Number.isNaN(pdMin) ? pdMin : undefined,
      }),
  });
  useChatContext({ page: 'customers' });

  const setLevel = (next: CustomerListRow['level'] | null) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('level', next);
    else sp.delete('level');
    setSearchParams(sp, { replace: true });
  };

  const clearPdMin = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete('pdMin');
    setSearchParams(sp, { replace: true });
  };

  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: () => void }[] = [];
    if (pdMin !== null && !Number.isNaN(pdMin)) {
      chips.push({
        key: 'pdMin',
        label: `PD ≥ ${pdMin.toFixed(2)}`,
        clear: clearPdMin,
      });
    }
    return chips;
    // setSearchParams identity changes per render — intentionally omit from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdMin]);

  const columns: Column<CustomerListRow>[] = [
    {
      key: 'id',
      header: 'ID',
      width: 80,
      render: (c) => <span className="font-mono text-2xs text-muted">{c.id}</span>,
    },
    {
      key: 'name',
      header: 'Customer',
      render: (c) => <p className="text-ink font-medium">{c.name}</p>,
    },
    {
      key: 'level',
      header: 'Risk band',
      width: 110,
      render: (c) => (
        <Badge tone={LEVEL_TONE[c.level]} className="uppercase tracking-wide">
          {c.level}
        </Badge>
      ),
    },
    {
      key: 'pd',
      header: 'PD',
      width: 80,
      align: 'right',
      render: (c) => (
        <span className="tabular text-ink">{(c.pd * 100).toFixed(1)}%</span>
      ),
    },
    {
      key: 'exposure',
      header: 'Exposure',
      width: 140,
      align: 'right',
      render: (c) => <span className="tabular text-ink-sub">{fmtCurrency(c.exposure)}</span>,
    },
    {
      key: 'dpd',
      header: 'DPD',
      width: 70,
      align: 'right',
      render: (c) => (
        <span className={c.dpd >= 30 ? 'text-danger font-semibold tabular' : 'text-ink-sub tabular'}>
          {c.dpd}
        </span>
      ),
    },
  ];

  const total = data?.total ?? 0;
  const subtitle = isLoading
    ? 'Loading…'
    : `${total} customer${total === 1 ? '' : 's'} match the current filters`;

  return (
    <div>
      <PageHeader title="Customers" subtitle={subtitle} />

      <Panel className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-sub mr-2">Risk band</span>
          <FilterChip active={levelParam === null} onClick={() => setLevel(null)}>
            All
          </FilterChip>
          {LEVELS.map((lvl) => (
            <FilterChip key={lvl} active={levelParam === lvl} onClick={() => setLevel(lvl)}>
              {lvl}
            </FilterChip>
          ))}
          {activeChips.length > 0 && (
            <>
              <span className="w-px h-5 bg-divider mx-2" />
              {activeChips.map((c) => (
                <ActiveFilterChip
                  key={c.key}
                  label={c.label}
                  onClear={c.clear}
                  testId={`active-chip-${c.key}`}
                />
              ))}
            </>
          )}
        </div>
      </Panel>

      <DataTable
        columns={columns}
        data={data?.items ?? []}
        empty={isLoading ? 'Loading customers…' : 'No customers match the current filters.'}
        onRowClick={(row) => navigate(`/customers/${row.id}`)}
      />
    </div>
  );
}
