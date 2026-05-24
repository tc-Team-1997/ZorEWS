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
import { AlertTriangle, BrainCircuit, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  api,
  type NpaHighRiskRow,
  type NpaPredictionExplanation,
  type NpaBacktestSummary,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';

type Horizon = 30 | 60 | 90 | 180;
const HORIZONS: Horizon[] = [30, 60, 90, 180];

const formatKES = (n: number) =>
  new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n);

function bandTone(band: NpaHighRiskRow['band']): 'danger' | 'warning' {
  return band === 'critical' ? 'danger' : 'warning';
}

export function NpaPredictionPage() {
  const [horizon, setHorizon] = useState<Horizon>(90);
  const [whyOpenId, setWhyOpenId] = useState<string | null>(null);
  const [backtestOpen, setBacktestOpen] = useState(false);

  const { data: list, isLoading } = useQuery({
    queryKey: ['npa.highRisk', horizon],
    queryFn: () => api.npaHighRisk(horizon),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="NPA Prediction"
        subtitle="AI-driven probability of default over 30 / 60 / 90 / 180 day horizons. Every prediction is explainable."
        actions={
          <Button variant="ghost" onClick={() => setBacktestOpen(true)}>
            <Sparkles className="size-4" aria-hidden /> Backtest report
          </Button>
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
    </div>
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
                <div className="grid grid-cols-2 gap-3 text-sm">
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
