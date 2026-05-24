// web/src/modules/dashboard/PortfolioInsightsRow.tsx
//
// G3 — Three-panel dashboard row (Monday Playbook H2 spec).
// Renders below the existing dashboard chrome:
//   1. Sector Risk Heatmap (sector × heat_level matrix from /v1/banking/sectors/heatmap)
//   2. AI Model Confidence card (production PD model AUC + version)
//   3. Data Quality by Source bar (/v1/ingestion/health by_status + attention list)
//
// All three pull existing BFF data — no new BFF routes.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, BrainCircuit, Database } from 'lucide-react';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { api } from '@/lib/api';

const HEAT_TONES: Record<string, string> = {
  critical: 'bg-danger',
  high: 'bg-warning',
  medium: 'bg-warning/60',
  low: 'bg-success',
};

const STATUS_TONES: Record<string, string> = {
  healthy: 'bg-success',
  degraded: 'bg-warning',
  failing: 'bg-danger',
  paused: 'bg-ink/40',
};

function fmtKes(v: number): string {
  if (v >= 10_000_000) return `KES ${(v / 10_000_000).toFixed(1)}cr`;
  if (v >= 100_000) return `KES ${(v / 100_000).toFixed(1)}L`;
  return `KES ${v.toLocaleString()}`;
}

