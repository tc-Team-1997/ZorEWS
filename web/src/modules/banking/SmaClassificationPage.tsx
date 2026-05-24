// web/src/modules/banking/SmaClassificationPage.tsx
//
// SMA Classification — Act 7 bonus of ZorEWS_Demo_Script.md.
// Wraps /v1/banking/sma/movements with a category-mix chart + drill table.

import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { api, type SmaMovementsReport } from '@/lib/api';
import { Badge, type BadgeTone, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

const CATEGORY_TONE: Record<string, BadgeTone> = {
  'SMA-0': 'warning',
  'SMA-1': 'warning',
  'SMA-2': 'danger',
  NPA: 'danger',
};

const CATEGORY_COLOR: Record<string, string> = {
  'SMA-0': color.warning ?? '#f59e0b',
  'SMA-1': color.warning ?? '#f59e0b',
  'SMA-2': color.danger ?? '#dc2626',
  NPA: color.danger ?? '#dc2626',
};

export function SmaClassificationPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['sma.movements'],
    queryFn: () => api.smaMovements(),
  });

  const body: SmaMovementsReport | undefined = data;

  const chartData = body
    ? Object.entries(body.by_category_count).map(([cat, n]) => ({ category: cat, count: n }))
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="SMA Classification"
        subtitle="Today's movements per RBI's Special Mention Account framework — SMA-0 / 1 / 2 / NPA."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="Total movements today" value={body?.total_movements.toString() ?? '—'} />
        <MetricCard label="Deteriorations" value={body?.deteriorations.toString() ?? '—'} tone="danger" />
        <MetricCard label="Improvements" value={body?.improvements.toString() ?? '—'} tone="success" />
        <MetricCard
          label="Exposure at risk"
          value={body ? formatKES(body.total_exposure_at_risk_kes) : '—'}
        />
      </div>

      <Panel title={`Category mix — as of ${body?.date ?? '—'} (Framework: ${body?.framework ?? 'RBI'})`}>
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <XAxis dataKey="category" stroke={color.ink} fontSize={12} />
              <YAxis stroke={color.ink} fontSize={12} />
              <Tooltip />
              <Bar dataKey="count">
                {chartData.map((d, i) => (
                  <Cell key={i} fill={CATEGORY_COLOR[d.category] ?? color.blue} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </Panel>

      <Panel title={`Movement detail (${body?.movements.length ?? 0})`}>
        {body && body.movements.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Sector</th>
                  <th className="px-3 py-2">From → To</th>
                  <th className="px-3 py-2 text-right">DPD</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {body.movements.slice(0, 50).map((m, idx) => (
                  <tr key={`${m.customer_id}-${idx}`} className="border-t border-divider hover:bg-action/5">
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{m.customer_name}</div>
                      <div className="text-xs text-ink-subtle">{m.customer_id}</div>
                    </td>
                    <td className="px-3 py-2 text-ink-subtle">{m.sector.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2">
                      <Badge tone={CATEGORY_TONE[m.from_category] ?? 'success'}>{m.from_category}</Badge>
                      <span className="mx-1 text-ink-subtle">→</span>
                      <Badge tone={CATEGORY_TONE[m.to_category] ?? 'warning'}>{m.to_category}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{m.dpd}d</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatKES(m.outstanding_kes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-ink-subtle">No movements observed today.</p>
        )}
      </Panel>
    </div>
  );
}
