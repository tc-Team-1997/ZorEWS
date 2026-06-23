// web/src/modules/banking/NpaPredictionPage.tsx
//
// NPA Prediction list + per-prediction "Why" modal + Backtest summary.
// Closes the Act 4 (3 minutes) flow in ZorEWS_Demo_Script.md.
//
// Backend: /v1/banking/npa/high-risk + /v1/banking/npa/predictions/:id/why
//          + /v1/banking/npa/backtest/latest

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { AlertTriangle, BrainCircuit, Cpu, Database, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  api,
  type NpaHighRiskRow,
  type NpaPredictionExplanation,
  type NpaBacktestSummary,
  type PortfolioDriverReport,
  type AiModelDetailShape,
  type LineageDatasetShape,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { useAuth } from '@/store/auth';
import { buildNpaPredictionReportData } from './npaPredictionReportAdapter';
import { color } from '@/styles/tokens';

type Horizon = 30 | 60 | 90 | 180;
const HORIZONS: Horizon[] = [30, 60, 90, 180];

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

function bandTone(band: NpaHighRiskRow['band']): 'danger' | 'warning' {
  return band === 'critical' ? 'danger' : 'warning';
}

export function NpaPredictionPage() {
  const me = useAuth((s) => s.user);
  const [horizon, setHorizon] = useState<Horizon>(90);
  const [whyOpenId, setWhyOpenId] = useState<string | null>(null);
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [manageModelOpen, setManageModelOpen] = useState(false);
  const [lineageOpen, setLineageOpen] = useState(false);

  const { data: list, isLoading } = useQuery({
    queryKey: ['npa.highRisk', horizon],
    queryFn: () => api.npaHighRisk(horizon),
  });

  const { data: drivers } = useQuery({
    queryKey: ['npa.portfolioDrivers', horizon],
    queryFn: () => api.npaPortfolioDrivers(horizon),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="NPA Prediction"
        subtitle="AI-driven probability of default over 30 / 60 / 90 / 180 day horizons. Every prediction is explainable."
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setBacktestOpen(true)} data-testid="npa-open-backtest">
              <Sparkles className="size-4" aria-hidden /> Backtest report
            </Button>
            <Button variant="ghost" onClick={() => setManageModelOpen(true)} data-testid="npa-open-manage-model">
              <Cpu className="size-4" aria-hidden /> Manage model
            </Button>
            <Button variant="ghost" onClick={() => setLineageOpen(true)} data-testid="npa-open-lineage">
              <Database className="size-4" aria-hidden /> Data lineage
            </Button>
            {/* Enterprise export (P2) — RBAC-gated; renders null without
                reports:export. Reports the high-risk rows for the active
                horizon + the exposure KPI strip. */}
            <ExportButton
              module="npa_prediction"
              reportType="risk"
              adapter={(config) =>
                buildNpaPredictionReportData(
                  {
                    horizon,
                    summary: {
                      total_high_risk: list?.total_high_risk ?? 0,
                      total_critical: list?.total_critical ?? 0,
                      total_exposure_kes: list?.total_exposure_kes ?? 0,
                    },
                    rows: list?.rows ?? [],
                    meta: { tenant_id: 'BANK_DEMO', generated_by: me?.username ?? 'operator', role: me?.roles?.[0] ?? 'admin' },
                  },
                  config,
                )
              }
            />
          </div>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MetricCard
          label="Total high-risk accounts"
          value={list ? list.total_high_risk.toString() : '—'}
          sub={`Horizon: ${horizon} days`}
          testId="kpi-npa-total"
        />
        <MetricCard
          label="Critical (PD ≥ 0.85)"
          value={list ? list.total_critical.toString() : '—'}
          sub="Immediate action required"
          tone="danger"
          testId="kpi-npa-critical"
        />
        <MetricCard
          label="Total exposure at risk"
          value={list ? formatKES(list.total_exposure_kes) : '—'}
          sub="Sum across high-risk accounts"
          testId="kpi-npa-exposure"
        />
      </div>

      {/* Portfolio drivers (M7.19) */}
      {drivers && <PortfolioDriversPanel report={drivers} />}

      {/* Horizon selector */}
      <Panel title="Horizon">
        <div className="flex gap-2">
          {HORIZONS.map((h) => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                horizon === h
                  ? 'border border-action bg-action/10 text-action'
                  : 'border border-divider bg-surface text-ink hover:border-action/40'
              }`}
              data-testid={`horizon-${h}`}
            >
              {h} days
            </button>
          ))}
        </div>
      </Panel>

      {/* List */}
      <Panel title={`High-risk accounts (${list?.total_high_risk ?? 0})`}>
        {isLoading ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-ink-subtle">
                <tr>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Sector</th>
                  <th className="px-3 py-2 text-right">PD</th>
                  <th className="px-3 py-2">Band</th>
                  <th className="px-3 py-2 text-right">DPD</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {list?.rows.slice(0, 50).map((row) => (
                  <tr
                    key={row.prediction_id}
                    className="cursor-pointer border-t border-divider hover:bg-action/5"
                    onClick={() => setWhyOpenId(row.prediction_id)}
                    data-testid={`npa-row-${row.customer_id}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink">{row.customer_name}</div>
                      <div className="text-xs text-ink-subtle">{row.customer_id}</div>
                    </td>
                    <td className="px-3 py-2 text-ink-subtle">{row.sector.replace(/_/g, ' ')}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{row.pd.toFixed(3)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={bandTone(row.band)}>{row.band}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.current_dpd}d</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatKES(row.outstanding_kes)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        className="rounded-md border border-divider bg-surface px-2 py-1 text-xs text-action hover:border-action/40"
                        onClick={(e) => {
                          e.stopPropagation();
                          setWhyOpenId(row.prediction_id);
                        }}
                      >
                        Why?
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list && list.rows.length === 0 && (
              <p className="py-6 text-center text-sm text-ink-subtle">No high-risk accounts in this horizon.</p>
            )}
          </div>
        )}
      </Panel>

      {/* "Why" modal */}
      {whyOpenId && <NpaWhyModal predictionId={whyOpenId} onClose={() => setWhyOpenId(null)} />}

      {/* Backtest modal */}
      {backtestOpen && <BacktestModal onClose={() => setBacktestOpen(false)} />}

      {/* M2.5 — Manage Model modal (resolves model_id from /backtest/latest) */}
      {manageModelOpen && <ManageModelModal onClose={() => setManageModelOpen(false)} />}

      {/* M2.5 — Data Lineage modal */}
      {lineageOpen && (
        <DataLineageModal datasetId="mart.npa_predictions" onClose={() => setLineageOpen(false)} />
      )}
    </div>
  );
}

