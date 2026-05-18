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
import { api, type Severity, type SlaSummary } from '@/lib/api';
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
import {
  SeverityDrilldown,
  TrendWeekDrilldown,
} from '@/components/dashboard/AlertDrilldown';
import { AlertAnalyticsSection } from '@/components/dashboard/AlertAnalyticsSection';

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
  // Cases-legacy nav was retired — these KPIs now land in the CMS
  // Case Management page. `breached=true` is the only param the CMS
  // page recognises (matches SLABreachMatrix's deep-link); the
  // legacy `state=` vocabulary doesn't translate so the casesOpen
  // card lands unfiltered (user filters from within CMS).
  casesOpen: '/cms/cases',
  casesSlaBreach: '/cms/cases?breached=true',
} as const;

const RANGE_LABEL: Record<TimeRangeKey, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'all weeks',
};

const SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'high', 'medium', 'low']);

// `?drill=severity:critical` opens the severity drill-down on boot;
// `?drill=week:3` opens the trend drill-down for trendSlice[3]; absent
// or malformed → no drill. URL-bound so operators can share a link and
// have the dashboard render with the same drill already expanded.
function parseDrillParam(
  raw: string | null,
  trendLen: number,
): { kind: 'severity'; severity: Severity } | { kind: 'week'; index: number } | null {
  if (!raw) return null;
  const [kind, val] = raw.split(':');
  if (kind === 'severity' && val && SEVERITIES.has(val as Severity)) {
    return { kind: 'severity', severity: val as Severity };
  }
  if (kind === 'week' && val) {
    const idx = Number(val);
    if (Number.isInteger(idx) && idx >= 0 && idx < trendLen) {
      return { kind: 'week', index: idx };
    }
  }
  return null;
}

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
    // Page subtitle promises "refreshed every 60 seconds". Without
    // this interval react-query only refetches on focus / mount, so
    // the metric cards + bar chart could go stale across a long
    // session. Background refetch is off — no point polling a tab
    // the operator isn't looking at.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const sla = useQuery({
    queryKey: ['cases.sla-summary'],
    queryFn: api.slaSummary,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  useChatContext({ page: 'dashboard' });

  const trendSlice = data ? sliceForRange(data.risk_trend, range) : [];

  // Drill-down state lives in the URL (?drill=severity:critical | week:N)
  // so links are shareable + the drill survives a page refresh. Only one
  // drill can be open at a time — clicking a bar/point sets the param,
  // clicking the same target again clears it.
  const drill = parseDrillParam(searchParams.get('drill'), trendSlice.length);
  const drillSeverity = drill?.kind === 'severity' ? drill.severity : null;
  const drillWeekIndex = drill?.kind === 'week' ? drill.index : null;

  const setDrillParam = (next: string | null) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('drill', next);
    else sp.delete('drill');
    setSearchParams(sp, { replace: true });
  };
  const onBarClick = (sev: Severity) => {
    setDrillParam(drillSeverity === sev ? null : `severity:${sev}`);
  };
  const onTrendClick = (idx: number) => {
    setDrillParam(drillWeekIndex === idx ? null : `week:${idx}`);
  };
  const closeDrill = () => setDrillParam(null);

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
          <p
            className="caption mb-1"
            data-testid="pd-trend-drill-hint"
          >
            Click any point to drill into that week's severity mix, top
            firing rules, and most-affected customers.
          </p>
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
                  dot={{ r: 3, fill: color.blue, cursor: 'pointer' }}
                  activeDot={{
                    r: 5,
                    fill: color.blue,
                    cursor: 'pointer',
                    onClick: (_e, payload) => {
                      // recharts hands us the activePayload index via the
                      // payload arg shape; fall back to clicking the dot
                      // index directly via the data slice.
                      const idx = (payload as { index?: number } | undefined)?.index;
                      if (typeof idx === 'number') onTrendClick(idx);
                    },
                  }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel title="Active alerts by severity">
          <p className="caption mb-1" data-testid="alerts-bar-drill-hint">
            Currently open across the portfolio — click a bar or the
            buttons below to drill into top rules, top customers, age
            distribution, assignment status, and top indicators.
          </p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data?.alerts_by_severity ?? []}
                onClick={(state) => {
                  // recharts passes the active item's payload here when a
                  // bar is hit; read the severity off it.
                  const sev = (state as { activePayload?: { payload?: { severity?: Severity } }[] })
                    ?.activePayload?.[0]?.payload?.severity;
                  if (sev) onBarClick(sev);
                }}
              >
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
                <Bar dataKey="count" radius={[3, 3, 0, 0]} cursor="pointer">
                  {(data?.alerts_by_severity ?? []).map((row) => (
                    <Cell key={row.severity} fill={SEVERITY_FILL[row.severity] ?? color.blue} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* Keyboard-accessible drill triggers — the bars themselves can
              also be clicked, but screen-reader + tab-nav users get
              proper buttons here. */}
          <div className="mt-2 flex flex-wrap gap-1">
            {(data?.alerts_by_severity ?? []).map((row) => (
              <button
                key={row.severity}
                type="button"
                onClick={() => onBarClick(row.severity)}
                aria-pressed={drillSeverity === row.severity}
                className={`rounded-full px-2 py-0.5 text-2xs font-medium capitalize transition-colors ${
                  drillSeverity === row.severity
                    ? 'bg-action text-white'
                    : 'bg-page text-ink-sub hover:bg-divider/60'
                }`}
                data-testid={`alerts-bar-cell-${row.severity}`}
              >
                {row.severity} · {row.count}
              </button>
            ))}
          </div>
        </Panel>
      </div>

      {/* ── Drill-down panel — only one open at a time ── */}
      {drillSeverity && (
        <div className="mt-4">
          <SeverityDrilldown severity={drillSeverity} onClose={closeDrill} />
        </div>
      )}
      {drillWeekIndex !== null && trendSlice[drillWeekIndex] && (
        <div className="mt-4">
          <TrendWeekDrilldown
            week={trendSlice[drillWeekIndex].week}
            pd={trendSlice[drillWeekIndex].pd}
            prevPd={drillWeekIndex > 0 ? trendSlice[drillWeekIndex - 1].pd : null}
            onClose={closeDrill}
          />
        </div>
      )}

      {/* Alert Analytics workbench — dimension-toggle bar + timeline +
          6-axis deep drill-down. Reuses the same React Query cache as
          TrendWeekDrilldown above so there's no extra network. */}
      <AlertAnalyticsSection />

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
