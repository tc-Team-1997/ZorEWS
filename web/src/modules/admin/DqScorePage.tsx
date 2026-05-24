// web/src/modules/admin/DqScorePage.tsx
//
// Module 1.7 — Data Quality Score.
//
// Spec deliverables:
//   - DQ by Source bar chart with dimension breakdown
//   - Trend over time line chart per source
//   - Per-attribute drill table
//   - DQ rule execution log
//   - Export DQ report (CSV)
//
// Wired to:
//   GET /v1/dq/dashboard      → score_overlay carries the per-source composite
//   GET /v1/dq/by-source/:id  → single source detail + trend
//   GET /v1/dq/by-attribute   → per-attribute breakdown
//   GET /v1/dq/executions     → recent rule executions
//
// Weights are configurable in M13.1 admin config under
// `scoring.dq.dimension_weights` — the page shows the current weights
// in the header chip so operators see what's in effect.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, LineChart, Line, CartesianGrid,
} from 'recharts';
import { Database, Download, FileBarChart, TrendingUp } from 'lucide-react';
import {
  api,
  type DqScoreSource,
  type DqDimension,
} from '@/lib/api';
import { Badge, Button, MetricCard, Panel, type BadgeTone } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';

const DIMENSIONS: DqDimension[] = ['completeness', 'validity', 'consistency', 'uniqueness', 'timeliness'];
const KNOWN_SOURCES: DqScoreSource[] = [
  'cbs_loans', 'cbs_repayments', 'cbs_txns',
  'mart_customer_360', 'mart_loan_360', 'bureau_score',
];

const DIMENSION_COLORS: Record<DqDimension, string> = {
  completeness: '#0f766e', // teal
  validity:     '#1d4ed8', // blue
  consistency:  '#7c3aed', // violet
  uniqueness:   '#d97706', // amber
  timeliness:   '#dc2626', // red
};

function scoreTone(score: number): BadgeTone {
  if (score >= 90) return 'success';
  if (score >= 75) return 'warning';
  return 'danger';
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { hour12: false });
}

