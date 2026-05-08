import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
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
import { AlertTriangle } from 'lucide-react';
import { api, type SlaSummary } from '@/lib/api';
import {
  DEFAULT_RANGE,
  isTimeRangeKey,
  MetricCard,
  Panel,
  sliceForRange,
  TimeRangeSelector,
  type TimeRangeKey,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { color } from '@/styles/tokens';
import { useChatContext } from '@/components/copilot/useChatContext';
import { SLABreachMatrix } from '@/components/dashboard/SLABreachMatrix';
import { LiveActivityFeed } from '@/components/dashboard/LiveActivityFeed';

const SEVERITY_FILL: Record<string, string> = {
  critical: color.danger,
  high: color.warning,
  medium: color.sky,
  low: color.success,
};

// Centralised so the table below the cards stays in sync with the cards
// themselves — change the deep-link target in one place if a route moves.
const KPI_LINKS = {
  customersAll: '/customers',
  customersHighRisk: '/customers?level=High&pdMin=0.5',
  alertsActive: '/alerts',
  casesOpen: '/cases?state=open,assigned,in_action,monitored',
  casesSlaBreach: '/cases?sla=breached,approaching',
} as const;

const RANGE_LABEL: Record<TimeRangeKey, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'all weeks',
};

export function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rangeParam = searchParams.get('range');
  const range: TimeRangeKey = isTimeRangeKey(rangeParam) ? rangeParam : DEFAULT_RANGE;

  const setRange = (next: TimeRangeKey) => {
    const sp = new URLSearchParams(searchParams);
    if (next === DEFAULT_RANGE) sp.delete('range');
    else sp.set('range', next);
    setSearchParams(sp, { replace: true });
  };

  const { data } = useQuery({
    queryKey: ['dashboard.summary'],
    queryFn: api.dashboardSummary,
  });
  const sla = useQuery({
    queryKey: ['cases.sla-summary'],
    queryFn: api.slaSummary,
    refetchInterval: 30_000,
  });
  useChatContext({ page: 'dashboard' });

  const trendSlice = data ? sliceForRange(data.risk_trend, range) : [];

  return (
    <div>
      <PageHeader
        title="EWS Dashboard"
        subtitle="Portfolio-wide risk posture · refreshed every 60 seconds"
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <MetricCard
          label="Customers monitored"
          value={data ? data.customers_monitored.toLocaleString() : '—'}
          tone="blue"
          sub="all portfolios"
          to={KPI_LINKS.customersAll}
          ariaLabel="Customers monitored — open the customer list"
          testId="kpi-customers-monitored"
        />
        <MetricCard
          label="High-risk customers"
          value={data ? data.high_risk_customers.toLocaleString() : '—'}
          tone="danger"
          sub="PD ≥ 0.5"
          to={KPI_LINKS.customersHighRisk}
          ariaLabel="High-risk customers — open the customer list filtered to PD ≥ 0.5"
          testId="kpi-high-risk"
        />
        <MetricCard
          label="Active alerts"
          value={data ? data.active_alerts.toLocaleString() : '—'}
          tone="warning"
          sub="unresolved"
          to={KPI_LINKS.alertsActive}
          ariaLabel="Active alerts — open the alerts queue"
          testId="kpi-active-alerts"
        />
        <MetricCard
          label="Cases open"
          value={data ? data.cases_open.toLocaleString() : '—'}
          tone="purple"
          sub="across queues"
          to={KPI_LINKS.casesOpen}
          ariaLabel="Cases open — open the case queue filtered to non-closed states"
          testId="kpi-cases-open"
        />
        <MetricCard
          label="SLA breaches"
          value={sla.data ? sla.data.totals.breached.toLocaleString() : '—'}
          tone={sla.data && sla.data.totals.breached > 0 ? 'danger' : 'success'}
          sub={
            sla.data
              ? `${sla.data.totals.approaching} approaching · ${sla.data.totals.on_track} on track`
              : 'live evaluator'
          }
          to={KPI_LINKS.casesSlaBreach}
          ariaLabel="SLA breaches — open the case queue filtered to breached + approaching SLA"
          testId="kpi-sla-breaches"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel
          title={`Portfolio PD trend · ${RANGE_LABEL[range]}`}
          className="lg:col-span-2"
          action={<TimeRangeSelector value={range} onChange={setRange} testId="pd-trend-range" />}
        >
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendSlice}>
                <CartesianGrid stroke={color.divider} strokeDasharray="3 3" />
                <XAxis dataKey="week" stroke={color.muted} fontSize={11} />
                <YAxis stroke={color.muted} fontSize={11} tickFormatter={(v) => `${(v * 100).toFixed(1)}%`} />
                <Tooltip
                  contentStyle={{
                    background: color.surface,
                    border: `1px solid ${color.divider}`,
                    fontSize: 12,
                  }}
                  formatter={(v) => `${(Number(v) * 100).toFixed(2)}%`}
                />
                <Line
                  type="monotone"
                  dataKey="pd"
                  stroke={color.blue}
                  strokeWidth={2}
                  dot={{ r: 3, fill: color.blue }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Alerts by severity">
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data?.alerts_by_severity ?? []}>
                <CartesianGrid stroke={color.divider} strokeDasharray="3 3" />
                <XAxis dataKey="severity" stroke={color.muted} fontSize={11} />
                <YAxis stroke={color.muted} fontSize={11} />
                <Tooltip
                  contentStyle={{
                    background: color.surface,
                    border: `1px solid ${color.divider}`,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {(data?.alerts_by_severity ?? []).map((row) => (
                    <Cell key={row.severity} fill={SEVERITY_FILL[row.severity] ?? color.blue} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <SLABreachMatrix />
        </div>
        <div className="lg:col-span-1">
          <LiveActivityFeed />
        </div>
      </div>

      {sla.data && <SlaPanel summary={sla.data} />}
    </div>
  );
}

function SlaPanel({ summary }: { summary: SlaSummary }) {
  return (
    <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Panel title="SLA status by severity" className="lg:col-span-2">
        <table className="w-full text-[12px]" data-testid="sla-matrix">
          <thead className="text-muted">
            <tr className="border-b border-divider">
              <th className="text-left py-2 font-medium">Severity</th>
              <th className="text-right py-2 font-medium">On track</th>
              <th className="text-right py-2 font-medium">Approaching</th>
              <th className="text-right py-2 font-medium">Breached</th>
              <th className="text-right py-2 font-medium">Closed</th>
              <th className="text-right py-2 font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {summary.by_severity.map((row) => (
              <tr key={row.severity} className="border-b border-divider/40">
                <td className="py-2 capitalize text-ink font-medium">{row.severity}</td>
                <td className="text-right tabular text-success">{row.on_track}</td>
                <td className="text-right tabular text-warning">{row.approaching}</td>
                <td
                  className={`text-right tabular ${
                    row.breached > 0 ? 'text-danger font-semibold' : 'text-sub'
                  }`}
                >
                  {row.breached}
                </td>
                <td className="text-right tabular text-sub">{row.closed}</td>
                <td className="text-right tabular text-ink">{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="caption mt-3">
          Generated <span className="font-mono">{new Date(summary.generated_at).toLocaleTimeString()}</span> ·
          policy from <span className="font-mono">services/bff/src/sla/policy.ts</span> · auto-refresh 30s
        </p>
      </Panel>

      <Panel title="Most overdue">
        {summary.breached_cases.length === 0 ? (
          <p className="caption">No breaches — every case is inside its SLA window.</p>
        ) : (
          <ul className="space-y-2.5" data-testid="breached-cases-list">
            {summary.breached_cases.slice(0, 5).map((c) => (
              <li
                key={c.case_id}
                className="flex items-start gap-2 rounded border border-danger/20 bg-danger-bg/40 p-2"
              >
                <AlertTriangle size={14} className="text-danger mt-[2px]" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-ink">{c.case_id}</span>
                    <span className="text-[10px] uppercase tracking-wide text-danger font-semibold">
                      {c.severity}
                    </span>
                  </div>
                  <div className="text-[11px] text-sub">
                    {c.stage} stage ·{' '}
                    <span className="text-danger tabular">
                      {Math.abs(c.minutes_remaining ?? 0).toFixed(0)} min overdue
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
