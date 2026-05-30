// web/src/modules/ai/governance/AiPerformanceTrackingPage.tsx
//
// AI Governance → Model Performance Tracking.
//
// Per-model + per-metric trend lines over the M7.5 performance ledger.
// Composes M7.8 trend (least-squares slope) + M7.7 outlier detection
// (z-score over the same ledger) into a single signal-rich view.
//
// Picks a model from the registry, picks a metric (auc / precision /
// recall / f1 / drift_score), renders a line chart with annotated
// outliers and a slope-based regression verdict ("improving" /
// "declining" / "flat").
//
// Production swap: when the M7.5 ledger swaps from in-memory to
// pg-backed, this page is untouched — same /v1/ai/models/:id/performance/*
// contract.

import { Navigate } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, AlertTriangle } from 'lucide-react';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { api } from '@/lib/api';
import { http } from '@/lib/http';

type MetricName = 'auc' | 'precision' | 'recall' | 'f1' | 'drift_score';

const METRICS: readonly MetricName[] = ['auc', 'precision', 'recall', 'f1', 'drift_score'] as const;

interface PerformanceEntry {
  entry_id: string;
  metric: MetricName;
  value: number;
  recorded_at: string;
  observed_at: string;
  recorded_by: string;
}
interface PerformanceListShape {
  items?: PerformanceEntry[];
}
interface PerformanceTrendShape {
  metric: MetricName;
  sample_size: number;
  mean: number | null;
  first_value: number | null;
  first_at: string | null;
  last_value: number | null;
  last_at: string | null;
  abs_change: number | null;
  abs_change_pct: number | null;
  slope_per_day: number | null;
}
interface PerformanceOutlierEntry {
  entry_id: string;
  recorded_at: string;
  value: number;
  z_score: number;
  direction: 'high' | 'low';
}
interface PerformanceOutliersShape {
  metric: MetricName;
  outliers?: PerformanceOutlierEntry[];
  mean: number | null;
  std_dev: number | null;
}

function slopeVerdict(slope: number | null): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; icon: typeof TrendingUp } {
  if (slope === null) return { label: 'Insufficient data', tone: 'neutral', icon: Minus };
  if (slope > 0.0005) return { label: 'Improving', tone: 'success', icon: TrendingUp };
  if (slope < -0.0005) return { label: 'Declining', tone: 'danger', icon: TrendingDown };
  return { label: 'Flat', tone: 'neutral', icon: Minus };
}