export function PortfolioInsightsRow() {
  const heatmap = useQuery({
    queryKey: ['dashboard.sectorHeatmap'],
    queryFn: api.sectorHeatmap,
  });
  const ingestion = useQuery({
    queryKey: ['dashboard.ingestionHealth'],
    queryFn: api.ingestionHealth,
  });
  const aiPd = useQuery({
    queryKey: ['dashboard.aiModels.pd'],
    queryFn: () => api.aiModels('pd'),
  });

  // Pick production PD model + back-up calc the average across visible
  // models' AUC for the confidence panel.
  const aiSummary = useMemo(() => {
    const items = aiPd.data?.items ?? [];
    const prod = items.find((m) => m.status === 'production');
    const aucs = items
      .map((m) => m.metrics?.auc)
      .filter((v): v is number => typeof v === 'number');
    const avg = aucs.length ? aucs.reduce((a, b) => a + b, 0) / aucs.length : null;
    return { prod, avg };
  }, [aiPd.data]);

  return (
    <div
      className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3"
      data-testid="portfolio-insights-row"
    >
      {/* ── 1. Sector Risk Heatmap ── */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Activity className="size-4 text-action" aria-hidden /> Sector risk heatmap
          </span>
        }
        data-testid="dashboard-sector-heatmap"
      >
        {heatmap.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : heatmap.data ? (
          <div className="space-y-2">
            <div className="flex gap-1 text-2xs">
              {(['critical', 'high', 'medium', 'low'] as const).map((k) => (
                <span key={k} data-testid={`heatmap-bucket-${k}`}>
                  <Badge
                    tone={
                      k === 'critical' ? 'danger' : k === 'high' ? 'warning' : k === 'medium' ? 'warning' : 'success'
                    }
                  >
                    {k}: {heatmap.data.by_heat_level[k] ?? 0}
                  </Badge>
                </span>
              ))}
            </div>
            <ul className="space-y-1.5" data-testid="heatmap-cells">
              {heatmap.data.cells.slice(0, 6).map((c) => {
                const widthPct = Math.min(100, Math.round(c.npa_ratio_pct * 8));
                return (
                  <li
                    key={c.sector}
                    className="grid grid-cols-[1fr_auto] items-center gap-2 text-xs"
                    data-testid={`heatmap-cell-${c.sector}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-ink truncate">{c.sector.replace(/_/g, ' ')}</span>
                        <span className="tabular-nums text-muted">{c.npa_ratio_pct.toFixed(2)}%</span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-divider/40">
                        <div className={`h-full ${HEAT_TONES[c.heat_level] ?? 'bg-action'}`} style={{ width: `${widthPct}%` }} />
                      </div>
                    </div>
                    <Badge
                      tone={
                        c.heat_level === 'critical'
                          ? 'danger'
                          : c.heat_level === 'high'
                            ? 'warning'
                            : c.heat_level === 'medium'
                              ? 'warning'
                              : 'success'
                      }
                    >
                      {c.heat_level}
                    </Badge>
                  </li>
                );
              })}
            </ul>
            <p className="pt-1 text-2xs text-muted">
              Top {Math.min(6, heatmap.data.cells.length)} of {heatmap.data.total_sectors} sectors · sorted by heat
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">Failed to load sectors.</p>
        )}
      </Panel>

      {/* ── 2. AI Model Confidence ── */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <BrainCircuit className="size-4 text-action" aria-hidden /> AI confidence — PD model
          </span>
        }
        data-testid="dashboard-ai-confidence"
      >
        {aiPd.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : aiSummary.prod ? (
          <div className="space-y-3">
            <MetricCard
              label="Production AUC"
              value={
                aiSummary.prod.metrics?.auc
                  ? aiSummary.prod.metrics.auc.toFixed(3)
                  : '—'
              }
              sub={`${aiSummary.prod.model_id} v${aiSummary.prod.version}`}
              tone={
                aiSummary.prod.metrics?.auc && aiSummary.prod.metrics.auc >= 0.78
                  ? 'success'
                  : 'warning'
              }
              testId="ai-confidence-auc"
            />
            <div className="rounded-md border border-divider bg-surface p-2.5 text-xs">
              <p className="text-muted">Pool average AUC across {aiPd.data?.total ?? 0} versions</p>
              <p className="font-medium tabular-nums text-ink">
                {aiSummary.avg ? aiSummary.avg.toFixed(3) : '—'}
              </p>
            </div>
            <p className="text-2xs text-muted">
              SLO target ≥ 0.78. Current production model: {aiSummary.prod.framework ?? 'xgboost'} ·{' '}
              <span className={aiSummary.prod.metrics?.auc && aiSummary.prod.metrics.auc >= 0.78 ? 'text-success' : 'text-warning'}>
                {aiSummary.prod.metrics?.auc && aiSummary.prod.metrics.auc >= 0.78 ? 'within SLA' : 'below SLA'}
              </span>
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">No production PD model deployed.</p>
        )}
      </Panel>

      {/* ── 3. Data Quality by Source ── */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Database className="size-4 text-action" aria-hidden /> Data quality — connector fleet
          </span>
        }
        data-testid="dashboard-dq-by-source"
      >
        {ingestion.isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : ingestion.data ? (
          <div className="space-y-2.5">
            <div className="grid grid-cols-4 gap-2 text-2xs">
              {(['healthy', 'degraded', 'failing', 'paused'] as const).map((s) => (
                <div
                  key={s}
                  className="rounded-md border border-divider bg-surface px-2 py-1.5 text-center"
                  data-testid={`dq-status-${s}`}
                >
                  <div className={`mx-auto mb-1 h-1 w-8 rounded-full ${STATUS_TONES[s]}`} />
                  <p className="font-medium tabular-nums text-ink">{ingestion.data.by_status[s] ?? 0}</p>
                  <p className="capitalize text-muted">{s}</p>
                </div>
              ))}
            </div>

            <div className="rounded-md border border-divider bg-surface p-2.5 text-xs">
              <p className="text-muted">Total connectors</p>
              <p className="font-medium tabular-nums text-ink">{ingestion.data.total_connectors}</p>
              <p className="mt-0.5 text-2xs text-muted">Last-run records · {fmtKes(ingestion.data.fleet_records_last_run)}</p>
            </div>

            {ingestion.data.attention_required.length > 0 && (
              <ul className="space-y-1 text-2xs" data-testid="dq-attention-list">
                {ingestion.data.attention_required.slice(0, 3).map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between rounded border border-warning/30 bg-warning/5 px-2 py-1"
                  >
                    <span className="font-medium text-ink truncate">{c.name}</span>
                    <Badge tone={c.status === 'failing' ? 'danger' : 'warning'}>{c.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">Failed to load ingestion health.</p>
        )}
      </Panel>
    </div>
  );
}
