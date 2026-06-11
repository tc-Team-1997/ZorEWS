// RiskIntelligenceHubPage.tsx — Risk Intelligence Hub
// Aggregates live alert, customer, and case signals into a single intelligence view.
// Routes: /risk-intelligence
// Visible to: admin, risk_analyst, supervisor

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  CheckCircle2,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { api, type Alert, type CustomerListRow, type CaseSummary } from '@/lib/api';
import { MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { cn } from '@/lib/cn';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function riskBadgeClass(level: string): string {
  const map: Record<string, string> = {
    High: 'bg-red-50 text-red-700 border border-red-200',
    Medium: 'bg-amber-50 text-amber-700 border border-amber-200',
    Low: 'bg-green-50 text-green-700 border border-green-200',
  };
  return map[level] ?? 'bg-slate-100 text-slate-600';
}

function severityBadgeClass(severity: string): string {
  const map: Record<string, string> = {
    critical: 'bg-red-50 text-red-700 border border-red-200',
    high: 'bg-orange-50 text-orange-700 border border-orange-200',
    medium: 'bg-amber-50 text-amber-700 border border-amber-200',
    low: 'bg-green-50 text-green-700 border border-green-200',
  };
  return map[severity?.toLowerCase()] ?? 'bg-slate-100 text-slate-600';
}

function SkeletonRow() {
  return (
    <div className="animate-pulse flex items-center gap-3 py-2">
      <div className="h-3 bg-slate-200 rounded w-24 flex-shrink-0" />
      <div className="h-3 bg-slate-200 rounded flex-1" />
      <div className="h-3 bg-slate-200 rounded w-16 flex-shrink-0" />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function RiskIntelligenceHubPage() {
  // Fetch alerts
  const { data: alertsData, isLoading: alertsLoading } = useQuery({
    queryKey: ['risk-intel-alerts'],
    queryFn: () => api.alerts({ sort: 'criticality' }),
  });

  // Fetch high-risk customers
  const { data: customersData, isLoading: customersLoading } = useQuery({
    queryKey: ['risk-intel-customers'],
    queryFn: () => api.customerList({ level: 'High', pdMin: 0.5 }),
  });

  // Fetch open cases
  const { data: casesData, isLoading: casesLoading } = useQuery({
    queryKey: ['risk-intel-cases'],
    queryFn: () => api.cases({ state: 'open,assigned,in_action,monitored' }),
  });

  const alerts: Alert[] = alertsData?.items ?? [];
  const customers: CustomerListRow[] = customersData?.items ?? [];
  const cases: CaseSummary[] = casesData?.items ?? [];

  // Derive metrics
  const activeAlerts = alerts.length;
  const highRiskCustomers = customers.filter((c: CustomerListRow) => c.level === 'High').length;
  const openCases = cases.length;

  // SLA compliance % — cases without SLA breach
  const slaCompliance = useMemo(() => {
    if (cases.length === 0) return 100;
    const breached = cases.filter((c: CaseSummary) => c.sla_status === 'breached').length;
    return Math.round(((cases.length - breached) / cases.length) * 100);
  }, [cases]);

  // Top 5 high-risk customers
  const topRiskCustomers = useMemo(
    () =>
      [...customers]
        .sort((a: CustomerListRow, b: CustomerListRow) => (b.pd ?? 0) - (a.pd ?? 0))
        .slice(0, 5),
    [customers],
  );

  // Last 5 alerts by creation time
  const recentAlerts = useMemo(
    () => [...alerts].slice(0, 5),
    [alerts],
  );

  return (
    <div className="space-y-6" data-testid="risk-intel-hub">
      <PageHeader
        title="Risk Intelligence Hub"
        subtitle="Live risk signals, high-risk customer watch, and case intelligence in one view"
      />

      {/* ── Metric cards ──────────────────────────────────────────────── */}
      <div
        className="grid grid-cols-2 gap-4 sm:grid-cols-4"
        data-testid="risk-intel-kpi-strip"
      >
        <MetricCard
          label="Active Alerts"
          value={alertsLoading ? '—' : activeAlerts.toLocaleString('en-IN')}
          sub="All severity levels"
          tone={activeAlerts > 50 ? 'danger' : activeAlerts > 20 ? 'warning' : 'neutral'}
          testId="kpi-active-alerts"
        />
        <MetricCard
          label="Avg PD Score"
          value={
            customersLoading
              ? '—'
              : customers.length > 0
              ? (
                  customers.reduce((s: number, c: CustomerListRow) => s + (c.pd ?? 0), 0) / customers.length
                ).toFixed(2)
              : '0.00'
          }
          sub="High-risk segment"
          tone="warning"
          testId="kpi-avg-pd"
        />
        <MetricCard
          label="Cases Open"
          value={casesLoading ? '—' : openCases.toLocaleString('en-IN')}
          sub="Excluding closed"
          tone={openCases > 100 ? 'danger' : openCases > 50 ? 'warning' : 'neutral'}
          testId="kpi-cases-open"
        />
        <MetricCard
          label="SLA Compliance"
          value={casesLoading ? '—' : `${slaCompliance}%`}
          sub="Cases within SLA"
          tone={slaCompliance >= 90 ? 'success' : slaCompliance >= 70 ? 'warning' : 'danger'}
          testId="kpi-sla-compliance"
        />
      </div>

      {/* ── Two-column grid: Risk Signals + Recent Alerts ──────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

        {/* Risk Signals — top high-risk customers */}
        <Panel
          title={
            <span className="flex items-center gap-2" data-testid="risk-signals-header">
              <Users size={15} className="text-red-500" />
              <span>Risk Signals</span>
              <span className="ml-auto text-[11px] font-normal text-slate-400">Top 5 high-risk customers</span>
            </span>
          }
        >
          <div data-testid="risk-signals-table">
            {customersLoading ? (
              <div className="space-y-2 py-1">
                {[...Array(5)].map((_, i) => <SkeletonRow key={i} />)}
              </div>
            ) : topRiskCustomers.length === 0 ? (
              <p className="text-sm text-slate-400 py-4 text-center" data-testid="risk-signals-empty">
                No high-risk customers found
              </p>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left py-2 pr-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide">Customer</th>
                    <th className="text-left py-2 pr-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide">PD Score</th>
                    <th className="text-left py-2 pr-3 font-semibold text-slate-500 text-[10px] uppercase tracking-wide">Risk Level</th>
                    <th className="text-left py-2 font-semibold text-slate-500 text-[10px] uppercase tracking-wide">Exposure</th>
                  </tr>
                </thead>
                <tbody>
                  {topRiskCustomers.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-slate-50 hover:bg-slate-50 transition-colors"
                      data-testid={`risk-signal-row-${c.id}`}
                    >
                      <td className="py-2 pr-3">
                        <Link
                          to={`/customers/${c.id}`}
                          className="font-medium text-indigo-600 hover:underline"
                        >
                          {c.name ?? c.id}
                        </Link>
                      </td>
                      <td className="py-2 pr-3">
                        <span className="font-semibold text-red-600">
                          {((c.pd ?? 0) * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={cn(
                            'inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold',
                            riskBadgeClass(c.level ?? ''),
                          )}
                        >
                          {c.level ?? '—'}
                        </span>
                      </td>
                      <td className="py-2 text-slate-600">
                        {c.exposure != null
                          ? `KES ${(c.exposure / 1000000).toFixed(1)}M`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {topRiskCustomers.length > 0 && (
              <div className="mt-3 flex justify-end">
                <Link
                  to="/customers?level=High&pdMin=0.5"
                  className="text-[11px] text-indigo-600 hover:underline flex items-center gap-1"
                  data-testid="view-all-customers-link"
                >
                  View all high-risk customers <ArrowRight size={11} />
                </Link>
              </div>
            )}
          </div>
        </Panel>

        {/* Recent Alerts */}
        <Panel
          title={
            <span className="flex items-center gap-2" data-testid="recent-alerts-header">
              <ShieldAlert size={15} className="text-amber-500" />
              <span>Recent Alerts</span>
              <span className="ml-auto text-[11px] font-normal text-slate-400">Last 5 alerts</span>
            </span>
          }
        >
          <div data-testid="recent-alerts-panel">
            {alertsLoading ? (
              <div className="space-y-2 py-1">
                {[...Array(5)].map((_, i) => <SkeletonRow key={i} />)}
              </div>
            ) : recentAlerts.length === 0 ? (
              <p className="text-sm text-slate-400 py-4 text-center" data-testid="recent-alerts-empty">
                No alerts found
              </p>
            ) : (
              <div className="space-y-2">
                {recentAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="flex items-start gap-3 py-2 border-b border-slate-50 last:border-0"
                    data-testid={`recent-alert-${alert.id}`}
                  >
                    <AlertTriangle
                      size={13}
                      className={cn(
                        'mt-0.5 flex-shrink-0',
                        alert.severity === 'critical' ? 'text-red-500' :
                        alert.severity === 'high' ? 'text-orange-500' :
                        'text-amber-500'
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-slate-800 truncate">
                        {alert.rule?.name ?? `Alert ${alert.id}`}
                      </p>
                      <p className="text-[10px] text-slate-400 mt-0.5">
                        {alert.customer.name} · {alert.age_min} min ago
                      </p>
                    </div>
                    <span
                      className={cn(
                        'flex-shrink-0 inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize',
                        severityBadgeClass(alert.severity),
                      )}
                    >
                      {alert.severity}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {recentAlerts.length > 0 && (
              <div className="mt-3 flex justify-end">
                <Link
                  to="/alerts"
                  className="text-[11px] text-indigo-600 hover:underline flex items-center gap-1"
                  data-testid="view-all-alerts-link"
                >
                  View all alerts <ArrowRight size={11} />
                </Link>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* ── Intelligence summary footer ─────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border border-indigo-100 rounded-xl text-[12px] text-indigo-800"
        data-testid="intel-footer"
      >
        <Brain size={16} className="text-indigo-500 flex-shrink-0" />
        <p>
          <strong>Intelligence summary:</strong>{' '}
          {activeAlerts} active alerts · {highRiskCustomers} high-risk customers monitored
          · {openCases} cases in flight · SLA compliance {slaCompliance}%
        </p>
        {slaCompliance >= 90 && (
          <CheckCircle2 size={14} className="text-green-600 ml-auto flex-shrink-0" />
        )}
      </div>
    </div>
  );
}