function exportCsv(rows: Array<Record<string, string | number>>, name: string): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => {
      const v = r[h];
      const s = typeof v === 'string' && /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v);
      return s;
    }).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function DqScorePage() {
  const [selectedSource, setSelectedSource] = useState<DqScoreSource>('cbs_loans');
  const [trendDays, setTrendDays] = useState<number>(30);

  const dashboardQ = useQuery({
    queryKey: ['dq-dashboard'],
    queryFn: api.dqScoreDashboard,
  });
  const sourceQ = useQuery({
    queryKey: ['dq-by-source', selectedSource, trendDays],
    queryFn: () => api.dqBySource(selectedSource, trendDays),
  });
  const attrQ = useQuery({
    queryKey: ['dq-by-attribute', selectedSource],
    queryFn: () => api.dqByAttribute(selectedSource),
  });
  const execsQ = useQuery({
    queryKey: ['dq-executions'],
    queryFn: () => api.dqExecutionsList({ limit: 20 }),
  });

  const overlay = dashboardQ.data?.score_overlay;
  const sourceDetail = sourceQ.data;
  const attributes = attrQ.data?.items ?? [];
  const executions = execsQ.data?.items ?? [];

  // Bar chart rows: 1 per source, 5 series (one per dimension).
  const barRows = useMemo(() => {
    if (!overlay) return [];
    return overlay.by_source.map((s) => {
      const row: Record<string, string | number> = { source_id: s.source_id, composite: s.composite_score };
      for (const d of s.dimensions) row[d.dimension] = d.score;
      return row;
    });
  }, [overlay]);

  const weightsLabel = overlay
    ? DIMENSIONS.map((d) => `${d[0]}${(overlay.weights[d] * 100).toFixed(0)}`).join(' ')
    : '—';

  const handleExport = () => {
    if (!overlay) return;
    const rows = overlay.by_source.map((s) => ({
      source_id: s.source_id,
      composite_score: s.composite_score,
      attributes: s.attributes,
      rows_evaluated: s.rows_evaluated,
      completeness: s.dimensions.find((d) => d.dimension === 'completeness')?.score ?? 0,
      validity: s.dimensions.find((d) => d.dimension === 'validity')?.score ?? 0,
      consistency: s.dimensions.find((d) => d.dimension === 'consistency')?.score ?? 0,
      uniqueness: s.dimensions.find((d) => d.dimension === 'uniqueness')?.score ?? 0,
      timeliness: s.dimensions.find((d) => d.dimension === 'timeliness')?.score ?? 0,
    }));
    exportCsv(rows, `dq-score-${new Date().toISOString().slice(0, 10)}`);
  };

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="Data Quality Score"
        subtitle="Composite 0–100 score per source + per attribute across 5 dimensions"
        actions={
          <>
            <span className="hidden items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 lg:inline-flex" title="Active dimension weights (c/v/c/u/t)">
              <FileBarChart size={12} /> Weights: {weightsLabel}
            </span>
            <Button variant="ghost" onClick={handleExport} disabled={!overlay} data-testid="dq-export">
              <Download size={14} /> Export CSV
            </Button>
          </>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard
          label="Fleet score"
          value={overlay?.fleet_composite_score ?? 0}
          sub={overlay ? `across ${overlay.by_source.length} sources` : 'Loading…'}
          tone={overlay && overlay.fleet_composite_score >= 90 ? 'success' : overlay && overlay.fleet_composite_score >= 75 ? 'warning' : 'danger'}
          testId="dq-kpi-fleet"
        />
        <MetricCard
          label="Best source"
          value={overlay?.best_source?.composite_score ?? 0}
          sub={overlay?.best_source?.source_id ?? '—'}
          tone="success"
          testId="dq-kpi-best"
        />
        <MetricCard
          label="Worst source"
          value={overlay?.worst_source?.composite_score ?? 0}
          sub={overlay?.worst_source?.source_id ?? '—'}
          tone="danger"
          testId="dq-kpi-worst"
        />
        <MetricCard
          label="Total executions"
          value={dashboardQ.data?.total_executions ?? 0}
          sub={`${dashboardQ.data?.total_failed ?? 0} failed`}
          testId="dq-kpi-execs"
        />
      </div>

      {/* DQ by Source — bar chart with dimension breakdown */}
      <Panel title="DQ by source — dimension breakdown" data-testid="dq-bar-panel">
        {dashboardQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : barRows.length === 0 ? (
          <div className="text-sm text-slate-500">No DQ data yet.</div>
        ) : (
          <div className="h-72" data-testid="dq-bar-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barRows} margin={{ top: 8, right: 16, left: 0, bottom: 32 }}>
                <CartesianGrid stroke="#e2e8f0" />
                <XAxis dataKey="source_id" angle={-15} textAnchor="end" fontSize={10} height={50} interval={0} />
                <YAxis domain={[0, 100]} fontSize={10} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {DIMENSIONS.map((d) => (
                  <Bar key={d} dataKey={d} fill={DIMENSION_COLORS[d]} name={d} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      {/* Per-source detail + Trend line */}
      <Panel title="Source drill-down" data-testid="dq-source-panel">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <Database size={14} />
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value as DqScoreSource)}
            className="rounded border border-slate-300 px-2 py-1"
            data-testid="dq-source-select"
          >
            {KNOWN_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="ml-3 flex items-center gap-1">
            <TrendingUp size={14} /> Window
            <select
              value={trendDays}
              onChange={(e) => setTrendDays(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-0.5"
              data-testid="dq-trend-window"
            >
              <option value={7}>7d</option>
              <option value={14}>14d</option>
              <option value={30}>30d</option>
              <option value={60}>60d</option>
              <option value={90}>90d</option>
            </select>
          </span>
          {sourceDetail && (
            <span className="ml-auto text-slate-500">
              {sourceDetail.score.attributes} attributes · {sourceDetail.score.rows_evaluated.toLocaleString()} rows
              · score{' '}
              <Badge tone={scoreTone(sourceDetail.score.composite_score)} data-testid="dq-source-composite">
                {sourceDetail.score.composite_score}
              </Badge>
            </span>
          )}
        </div>

        {sourceDetail && (
          <div className="h-56" data-testid="dq-trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sourceDetail.trend.trend} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="#e2e8f0" />
                <XAxis dataKey="date" fontSize={10} />
                <YAxis domain={[60, 100]} fontSize={10} />
                <Tooltip />
                <Line type="monotone" dataKey="composite_score" stroke="#0f172a" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      {/* Per-attribute table */}
      <Panel title={`Attributes — ${selectedSource}`} data-testid="dq-attrs-panel">
        {attrQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Attribute</th>
                  <th className="px-2 py-1.5">Format</th>
                  <th className="px-2 py-1.5">Composite</th>
                  {DIMENSIONS.map((d) => (
                    <th key={d} className="px-2 py-1.5 text-xs">{d.slice(0, 4)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {attributes.map((a) => (
                  <tr key={a.attribute} className="border-b border-slate-100" data-testid={`dq-attr-row-${a.attribute}`}>
                    <td className="px-2 py-1.5 font-mono text-xs">{a.attribute}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-slate-500">{a.format_detected ?? '—'}</td>
                    <td className="px-2 py-1.5">
                      <Badge tone={scoreTone(a.composite_score)}>{a.composite_score}</Badge>
                    </td>
                    {a.dimensions.map((d) => (
                      <td key={d.dimension} className="px-2 py-1.5 font-mono text-xs" style={{ color: DIMENSION_COLORS[d.dimension] }}>
                        {d.score}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Executions log */}
      <Panel title="Recent rule executions" data-testid="dq-execs-panel">
        {execsQ.isLoading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : executions.length === 0 ? (
          <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-500">
            No recent executions.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-2 py-1.5">Execution</th>
                  <th className="px-2 py-1.5">Rule</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Total</th>
                  <th className="px-2 py-1.5">Passed</th>
                  <th className="px-2 py-1.5">Failed</th>
                  <th className="px-2 py-1.5">When</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((e) => (
                  <tr key={e.execution_id} className="border-b border-slate-100" data-testid={`dq-exec-row-${e.execution_id}`}>
                    <td className="px-2 py-1.5 font-mono text-xs">{e.execution_id.slice(0, 28)}…</td>
                    <td className="px-2 py-1.5 text-xs">{e.rule_name} ({e.rule_kind})</td>
                    <td className="px-2 py-1.5">
                      <Badge tone={e.status === 'passed' ? 'success' : e.status === 'failed' ? 'danger' : 'warning'}>
                        {e.status}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs">{e.total_records.toLocaleString()}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-success">{e.passed_records.toLocaleString()}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-danger">{e.failed_records.toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-xs text-slate-500">{fmtTime(e.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