export function AiPerformanceTrackingPage() {
  const me = useAuth((s) => s.user);
  const [modelId, setModelId] = useState('');
  const [metric, setMetric] = useState<MetricName>('auc');

  if (me && !me.roles.some((r) => r === 'admin' || r === 'supervisor' || r === 'risk_analyst')) {
    return <Navigate to="/" replace />;
  }

  const modelsQ = useQuery({
    queryKey: ['ai-perf-models'],
    queryFn: () => api.aiModels(),
    staleTime: 60_000,
  });

  // Auto-select first non-retired model.
  const firstId = modelsQ.data?.items.find((m) => m.status !== 'retired')?.model_id ?? '';
  const effectiveId = modelId || firstId;

  const listQ = useQuery({
    queryKey: ['ai-perf-list', effectiveId, metric],
    queryFn: () =>
      http
        .get<{ items?: PerformanceEntry[] } | { body: { items?: PerformanceEntry[] } }>(
          `/v1/ai/models/${encodeURIComponent(effectiveId)}/performance?metric=${metric}`,
        )
        .then((r) => {
          const d = r.data as PerformanceListShape & { body?: PerformanceListShape };
          return d.body ?? d;
        }),
    enabled: !!effectiveId,
    placeholderData: (prev) => prev,
  });

  const trendQ = useQuery({
    queryKey: ['ai-perf-trend', effectiveId, metric],
    queryFn: () =>
      http
        .get<PerformanceTrendShape | { body: PerformanceTrendShape }>(
          `/v1/ai/models/${encodeURIComponent(effectiveId)}/performance/trend?metric=${metric}`,
        )
        .then((r) => {
          const d = r.data as PerformanceTrendShape & { body?: PerformanceTrendShape };
          return d.body ?? d;
        }),
    enabled: !!effectiveId,
    placeholderData: (prev) => prev,
  });

  const outliersQ = useQuery({
    queryKey: ['ai-perf-outliers', effectiveId, metric],
    queryFn: () =>
      http
        .get<PerformanceOutliersShape | { body: PerformanceOutliersShape }>(
          `/v1/ai/models/${encodeURIComponent(effectiveId)}/performance/outliers?metric=${metric}&z=2`,
        )
        .then((r) => {
          const d = r.data as PerformanceOutliersShape & { body?: PerformanceOutliersShape };
          return d.body ?? d;
        }),
    enabled: !!effectiveId,
    placeholderData: (prev) => prev,
  });

  const series = useMemo(() => {
    const items = listQ.data?.items ?? [];
    return [...items]
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))
      .map((e) => ({
        recorded_at: e.recorded_at,
        ts: new Date(e.recorded_at).getTime(),
        value: e.value,
        entry_id: e.entry_id,
      }));
  }, [listQ.data]);

  const trend = trendQ.data ?? null;
  const verdict = slopeVerdict(trend?.slope_per_day ?? null);
  const outliers = outliersQ.data?.outliers ?? [];

  return (
    <div data-testid="ai-performance-page">
      <PageHeader
        title="Model Performance Tracking"
        subtitle="Per-model performance ledger with trend + outlier detection. Picks up the M7.5 / M7.7 / M7.8 BFF surface unchanged."
      />

      <Panel className="mb-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-muted">Model</span>
            <select
              value={effectiveId}
              onChange={(e) => setModelId(e.target.value)}
              className="input"
              data-testid="ai-perf-model"
            >
              <option value="">— pick a model —</option>
              {(modelsQ.data?.items ?? []).map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {(m.name ?? m.model_id)} (v{m.version} · {m.status})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-muted">Metric</span>
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as MetricName)}
              className="input"
              data-testid="ai-perf-metric"
            >
              {METRICS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4" data-testid="ai-perf-kpis">
        <MetricCard
          label="Sample size"
          value={(trend?.sample_size ?? 0).toString()}
          testId="ai-perf-kpi-samples"
        />
        <MetricCard
          label="Mean"
          value={trend?.mean !== null && trend?.mean !== undefined ? trend.mean.toFixed(3) : '—'}
          testId="ai-perf-kpi-mean"
        />
        <MetricCard
          label="First"
          value={trend?.first_value !== null && trend?.first_value !== undefined ? trend.first_value.toFixed(3) : '—'}
          testId="ai-perf-kpi-first"
        />
        <MetricCard
          label="Last"
          value={trend?.last_value !== null && trend?.last_value !== undefined ? trend.last_value.toFixed(3) : '—'}
          testId="ai-perf-kpi-last"
        />
        <MetricCard
          label="Slope / day"
          value={trend?.slope_per_day !== null && trend?.slope_per_day !== undefined ? trend.slope_per_day.toExponential(2) : '—'}
          testId="ai-perf-kpi-slope"
        />
      </div>

      <Panel className="mb-4" data-testid="ai-perf-verdict-panel">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 text-sm text-ink">
            <verdict.icon size={16} className="text-action" />
            <span>Slope verdict: <Badge tone={verdict.tone}>{verdict.label}</Badge></span>
          </div>
          {outliers.length > 0 && (
            <div className="text-[12px] text-muted flex items-center gap-1.5" data-testid="ai-perf-outlier-count">
              <AlertTriangle size={13} className="text-warning" />
              {outliers.length} outlier{outliers.length === 1 ? '' : 's'} detected (|z| &gt; 2)
            </div>
          )}
        </div>
      </Panel>

      <Panel title={`${metric} over time`}>
        {series.length === 0 ? (
          <p className="text-sm text-muted">No performance entries recorded for this model + metric.</p>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={series} margin={{ top: 8, right: 12, bottom: 8, left: 12 }}>
              <CartesianGrid stroke="#E4E7F2" strokeDasharray="3 3" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) => new Date(t).toISOString().slice(0, 10)}
                tick={{ fontSize: 10 }}
              />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} />
              <Tooltip
                formatter={(v: number) => v.toFixed(4)}
                labelFormatter={(t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')}
              />
              <Line type="monotone" dataKey="value" stroke="#6366F1" strokeWidth={2} dot={{ r: 2 }} />
              {outliers.map((o) => {
                const point = series.find((s) => s.entry_id === o.entry_id);
                if (!point) return null;
                return (
                  <ReferenceDot
                    key={o.entry_id}
                    x={point.ts}
                    y={point.value}
                    r={5}
                    fill={o.direction === 'high' ? '#10B981' : '#EF4444'}
                    stroke="white"
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Panel>
    </div>
  );
}

export { METRICS, slopeVerdict };
