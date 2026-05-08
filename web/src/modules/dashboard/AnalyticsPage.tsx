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
} from '@/lib/api';

type TabKey = 'alert-resolution' | 'risk-trend' | 'pd-distribution' | 'stage-migration';

const TABS: { key: TabKey; label: string; icon: typeof BarChart3; status: 'live' | 'pending' }[] = [
  { key: 'alert-resolution', label: 'Alert resolution', icon: BarChart3,  status: 'live' },
  { key: 'risk-trend',       label: 'Risk trend',       icon: LineIcon,   status: 'pending' },
  { key: 'pd-distribution',  label: 'PD distribution',  icon: BarChart3,  status: 'pending' },
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
          {tab === 'risk-trend' && <ComingSoon title="Risk trend" />}
          {tab === 'pd-distribution' && <ComingSoon title="PD distribution" />}
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
