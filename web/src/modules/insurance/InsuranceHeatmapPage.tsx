// web/src/modules/insurance/InsuranceHeatmapPage.tsx
//
// Insurance EWS — Module 10: Insurance Heatmaps (reusable heatmap UI).
//
// One screen renders any of 5 risk metrics × 3 dimensions from a single code
// path (the spec's "reusable heatmap architecture"): branch-wise fraud,
// region-wise lapse risk, channel risk hotspots, solvency stress regions,
// persistency-weakness areas. Metric selector + dimension toggle, both URL-
// synced. Backed by /v1/insurance/heatmap{,/metrics}; MSW-backed in dev.

import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type HeatmapCatalogShape,
  type InsuranceHeatmapShape,
  type HeatMetricShape,
  type HeatDimensionShape,
  type HeatLevelShape,
} from '@/lib/api';
import { Badge, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const HEAT_TONE: Record<HeatLevelShape, BadgeTone> = {
  critical: 'danger',
  high: 'warning',
  medium: 'blue',
  low: 'success',
};
const HEAT_COLOUR: Record<HeatLevelShape, string> = {
  critical: 'border-danger bg-danger/15 text-danger',
  high: 'border-warning bg-warning/15 text-warning',
  medium: 'border-action/40 bg-action/5 text-action',
  low: 'border-success/40 bg-success/10 text-success',
};

const DIM_LABEL: Record<HeatDimensionShape, string> = { branch: 'Branch', region: 'Region', channel: 'Channel' };
const ALL_DIMS: HeatDimensionShape[] = ['branch', 'region', 'channel'];

function fmtHeadline(value: number, unit: 'count' | 'pct' | 'ratio') {
  if (unit === 'pct') return `${value.toFixed(2)}%`;
  if (unit === 'ratio') return value.toFixed(2);
  return String(value);
}

export function InsuranceHeatmapPage() {
  const [params, setParams] = useSearchParams();
  const metric = (params.get('metric') as HeatMetricShape | null) ?? 'fraud';
  const dimension = (params.get('dimension') as HeatDimensionShape | null) ?? 'branch';

  const { data: catalog } = useQuery<HeatmapCatalogShape>({
    queryKey: ['insurance.heatmap.metrics'],
    queryFn: () => api.insuranceHeatmapMetrics(),
  });

  const { data, isLoading } = useQuery<InsuranceHeatmapShape>({
    queryKey: ['insurance.heatmap', metric, dimension],
    queryFn: () => api.insuranceHeatmap(metric, dimension),
  });

  const metricDef = catalog?.metrics.find((m) => m.metric === metric);

  const setMetric = (m: HeatMetricShape) => {
    const next = new URLSearchParams(params);
    next.set('metric', m);
    // jump to the metric's natural dimension on switch
    const nd = catalog?.metrics.find((d) => d.metric === m)?.natural_dimension;
    if (nd) next.set('dimension', nd);
    setParams(next);
  };
  const setDimension = (d: HeatDimensionShape) => {
    const next = new URLSearchParams(params);
    next.set('dimension', d);
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Insurance Heatmaps"
        subtitle="Portfolio risk concentration across branches, regions and channels. Pick a metric (fraud · lapse · channel · solvency · persistency) and a dimension; tiles are worst-first heat-coded."
      />

      {/* Metric selector */}
      <div className="flex flex-wrap items-center gap-2" data-testid="ih-metric-selector">
        <span className="text-xs font-medium uppercase text-ink-subtle">Metric:</span>
        {catalog?.metrics.map((m) => (
          <button
            key={m.metric}
            type="button"
            aria-pressed={metric === m.metric}
            onClick={() => setMetric(m.metric)}
            data-testid={`ih-metric-${m.metric}`}
            title={m.description}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              metric === m.metric ? 'border-action bg-action/10 text-action' : 'border-divider text-ink-subtle hover:text-ink'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Dimension toggle */}
      <div className="flex items-center gap-2" data-testid="ih-dimension-toggle">
        <span className="text-xs font-medium uppercase text-ink-subtle">View by:</span>
        {ALL_DIMS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={dimension === d}
            onClick={() => setDimension(d)}
            data-testid={`ih-dim-${d}`}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              dimension === d ? 'border-action bg-action/10 text-action' : 'border-divider text-ink-subtle hover:text-ink'
            }`}
          >
            {DIM_LABEL[d]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <MetricCard label={`${DIM_LABEL[dimension]}s`} value={data?.total_cells.toString() ?? '—'} testId="ih-kpi-total" />
        <MetricCard label="Critical heat" value={(data?.by_heat_level.critical ?? 0).toString()} tone="danger" testId="ih-kpi-critical" />
        <MetricCard label="High heat" value={(data?.by_heat_level.high ?? 0).toString()} tone="warning" testId="ih-kpi-high" />
        <MetricCard label="Low heat" value={(data?.by_heat_level.low ?? 0).toString()} tone="success" testId="ih-kpi-low" />
      </div>

      <Panel
        title={metricDef ? `${metricDef.label} — by ${DIM_LABEL[dimension].toLowerCase()}` : 'Heatmap'}
        action={
          data ? (
            <span className="text-xs text-ink-subtle">
              {metricDef?.higher_is_worse === false ? 'lower headline = worse' : 'higher headline = worse'} · generated{' '}
              {new Date(data.generated_at).toLocaleString()}
            </span>
          ) : null
        }
      >
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="ih-grid">
            {data?.cells.map((cell) => (
              <div
                key={cell.id}
                data-testid={`ih-cell-${cell.id}`}
                className={`rounded-lg border p-4 ${HEAT_COLOUR[cell.heat_level] ?? 'border-divider bg-surface'}`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{cell.label}</h3>
                  <Badge tone={HEAT_TONE[cell.heat_level]}>{cell.heat_level.toUpperCase()}</Badge>
                </div>
                {cell.group && <div className="mt-1 text-xs opacity-70">{cell.group}</div>}
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs uppercase opacity-70">Risk score</div>
                    <div className="text-xl font-bold tabular-nums">{cell.risk_score}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase opacity-70">{cell.headline_label}</div>
                    <div className="text-xl font-bold tabular-nums">{fmtHeadline(cell.headline_value, cell.headline_unit)}</div>
                  </div>
                </div>
                <div className="mt-3 border-t border-current/30 pt-2 text-xs opacity-80">
                  {cell.volume.toLocaleString()} policies · 30d Δ {cell.delta_30d_pct >= 0 ? '+' : ''}
                  {cell.delta_30d_pct.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