// ─── M2.5 — Manage Model modal ─────────────────────────────────────────
//
// Renders the active NPA model record from /v1/ai/models/:id (M7.1). The
// "Jump to Model Registry" link points operators at the admin model surface
// when present; otherwise the inline detail is enough for the credit
// committee's read-only review.

function ManageModelModal({ onClose }: { onClose: () => void }) {
  // Resolve the active NPA model id via the backtest payload (which carries
  // model_id + version). Then look up the M7.1 registry detail. Two queries
  // chained — the second is `enabled` on `modelId` so it doesn't fire until
  // we know what to fetch.
  const backtestQ = useQuery({
    queryKey: ['npa.backtest-for-model'],
    queryFn: () => api.npaBacktest(),
  });
  const modelId = backtestQ.data?.model_id ?? '';
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['npa.manage-model', modelId],
    queryFn: () => api.aiModelById(modelId) as Promise<AiModelDetailShape>,
    enabled: modelId.length > 0,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="bg-surface rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        data-testid="npa-manage-model-modal"
      >
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Cpu className="h-4 w-4" /> Manage model — {modelId || '…'}
            </h3>
            <div className="text-xs text-ink-subtle">
              Active NPA prediction model {modelId ? `· /v1/ai/models/${modelId}` : '· resolving…'}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="npa-manage-model-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          {(backtestQ.isLoading || isLoading) && (
            <div className="text-sm text-ink-subtle">Loading model registry…</div>
          )}
          {isError && (
            <div className="text-sm text-danger" data-testid="npa-manage-model-error">
              Model not found in registry ({modelId}): {(error as Error).message ?? 'unknown error'}
            </div>
          )}
          {data && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-ink-subtle">Name</div>
                  <div className="font-medium">{data.name}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-subtle">Version</div>
                  <div className="font-mono">{data.version}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-subtle">Status</div>
                  <Badge tone={data.status === 'production' ? 'success' : data.status === 'retired' ? 'danger' : 'warning'}>
                    {data.status}
                  </Badge>
                </div>
                <div>
                  <div className="text-xs text-ink-subtle">Framework</div>
                  <div>{data.framework}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-subtle">Trained at</div>
                  <div className="font-mono text-xs">{new Date(data.trained_at).toLocaleDateString()}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-subtle">Deployed at</div>
                  <div className="font-mono text-xs">
                    {data.deployed_at ? new Date(data.deployed_at).toLocaleDateString() : '—'}
                  </div>
                </div>
              </div>

              {data.metrics && (
                <div>
                  <div className="text-xs text-ink-subtle mb-1">Performance metrics</div>
                  <div className="rounded border border-divider p-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                    {data.metrics.auc !== undefined && (
                      <div>
                        <div className="text-xs text-ink-subtle">AUC</div>
                        <div className="font-mono">{data.metrics.auc.toFixed(3)}</div>
                      </div>
                    )}
                    {data.metrics.mae !== undefined && (
                      <div>
                        <div className="text-xs text-ink-subtle">MAE</div>
                        <div className="font-mono">{data.metrics.mae.toFixed(2)}</div>
                      </div>
                    )}
                    {data.metrics.training_rows !== undefined && (
                      <div>
                        <div className="text-xs text-ink-subtle">Training rows</div>
                        <div className="font-mono">{data.metrics.training_rows.toLocaleString()}</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {data.key_features && data.key_features.length > 0 && (
                <div>
                  <div className="text-xs text-ink-subtle mb-1">Key features</div>
                  <div className="flex flex-wrap gap-1">
                    {data.key_features.map((f) => (
                      <span
                        key={f}
                        className="text-xs px-2 py-0.5 rounded bg-surface-2 border border-divider"
                      >
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── M2.5 — Data Lineage modal ─────────────────────────────────────────
//
// Renders the raw → mart → predictions chain via /v1/metadata/lineage
// (M14.x metadata). Operators inspecting an NPA prediction can trace the
// source datasets that fed it.

function DataLineageModal({ datasetId, onClose }: { datasetId: string; onClose: () => void }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['npa.lineage', datasetId],
    queryFn: () => api.metadataLineageDataset(datasetId) as Promise<LineageDatasetShape>,
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="bg-surface rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-y-auto"
        data-testid="npa-lineage-modal"
      >
        <div className="sticky top-0 bg-surface border-b border-divider px-4 py-3 flex items-center justify-between">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <Database className="h-4 w-4" /> Data lineage — {datasetId}
            </h3>
            <div className="text-xs text-ink-subtle">Raw feed → mart → prediction chain</div>
          </div>
          <button onClick={onClose} aria-label="Close" data-testid="npa-lineage-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          {isLoading && <div className="text-sm text-ink-subtle">Loading lineage…</div>}
          {isError && (
            <div className="text-sm text-danger" data-testid="npa-lineage-error">
              Lineage not available: {(error as Error).message ?? 'unknown error'}
            </div>
          )}
          {data && (
            <div className="space-y-4 text-sm">
              <div className="rounded border border-divider p-3">
                <div className="font-medium">{data.name}</div>
                {data.description && (
                  <div className="text-xs text-ink-subtle mt-1">{data.description}</div>
                )}
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs">
                  {data.owner && (
                    <div>
                      <span className="text-ink-subtle">Owner:</span> {data.owner}
                    </div>
                  )}
                  {data.source_system && (
                    <div>
                      <span className="text-ink-subtle">Source:</span> {data.source_system}
                    </div>
                  )}
                  {data.pii !== undefined && (
                    <div>
                      <span className="text-ink-subtle">PII:</span> {data.pii ? 'yes' : 'no'}
                    </div>
                  )}
                </div>
              </div>

              {data.upstream_dataset_ids && data.upstream_dataset_ids.length > 0 && (
                <div>
                  <div className="text-xs text-ink-subtle mb-1">Upstream feeds</div>
                  <ul className="space-y-1" data-testid="npa-lineage-upstream">
                    {data.upstream_dataset_ids.map((id) => (
                      <li key={id} className="rounded border border-divider px-2 py-1 font-mono text-xs">
                        {id}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.downstream_dataset_ids && data.downstream_dataset_ids.length > 0 && (
                <div>
                  <div className="text-xs text-ink-subtle mb-1">Downstream consumers</div>
                  <ul className="space-y-1" data-testid="npa-lineage-downstream">
                    {data.downstream_dataset_ids.map((id) => (
                      <li key={id} className="rounded border border-divider px-2 py-1 font-mono text-xs">
                        {id}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {data.tags && data.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {data.tags.map((t) => (
                    <span key={t} className="text-xs px-2 py-0.5 rounded bg-surface-2 border border-divider">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// M7.19 — Portfolio Drivers panel

function humaniseFeature(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function driverTone(row: { direction_split: { up: number; down: number } }): 'danger' | 'success' | 'warning' {
  if (row.direction_split.up > row.direction_split.down) return 'danger';
  if (row.direction_split.down > row.direction_split.up) return 'success';
  return 'warning';
}

function PortfolioDriversPanel({ report }: { report: PortfolioDriverReport }) {
  const top = report.drivers.slice(0, 5);
  const total = report.total_predictions_analyzed;

  if (total === 0 || top.length === 0) {
    return (
      <Panel title="Portfolio drivers — what's pushing risk across the portfolio?">
        <p className="py-4 text-sm text-ink-subtle">No high-risk predictions to aggregate at this horizon.</p>
      </Panel>
    );
  }

  const maxContribution = Math.max(...top.map((d) => d.total_contribution)) || 1;

  return (
    <Panel
      title={`Portfolio drivers — across ${total} high-risk accounts (${report.horizon_days}d horizon)`}
      data-testid="portfolio-drivers-panel"
    >
      <div className="space-y-3">
        {report.most_universal_driver && (
          <div className="flex items-center gap-2 rounded-md border border-action/30 bg-action/5 px-3 py-2 text-sm">
            <Sparkles className="size-4 text-action" aria-hidden />
            <span className="text-ink">
              <span className="font-medium">Most universal:</span>{' '}
              <span className="font-semibold text-action">
                {humaniseFeature(report.most_universal_driver.feature_name)}
              </span>{' '}
              <span className="text-ink-subtle">
                — affects {report.most_universal_driver.affected_predictions}/{total} predictions
              </span>
            </span>
          </div>
        )}

        <div className="space-y-2" data-testid="portfolio-drivers-list">
          {top.map((d) => {
            const widthPct = Math.round((d.total_contribution / maxContribution) * 100);
            const tone = driverTone(d);
            const barClass =
              tone === 'danger' ? 'bg-danger' : tone === 'success' ? 'bg-success' : 'bg-warning';
            const directionLabel =
              d.direction_split.up > d.direction_split.down
                ? `${d.direction_split.up} raising`
                : d.direction_split.down > d.direction_split.up
                  ? `${d.direction_split.down} protective`
                  : `${d.direction_split.up} raising / ${d.direction_split.down} protective`;
            return (
              <div
                key={d.feature_name}
                className="rounded-md border border-divider bg-surface p-3"
                data-testid={`portfolio-driver-${d.feature_name}`}
              >
                <div className="flex items-center justify-between gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{humaniseFeature(d.feature_name)}</span>
                    <Badge tone={tone}>{directionLabel}</Badge>
                  </div>
                  <div className="tabular-nums text-ink-subtle">
                    <span className="font-semibold text-ink">{(d.pct_of_total * 100).toFixed(1)}%</span>{' '}
                    <span className="text-xs">of portfolio weight</span>
                  </div>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-divider/30">
                  <div className={`h-full ${barClass}`} style={{ width: `${widthPct}%` }} />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-xs text-ink-subtle">
                  <span>
                    Appears in {d.affected_predictions}/{total} predictions
                  </span>
                  <span className="tabular-nums">avg weight {d.avg_weight >= 0 ? '+' : ''}{d.avg_weight.toFixed(2)}</span>
                </div>
              </div>
            );
          })}
        </div>

        {report.total_drivers > top.length && (
          <p className="pt-1 text-xs text-ink-subtle">
            Showing top {top.length} of {report.total_drivers} drivers. SHAP-style attribution aggregated across the cohort.
          </p>
        )}
      </div>
    </Panel>
  );
}

// ──────────────────────────────────────────────────────────────────────

function NpaWhyModal({ predictionId, onClose }: { predictionId: string; onClose: () => void }) {
  const { data: explanation } = useQuery({
    queryKey: ['npa.why', predictionId],
    queryFn: () => api.npaWhy(predictionId),
  });

  const body: NpaPredictionExplanation | undefined = explanation;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid="npa-why-modal"
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-6 py-4">
          <div className="flex items-center gap-2">
            <BrainCircuit className="size-5 text-action" aria-hidden />
            <h2 className="text-lg font-semibold">Why this prediction?</h2>
          </div>
          <button className="rounded p-1 hover:bg-divider/50" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-5 px-6 py-5">
          {body ? (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label="PD" value={body.pd.toFixed(3)} sub={`Band: ${body.band}`} testId="why-pd" />
                <MetricCard label="Model" value={body.model_id} sub={`v${body.model_version}`} />
                <MetricCard label="Customer" value={body.customer_id} />
                <MetricCard label="Account" value={body.account_id.slice(0, 20)} />
              </div>

              <Panel title="Top 5 contributing factors">
                <div className="space-y-2" data-testid="why-features">
                  {body.top_features.map((f) => {
                    const maxAbs = Math.max(...body.top_features.map((x) => Math.abs(x.weight))) || 1;
                    const widthPct = Math.round((Math.abs(f.weight) / maxAbs) * 100);
                    const isUp = f.direction === 'up';
                    return (
                      <div key={f.feature_name} className="rounded-md border border-divider bg-surface p-3">
                        <div className="flex items-center justify-between text-sm">
                          <div className="font-medium text-ink">{f.feature_name.replace(/_/g, ' ')}</div>
                          <div className={`tabular-nums font-semibold ${isUp ? 'text-danger' : 'text-success'}`}>
                            {f.weight >= 0 ? '+' : ''}{f.weight.toFixed(2)}
                          </div>
                        </div>
                        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-divider/30">
                          <div
                            className={`h-full ${isUp ? 'bg-danger' : 'bg-success'}`}
                            style={{ width: `${widthPct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Panel>

              <Panel title="What would change this?">
                <div className="rounded-md border border-action/30 bg-action/5 p-4 text-sm">
                  <p className="font-medium text-action">Recommended actions</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-ink">
                    {body.recommended_actions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              </Panel>

              <Panel title="Comparable customers (historical outcomes)">
                <div className="space-y-1.5 text-sm">
                  {body.comparable_customers.map((c) => (
                    <div key={c.customer_id} className="flex justify-between rounded border border-divider px-3 py-1.5">
                      <Link to={`/customers/${c.customer_id}`} className="font-medium text-action hover:underline">
                        {c.customer_id}
                      </Link>
                      <span className="text-ink-subtle">PD {c.pd.toFixed(2)}</span>
                      <Badge tone={c.outcome === 'npa' ? 'danger' : c.outcome === 'cured' ? 'success' : 'warning'}>
                        {c.outcome}
                      </Badge>
                    </div>
                  ))}
                </div>
              </Panel>

              <p className="text-xs text-ink-subtle">
                Generated at {new Date(body.generated_at).toLocaleString()}. SHAP-style feature attribution.
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-subtle">Loading explanation…</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────

function BacktestModal({ onClose }: { onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['npa.backtest'], queryFn: () => api.npaBacktest() });
  const body: NpaBacktestSummary | undefined = data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
      data-testid="npa-backtest-modal"
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-divider px-6 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-5 text-action" aria-hidden />
            <h2 className="text-lg font-semibold">Latest backtest</h2>
          </div>
          <button className="rounded p-1 hover:bg-divider/50" onClick={onClose} aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="space-y-4 px-6 py-5">
          {body ? (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label="AUC" value={body.auc.toFixed(3)} sub="Top-decile discrimination" />
                <MetricCard label="KS" value={body.ks.toFixed(3)} />
                <MetricCard
                  label="Precision @top 10%"
                  value={`${(body.precision_at_top_decile * 100).toFixed(1)}%`}
                />
                <MetricCard label="Recall @top 10%" value={`${(body.recall_at_top_decile * 100).toFixed(1)}%`} />
              </div>

              <Panel title="Confusion matrix">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div className="rounded border border-success/30 bg-success/5 p-3">
                    <div className="text-xs text-ink-subtle">True Positive</div>
                    <div className="text-2xl font-semibold tabular-nums">{body.confusion.tp.toLocaleString()}</div>
                  </div>
                  <div className="rounded border border-warning/30 bg-warning/5 p-3">
                    <div className="text-xs text-ink-subtle">False Positive</div>
                    <div className="text-2xl font-semibold tabular-nums">{body.confusion.fp.toLocaleString()}</div>
                  </div>
                  <div className="rounded border border-danger/30 bg-danger/5 p-3">
                    <div className="text-xs text-ink-subtle">False Negative</div>
                    <div className="text-2xl font-semibold tabular-nums">{body.confusion.fn.toLocaleString()}</div>
                  </div>
                  <div className="rounded border border-divider bg-surface p-3">
                    <div className="text-xs text-ink-subtle">True Negative</div>
                    <div className="text-2xl font-semibold tabular-nums">{body.confusion.tn.toLocaleString()}</div>
                  </div>
                </div>
              </Panel>

              <Panel title="By segment (AUC)">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={body.by_segment}>
                    <XAxis dataKey="segment" stroke={color.ink} fontSize={11} />
                    <YAxis stroke={color.ink} fontSize={11} domain={[0.5, 1]} />
                    <Tooltip />
                    <Bar dataKey="auc" fill={color.blue}>
                      {body.by_segment.map((_e, i) => (
                        <Cell key={i} fill={color.blue} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </Panel>

              <p className="text-xs text-ink-subtle">
                Model: {body.model_id} v{body.model_version} · Cohort: {body.cohort_size.toLocaleString()} ·
                Back to {body.back_to}
              </p>
            </>
          ) : (
            <p className="text-sm text-ink-subtle">Loading backtest…</p>
          )}
          <div className="border-t border-divider pt-3 text-sm text-ink-subtle">
            <AlertTriangle className="mr-2 inline size-4 text-warning" aria-hidden />
            All predictions retained 24 months for audit replay.
          </div>
        </div>
      </div>
    </div>
  );
}
