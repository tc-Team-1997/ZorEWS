// web/src/modules/banking/SectorWatchPage.tsx
//
// Sector Watch heatmap — Act 7 bonus of ZorEWS_Demo_Script.md.

import { useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { api, type SectorHeatmapReport } from '@/lib/api';
import { MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

const HEAT_COLOUR: Record<string, string> = {
  critical: 'border-danger bg-danger/15 text-danger',
  high: 'border-warning bg-warning/15 text-warning',
  medium: 'border-action/40 bg-action/5 text-action',
  low: 'border-success/40 bg-success/10 text-success',
};

export function SectorWatchPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['sectors.heatmap'],
    queryFn: () => api.sectorHeatmap(),
  });

  const body: SectorHeatmapReport | undefined = data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sector Watch"
        subtitle="Portfolio concentration × stress heatmap. Click a tile for sector deep-dive."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="Total sectors" value={body?.total_sectors.toString() ?? '—'} />
        <MetricCard label="Critical heat" value={(body?.by_heat_level.critical ?? 0).toString()} tone="danger" />
        <MetricCard label="High heat" value={(body?.by_heat_level.high ?? 0).toString()} tone="warning" />
        <MetricCard label="Low heat" value={(body?.by_heat_level.low ?? 0).toString()} tone="success" />
      </div>

      <Panel title="Sector heatmap">
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {body?.cells.map((cell) => (
              <div
                key={cell.sector}
                data-testid={`sector-${cell.sector}`}
                className={`rounded-lg border p-4 transition hover:scale-[1.02] ${
                  HEAT_COLOUR[cell.heat_level] ?? 'border-divider bg-surface'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{cell.sector.replace(/_/g, ' ')}</h3>
                  {cell.is_watchlisted && <Star className="size-4 fill-current" aria-label="Watchlisted" />}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs uppercase opacity-70">NPA Ratio</div>
                    <div className="text-xl font-bold tabular-nums">{cell.npa_ratio_pct.toFixed(2)}%</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase opacity-70">30d Δ</div>
                    <div className="text-xl font-bold tabular-nums">
                      {cell.delta_30d_pct >= 0 ? '+' : ''}
                      {cell.delta_30d_pct.toFixed(1)}%
                    </div>
                  </div>
                </div>
                <div className="mt-3 border-t border-current/30 pt-2 text-xs opacity-80">
                  {cell.total_customers} customers · {formatKES(cell.total_outstanding_kes)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
