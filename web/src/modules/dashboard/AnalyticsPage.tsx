// Analytics Dashboard — T4.1 / EWS.docx §5.5 / §8.
//
// Tab-driven: ?tab=alert-resolution|risk-trend|pd-distribution|stage-migration
// Only `alert-resolution` is wired in this iteration; the other three are
// scaffolded as "Coming soon" placeholders so the route + chrome land on
// main now and follow-on commits can fill them in one-by-one.

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, BarChart3, GitBranch, LineChart as LineIcon } from 'lucide-react';
import { MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';
import {
  api,
  type AnalyticsSeverityFilter,
  type AlertResolutionReport,
  type RiskTrendReport,
  type PdDistributionReport,
} from '@/lib/api';

type TabKey = 'alert-resolution' | 'risk-trend' | 'pd-distribution' | 'stage-migration';

const TABS: { key: TabKey; label: string; icon: typeof BarChart3; status: 'live' | 'pending' }[] = [
  { key: 'alert-resolution', label: 'Alert resolution', icon: BarChart3,  status: 'live' },
  { key: 'risk-trend',       label: 'Risk trend',       icon: LineIcon,   status: 'live' },
  { key: 'pd-distribution',  label: 'PD distribution',  icon: BarChart3,  status: 'live' },
  { key: 'stage-migration',  label: 'Stage migration',  icon: GitBranch,  status: 'pending' },
];

const SEVERITY_OPTIONS: AnalyticsSeverityFilter[] = ['all', 'critical', 'high', 'medium', 'low'];

function isTabKey(s: string | null): s is TabKey {
  return s === 'alert-resolution' || s === 'risk-trend' || s === 'pd-distribution' || s === 'stage-migration';
}

export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabKey = isTabKey(searchParams.get('tab')) ? (searchParams.get('tab') as TabKey) : 'alert-resolution';

  const setTab = (next: TabKey) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Analytics Dashboard"
        subtitle="Risk insights across the portfolio · T4.1 / EWS.docx §5.5"
      />

      <Panel>
        <nav role="tablist" aria-label="Analytics sub-dashboards" className="flex flex-wrap gap-1 border-b border-slate-200">
          {TABS.map((t) => {
            const active = t.key === tab;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                aria-controls={`analytics-panel-${t.key}`}
                id={`analytics-tab-${t.key}`}
                data-testid={`analytics-tab-${t.key}`}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-[1px] ${
                  active
                    ? 'border-blue-500 text-blue-700 font-medium'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                <Icon size={14} />
                {t.label}
                {t.status === 'pending' && (
                  <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">
                    coming soon
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div
          role="tabpanel"
          id={`analytics-panel-${tab}`}
          aria-labelledby={`analytics-tab-${tab}`}
          className="pt-4"
        >
          {tab === 'alert-resolution' && <AlertResolutionTab />}
          {tab === 'risk-trend' && <RiskTrendTab />}
          {tab === 'pd-distribution' && <PdDistributionTab />}
          {tab === 'stage-migration' && <ComingSoon title="Stage migration" />}
        </div>
      </Panel>
    </div>
  );
}

// ── Alert Resolution tab ──────────────────────────────────────────────

function AlertResolutionTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const severity = (searchParams.get('severity') as AnalyticsSeverityFilter | null) ?? 'all';

  const setSeverity = (next: AnalyticsSeverityFilter) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'all') sp.delete('severity');
    else sp.set('severity', next);
    setSearchParams(sp, { replace: true });
  };

  const q = useQuery({
    queryKey: ['analytics.alert-resolution', severity],
    queryFn: () => api.alertResolution({ severity }),
  });

  return (
    <div className="space-y-4" data-testid="alert-resolution-panel">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="ar-severity" className="block text-xs font-medium text-slate-500 mb-1">
            Severity
          </label>
          <select
            id="ar-severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as AnalyticsSeverityFilter)}
            className="rounded border border-slate-300 px-2 py-1 text-sm capitalize"
          >
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <span className="ml-auto text-xs text-slate-500">
          {q.data?.generated_at
            ? `Generated ${new Date(q.data.generated_at).toLocaleString()}`
            : ''}
        </span>
      </div>

      {q.isLoading && <p className="py-6 text-center text-sm text-slate-500">Loading…</p>}
      {q.isError && (
        <p role="alert" className="py-6 text-center text-sm text-rose-600">
          <AlertTriangle size={14} className="mr-1 inline" />
          {(q.error as Error)?.message ?? 'Failed to load.'}
        </p>
      )}
      {q.data && <AlertResolutionView report={q.data} />}
    </div>
  );
}

function fmtSec(s: number | null): string {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

function AlertResolutionView({ report }: { report: AlertResolutionReport }) {
  const created = report.funnel.find((f) => f.stage === 'created')?.count ?? 0;
  const closed = report.funnel.find((f) => f.stage === 'closed')?.count ?? 0;
  const closedPct = created === 0 ? 0 : (closed / created) * 100;

  const funnelData = useMemo(
    () =>
      report.funnel.map((s) => ({
        stage: s.stage,
        count: s.count,
        ratioPct: Math.round(s.ratio * 1000) / 10,
      })),
    [report.funnel],
  );

  // Severity-tinted bars: created is neutral, drops blend toward warning then danger
  const stageFill: Record<string, string> = {
    created:      color.blue,
    acked:        color.success,
    investigated: color.warning,
    closed:       color.success,
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Alerts created"
          value={created.toLocaleString()}
          tone="blue"
          sub="in the selected window"
        />
        <MetricCard
          label="Resolution rate"
          value={`${closedPct.toFixed(1)}%`}
          tone={closedPct >= 70 ? 'success' : closedPct >= 40 ? 'warning' : 'danger'}
          sub={`${closed.toLocaleString()} closed of ${created.toLocaleString()}`}
        />
        <MetricCard
          label="Time to ack (p50 / p95)"
          value={`${fmtSec(report.ack_duration.p50_sec)} / ${fmtSec(report.ack_duration.p95_sec)}`}
          tone="neutral"
          sub={`mean ${fmtSec(report.ack_duration.mean_sec)} · n=${report.ack_duration.n}`}
        />
        <MetricCard
          label="Time to close (p50 / p95)"
          value={`${fmtSec(report.close_duration.p50_sec)} / ${fmtSec(report.close_duration.p95_sec)}`}
          tone="neutral"
          sub={`mean ${fmtSec(report.close_duration.mean_sec)} · n=${report.close_duration.n}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Lifecycle funnel">
          <div className="h-[280px]" data-testid="funnel-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnelData} layout="vertical" margin={{ left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" />
                <YAxis dataKey="stage" type="category" width={100} />
                <Tooltip
                  formatter={(value: number, _name, payload) => [
                    `${value.toLocaleString()} (${(payload.payload as { ratioPct: number }).ratioPct.toFixed(1)}%)`,
                    payload.payload.stage,
                  ]}
                />
                <Bar dataKey="count">
                  {funnelData.map((d) => (
                    <Cell key={d.stage} fill={stageFill[d.stage] ?? color.blue} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
            {funnelData.map((s) => (
              <li key={s.stage} className="flex justify-between">
                <span className="capitalize">{s.stage}</span>
                <span className="tabular">
                  {s.count.toLocaleString()} ·{' '}
                  <span className="text-slate-400">{s.ratioPct.toFixed(1)}%</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Weekly trend">
          {report.trend.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">
              Not enough lifecycle data yet for a weekly trend.
            </p>
          ) : (
            <div className="h-[280px]" data-testid="trend-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={report.trend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="week" />
                  <YAxis />
                  <Tooltip />
                  <Line type="monotone" dataKey="created" stroke={color.blue}  dot={false} />
                  <Line type="monotone" dataKey="acked"   stroke={color.warning} dot={false} />
                  <Line type="monotone" dataKey="closed"  stroke={color.success} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ── Risk Trend tab (4b) ───────────────────────────────────────────────

const RANGE_PRESETS: { key: '7d' | '30d' | '90d' | 'all'; label: string; days: number | null }[] = [
  { key: '7d',  label: 'Last 7 days',   days: 7 },
  { key: '30d', label: 'Last 30 days',  days: 30 },
  { key: '90d', label: 'Last 90 days',  days: 90 },
  { key: 'all', label: 'All time',      days: null },
];

function RiskTrendTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rangeParam = searchParams.get('range') ?? '30d';
  const range = RANGE_PRESETS.find((r) => r.key === rangeParam) ?? RANGE_PRESETS[1];

  const setRange = (key: typeof RANGE_PRESETS[number]['key']) => {
    const sp = new URLSearchParams(searchParams);
    if (key === '30d') sp.delete('range');
    else sp.set('range', key);
    setSearchParams(sp, { replace: true });
  };

  const filter = useMemo(() => {
    if (range.days == null) return {};
    const from = new Date(Date.now() - range.days * 86_400_000).toISOString();
    return { from };
  }, [range]);

  const q = useQuery({
    queryKey: ['analytics.risk-trend', range.key],
    queryFn: () => api.riskTrend(filter),
  });

  return (
    <div className="space-y-4" data-testid="risk-trend-panel">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="rt-range" className="block text-xs font-medium text-slate-500 mb-1">
            Time range
          </label>
          <select
            id="rt-range"
            value={range.key}
            onChange={(e) => setRange(e.target.value as typeof RANGE_PRESETS[number]['key'])}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            {RANGE_PRESETS.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </div>
        <span className="ml-auto text-xs text-slate-500">
          {q.data?.generated_at
            ? `Generated ${new Date(q.data.generated_at).toLocaleString()}`
            : ''}
        </span>
      </div>

      {q.isLoading && <p className="py-6 text-center text-sm text-slate-500">Loading…</p>}
      {q.isError && (
        <p role="alert" className="py-6 text-center text-sm text-rose-600">
          <AlertTriangle size={14} className="mr-1 inline" />
          {(q.error as Error)?.message ?? 'Failed to load.'}
        </p>
      )}
      {q.data && <RiskTrendView report={q.data} />}
    </div>
  );
}

function RiskTrendView({ report }: { report: RiskTrendReport }) {
  const { totals } = report;
  // Severity stack colors — danger/warning/sky/success match the existing
  // dashboard severity palette so users don't relearn the legend.
  const sevFill: Record<string, string> = {
    critical: color.danger,
    high:     color.warning,
    medium:   color.sky,
    low:      color.success,
  };

  // Recharts wants a flat shape per row — flatten by_severity.
  const data = useMemo(
    () =>
      report.buckets.map((b) => ({
        week: b.week,
        critical: b.by_severity.critical,
        high: b.by_severity.high,
        medium: b.by_severity.medium,
        low: b.by_severity.low,
        avg_criticality: b.avg_criticality ?? 0,
        high_critical_share_pct:
          Math.round(b.high_critical_share * 1000) / 10,
      })),
    [report.buckets],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4" data-testid="rt-kpis">
        <div data-testid="rt-kpi-alerts">
          <MetricCard
            label="Alerts in window"
            value={totals.alert_count.toLocaleString()}
            tone="blue"
            sub="across all severities"
          />
        </div>
        <MetricCard
          label="Avg criticality"
          value={totals.avg_criticality == null ? '—' : totals.avg_criticality.toFixed(2)}
          tone={
            totals.avg_criticality == null
              ? 'neutral'
              : totals.avg_criticality >= 5
                ? 'danger'
                : totals.avg_criticality >= 3
                  ? 'warning'
                  : 'success'
          }
          sub="weighted across all alerts"
        />
        <MetricCard
          label="High + critical share"
          value={`${(totals.high_critical_share * 100).toFixed(1)}%`}
          tone={
            totals.high_critical_share >= 0.5
              ? 'danger'
              : totals.high_critical_share >= 0.25
                ? 'warning'
                : 'success'
          }
          sub="of total alerts in window"
        />
      </div>

      <Panel title="Weekly alert volume × severity (bars) + avg criticality (line)">
        {data.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-500" data-testid="rt-empty">
            No alerts in the selected window.
          </p>
        ) : (
          <div className="h-[340px]" data-testid="risk-trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="week" />
                <YAxis yAxisId="left" />
                <YAxis yAxisId="right" orientation="right" />
                <Tooltip />
                <Legend />
                {/* Stacked bars for severity counts */}
                <Bar yAxisId="left" dataKey="critical" stackId="sev" fill={sevFill.critical} />
                <Bar yAxisId="left" dataKey="high"     stackId="sev" fill={sevFill.high} />
                <Bar yAxisId="left" dataKey="medium"   stackId="sev" fill={sevFill.medium} />
                <Bar yAxisId="left" dataKey="low"      stackId="sev" fill={sevFill.low} />
                {/* Avg criticality on the right axis */}
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="avg_criticality"
                  stroke={color.navy}
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Bar stack on the left axis = alert count by severity per ISO week. Line on
          the right axis = average <code>criticality_score</code> across all alerts in
          that week. Higher line + bigger red stack = higher concentrated risk.
        </p>
      </Panel>
    </div>
  );
}

// ── PD Distribution tab (4c) ──────────────────────────────────────────

function PdDistributionTab() {
  // Compare-to-prior offset: 30 days back is the BAC default ("compare to
  // prior month"). Tunable via the dropdown.
  const [searchParams, setSearchParams] = useSearchParams();
  const compareDays = Number(searchParams.get('compare') ?? '30');

  const setCompare = (days: number) => {
    const sp = new URLSearchParams(searchParams);
    if (days === 30) sp.delete('compare');
    else sp.set('compare', String(days));
    setSearchParams(sp, { replace: true });
  };

  const filter = useMemo(() => {
    if (compareDays <= 0) return {};
    const prior_as_of = new Date(Date.now() - compareDays * 86_400_000).toISOString();
    return { prior_as_of };
  }, [compareDays]);

  const q = useQuery({
    queryKey: ['analytics.pd-distribution', compareDays],
    queryFn: () => api.pdDistribution(filter),
  });

  return (
    <div className="space-y-4" data-testid="pd-distribution-panel">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="pd-compare" className="block text-xs font-medium text-slate-500 mb-1">
            Compare to
          </label>
          <select
            id="pd-compare"
            value={compareDays}
            onChange={(e) => setCompare(Number(e.target.value))}
            className="rounded border border-slate-300 px-2 py-1 text-sm"
          >
            <option value={0}>(no comparison)</option>
            <option value={7}>7 days ago</option>
            <option value={30}>30 days ago</option>
            <option value={90}>90 days ago</option>
          </select>
        </div>
        <span className="ml-auto text-xs text-slate-500">
          {q.data?.generated_at
            ? `Generated ${new Date(q.data.generated_at).toLocaleString()}`
            : ''}
        </span>
      </div>

      {q.isLoading && <p className="py-6 text-center text-sm text-slate-500">Loading…</p>}
      {q.isError && (
        <p role="alert" className="py-6 text-center text-sm text-rose-600">
          <AlertTriangle size={14} className="mr-1 inline" />
          {(q.error as Error)?.message ?? 'Failed to load.'}
        </p>
      )}
      {q.data && <PdDistributionView report={q.data} compareDays={compareDays} />}
    </div>
  );
}

function PdDistributionView({
  report,
  compareDays,
}: {
  report: PdDistributionReport;
  compareDays: number;
}) {
  const { totals, bins, bands } = report;

  // Recharts stacks the prior count on top of current using a separate series
  // so the user can read both. Risk band background is decorative — drawn
  // via a thin rule beneath the bars (not chart-axis-aware, so we keep it as
  // labels in the band-summary list rather than chart overlays for now).
  const data = bins.map((b) => ({
    label: b.label,
    count: b.count,
    prior: b.prior_count ?? 0,
    delta: b.delta ?? 0,
  }));

  const bandFill: Record<string, string> = {
    low: color.success,
    medium: color.warning,
    high: color.danger,
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" data-testid="pd-kpis">
        <div data-testid="pd-kpi-customers">
          <MetricCard
            label="Customers in snapshot"
            value={totals.customer_count.toLocaleString()}
            tone="blue"
            sub={
              totals.prior_customer_count != null
                ? `vs ${totals.prior_customer_count.toLocaleString()} ${compareDays}d ago`
                : 'no prior comparison'
            }
          />
        </div>
        <MetricCard
          label="Mean PD-proxy"
          value={totals.mean_pd_proxy == null ? '—' : totals.mean_pd_proxy.toFixed(2)}
          tone={
            totals.mean_pd_proxy == null
              ? 'neutral'
              : totals.mean_pd_proxy >= 5
                ? 'danger'
                : totals.mean_pd_proxy >= 3
                  ? 'warning'
                  : 'success'
          }
          sub="criticality_score [0..10]"
        />
        <MetricCard
          label="High-band share"
          value={`${(totals.high_band_share * 100).toFixed(1)}%`}
          tone={
            totals.high_band_share >= 0.4
              ? 'danger'
              : totals.high_band_share >= 0.2
                ? 'warning'
                : 'success'
          }
          sub="customers with PD-proxy ≥ 5.0"
        />
        <div data-testid="pd-kpi-bands">
          <MetricCard
            label="Bands (low / med / high)"
            value={`${bands[0].count.toLocaleString()} / ${bands[1].count.toLocaleString()} / ${bands[2].count.toLocaleString()}`}
            tone="neutral"
            sub="count of customers in each band"
          />
        </div>
      </div>

      <Panel title="PD-proxy distribution (10 bins, [0..10])">
        {data.every((d) => d.count === 0) ? (
          <p className="py-12 text-center text-sm text-slate-500" data-testid="pd-empty">
            No customers in this snapshot.
          </p>
        ) : (
          <div className="h-[340px]" data-testid="pd-distribution-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="count" name="Current" fill={color.blue} />
                {totals.prior_customer_count != null && (
                  <Bar dataKey="prior" name={`${compareDays}d ago`} fill={color.skyLight} />
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <ul className="mt-2 grid grid-cols-1 gap-1 text-xs text-slate-600 sm:grid-cols-3">
          {bands.map((b) => (
            <li key={b.band} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: bandFill[b.band] }}
                aria-hidden
              />
              <span className="capitalize">{b.band}</span>
              <span className="text-slate-400">[{b.lower}, {b.upper})</span>
              <span className="ml-auto tabular">{b.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

// ── Coming-soon placeholder ───────────────────────────────────────────

function ComingSoon({ title }: { title: string }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 p-12 text-slate-500"
      data-testid={`coming-soon-${title.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <span className="text-sm font-medium">{title} — coming soon</span>
      <span className="text-xs">
        Sub-dashboard scaffold landed; resolver + chart land in a follow-on commit.
      </span>
    </div>
  );
}
