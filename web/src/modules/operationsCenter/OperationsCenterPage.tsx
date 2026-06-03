// web/src/modules/operationsCenter/OperationsCenterPage.tsx
//
// Production Operations Center — Phase 23 IA overlay.
//
// 13 sections: Platform Health, Service Registry, API Operations,
//   Incident Management, Change Management, Release Management,
//   Environment Management, Capacity & Performance, Security Ops,
//   Business Continuity, Observability, Executive Dashboard, AI Insights.
//
// Additive — every existing module untouched.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, Award, BarChart3,
  Brain, CheckCircle2, ChevronRight,
  GitBranch, Globe, LucideIcon, Network, Package,
  RefreshCw, Shield, ShieldCheck, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid,
  Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  ENVIRONMENTS, INCIDENT_SEVERITIES,
  buildAiOpsInsights, buildApiOperations, buildBusinessContinuity,
  buildCapacityMetrics, buildChangeRequests, buildEnvironments,
  buildExecutiveOpsDashboard, buildIncidents, buildObservabilitySnapshot,
  buildPlatformHealthKpis, buildReleases, buildSecurityOpsView,
  buildServiceRegistry, canAccessOperationsCenter,
  type ChangeState, type Environment, type HealthColor,
  type IncidentSeverity, type IncidentState, type ServiceStatus,
} from './operationsCenterEngine';

const ACTIVE_TENANT = 'BANK_DEMO';
const AS_OF = new Date('2026-06-01T12:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtInt(n: number): string { return n.toLocaleString('en-IN'); }
function fmtPct(n: number): string { return (Math.round(n * 10) / 10) + '%'; }
function fmtMs(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function fmtCr(n: number): string { return '₹' + (Math.round(n * 10) / 10) + ' Cr'; }
function timeSince(iso: string): string {
  const ms = AS_OF.getTime() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function titleWithIcon(label: string, icon: LucideIcon, sub?: string): ReactNode {
  const Icon = icon;
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-indigo-400" aria-hidden />
      <span>{label}</span>
      {sub && <span className="text-xs font-normal text-slate-400 ml-2">{sub}</span>}
    </span>
  );
}

function HealthDot({ color }: { color: HealthColor }) {
  const cls: Record<HealthColor, string> = { green: 'bg-green-500', amber: 'bg-amber-400', red: 'bg-red-500' };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls[color]} animate-pulse`} />;
}

function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  const cls: Record<ServiceStatus, string> = {
    healthy: 'bg-green-50 text-green-700', degraded: 'bg-amber-50 text-amber-700',
    critical: 'bg-red-50 text-red-700', offline: 'bg-red-100 text-red-800',
    maintenance: 'bg-blue-50 text-blue-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[status]}`}>{status}</span>;
}

function IncidentSeverityBadge({ sev }: { sev: IncidentSeverity }) {
  const cls: Record<IncidentSeverity, string> = {
    P1: 'bg-red-100 text-red-800 font-bold', P2: 'bg-orange-50 text-orange-700',
    P3: 'bg-amber-50 text-amber-700', P4: 'bg-slate-100 text-slate-600',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs ${cls[sev]}`}>{sev}</span>;
}

function IncidentStateBadge({ state }: { state: IncidentState }) {
  const cls: Record<IncidentState, string> = {
    open: 'bg-red-50 text-red-700', assigned: 'bg-amber-50 text-amber-700',
    investigating: 'bg-blue-50 text-blue-700', mitigated: 'bg-indigo-50 text-indigo-700',
    resolved: 'bg-green-50 text-green-700', closed: 'bg-slate-100 text-slate-600',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[state]}`}>{state}</span>;
}

function ChangeStateBadge({ state }: { state: ChangeState }) {
  const cls: Record<ChangeState, string> = {
    draft: 'bg-slate-100 text-slate-600', review: 'bg-amber-50 text-amber-700',
    approved: 'bg-green-50 text-green-700', implemented: 'bg-indigo-50 text-indigo-700',
    rejected: 'bg-red-50 text-red-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[state]}`}>{state}</span>;
}

function EnvBadge({ env }: { env: Environment }) {
  const cls: Record<Environment, string> = {
    development: 'bg-slate-100 text-slate-600', sit: 'bg-blue-50 text-blue-700',
    uat: 'bg-violet-50 text-violet-700', pre_production: 'bg-amber-50 text-amber-700',
    production: 'bg-green-50 text-green-800 font-bold',
  };
  const labels: Record<Environment, string> = { development: 'DEV', sit: 'SIT', uat: 'UAT', pre_production: 'PRE-PROD', production: 'PROD' };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs ${cls[env]}`}>{labels[env]}</span>;
}

function ProgressBar({ value, color, height = 4 }: { value: number; color?: string; height?: number }) {
  const c = color ?? (value >= 80 ? '#EF4444' : value >= 60 ? '#F59E0B' : '#10B981');
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 rounded-full overflow-hidden bg-slate-100" style={{ height }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, value)}%`, backgroundColor: c }} />
      </div>
      <span className="text-xs font-semibold w-8" style={{ color: c }}>{Math.round(value)}%</span>
    </div>
  );
}

const SECTION_TABS = [
  { id: 'health',       label: 'Health',        icon: Activity },
  { id: 'services',     label: 'Services',      icon: Package },
  { id: 'apis',         label: 'APIs',          icon: Zap },
  { id: 'incidents',    label: 'Incidents',     icon: AlertTriangle },
  { id: 'changes',      label: 'Changes',       icon: GitBranch },
  { id: 'releases',     label: 'Releases',      icon: RefreshCw },
  { id: 'environments', label: 'Environments',  icon: Globe },
  { id: 'capacity',     label: 'Capacity',      icon: BarChart3 },
  { id: 'security',     label: 'Security',      icon: Shield },
  { id: 'continuity',   label: 'Continuity',    icon: ShieldCheck },
  { id: 'observability',label: 'Observability', icon: Network },
  { id: 'executive',    label: 'Exec View',     icon: Award },
  { id: 'ai-insights',  label: 'AI Insights',   icon: Brain },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function OperationsCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessOperationsCenter(user.roles)) return <Navigate to="/" replace />;

  const asOf = useMemo(() => AS_OF, []);

  const healthKpis    = useMemo(() => buildPlatformHealthKpis(ACTIVE_TENANT, asOf), [asOf]);
  const services      = useMemo(() => buildServiceRegistry(ACTIVE_TENANT, asOf), [asOf]);
  const apiOps        = useMemo(() => buildApiOperations(ACTIVE_TENANT, asOf), [asOf]);
  const incidents     = useMemo(() => buildIncidents(ACTIVE_TENANT, asOf), [asOf]);
  const changes       = useMemo(() => buildChangeRequests(ACTIVE_TENANT, asOf), [asOf]);
  const releases      = useMemo(() => buildReleases(ACTIVE_TENANT, asOf), [asOf]);
  const environments  = useMemo(() => buildEnvironments(ACTIVE_TENANT, asOf), [asOf]);
  const capacity      = useMemo(() => buildCapacityMetrics(ACTIVE_TENANT, asOf), [asOf]);
  const secOps        = useMemo(() => buildSecurityOpsView(ACTIVE_TENANT, asOf), [asOf]);
  const bcp           = useMemo(() => buildBusinessContinuity(ACTIVE_TENANT, asOf), [asOf]);
  const observability = useMemo(() => buildObservabilitySnapshot(ACTIVE_TENANT, asOf), [asOf]);
  const execOps       = useMemo(() => buildExecutiveOpsDashboard(ACTIVE_TENANT, asOf), [asOf]);
  const aiInsights    = useMemo(() => buildAiOpsInsights(ACTIVE_TENANT, asOf), [asOf]);

  const [activeSection, setActiveSection] = useState('health');
  const [incidentFilter, setIncidentFilter] = useState<IncidentSeverity | 'all'>('all');

  const filteredIncidents = incidentFilter === 'all' ? incidents : incidents.filter(i => i.severity === incidentFilter);
  const openIncidents = incidents.filter(i => i.state === 'open' || i.state === 'investigating' || i.state === 'assigned');

  const capChartData = capacity.hourly_trend.map(h => ({
    name: h.hour, CPU: h.cpu, Memory: h.memory, Requests: Math.round(h.requests / 10),
  }));

  const svcStatusPie = [
    { label: 'Healthy', count: services.filter(s => s.status === 'healthy').length, color: '#10B981' },
    { label: 'Degraded', count: services.filter(s => s.status === 'degraded').length, color: '#F59E0B' },
    { label: 'Maintenance', count: services.filter(s => s.status === 'maintenance').length, color: '#6366F1' },
    { label: 'Critical/Offline', count: services.filter(s => s.status === 'critical' || s.status === 'offline').length, color: '#EF4444' },
  ].filter(d => d.count > 0);

  return (
    <div className="space-y-4" data-testid="operations-center">

      <PageHeader
        title="Production Operations Center"
        subtitle="Platform health · Incident management · Release tracking · Capacity · Security · Continuity"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="neutral" className="text-xs">Phase 23</Badge>
            <div className="flex items-center gap-1.5">
              <HealthDot color={healthKpis.overall_health} />
              <Badge tone={healthKpis.overall_health === 'green' ? 'success' : healthKpis.overall_health === 'amber' ? 'warning' : 'danger'} className="text-xs">
                Health: {healthKpis.health_score}/100
              </Badge>
            </div>
            {openIncidents.length > 0 && (
              <Badge tone="warning" className="text-xs">{openIncidents.length} Active Incidents</Badge>
            )}
            <Badge tone="neutral" className="text-xs">{fmtPct(healthKpis.availability_pct)} Availability</Badge>
          </div>
        }
      />

      {/* KPI Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <MetricCard label="Health Score"     value={`${healthKpis.health_score}/100`}            tone={healthKpis.health_score >= 90 ? 'success' : 'warning'} testId="ops-kpi-health" />
        <MetricCard label="Availability"     value={fmtPct(healthKpis.availability_pct)}          tone="success" testId="ops-kpi-avail" />
        <MetricCard label="Active Services"  value={`${healthKpis.active_services}/${healthKpis.total_services}`} tone="success" testId="ops-kpi-svcs" />
        <MetricCard label="Open Incidents"   value={String(healthKpis.active_incidents)}           tone={healthKpis.active_incidents > 2 ? 'warning' : 'neutral'} testId="ops-kpi-incidents" />
        <MetricCard label="Critical Alerts"  value={String(healthKpis.critical_alerts)}            tone={healthKpis.critical_alerts > 3 ? 'danger' : 'neutral'} testId="ops-kpi-alerts" />
        <MetricCard label="SLA Compliance"   value={fmtPct(healthKpis.sla_compliance_pct)}         tone={healthKpis.sla_compliance_pct >= 99 ? 'success' : 'warning'} testId="ops-kpi-sla" />
        <MetricCard label="MTTR"             value={`${healthKpis.mttr_minutes}m`}                 tone={healthKpis.mttr_minutes < 30 ? 'success' : 'warning'} testId="ops-kpi-mttr" />
        <MetricCard label="Capacity Used"    value={fmtPct(healthKpis.capacity_utilization_pct)}   tone={healthKpis.capacity_utilization_pct > 80 ? 'warning' : 'neutral'} testId="ops-kpi-cap" />
      </div>

      {/* Section tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {SECTION_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveSection(id)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${activeSection === id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}
          >
            <Icon className="size-3" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      {/* ─── Section 1: Platform Health ────────────────────────────────────── */}
      {activeSection === 'health' && (
        <Panel title={titleWithIcon('Platform Health Command Center', Activity, 'Real-time platform status')} data-testid="ops-section-health">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="flex flex-col items-center justify-center p-6 rounded-xl border-2 border-opacity-50" style={{ borderColor: healthKpis.overall_health === 'green' ? '#10B981' : healthKpis.overall_health === 'amber' ? '#F59E0B' : '#EF4444', background: healthKpis.overall_health === 'green' ? '#F0FDF4' : healthKpis.overall_health === 'amber' ? '#FFFBEB' : '#FEF2F2' }}>
              <HealthDot color={healthKpis.overall_health} />
              <p className="text-4xl font-black mt-3" style={{ color: healthKpis.overall_health === 'green' ? '#065F46' : healthKpis.overall_health === 'amber' ? '#92400E' : '#991B1B' }}>{healthKpis.health_score}</p>
              <p className="text-sm font-semibold uppercase tracking-wide mt-1" style={{ color: healthKpis.overall_health === 'green' ? '#059669' : healthKpis.overall_health === 'amber' ? '#D97706' : '#DC2626' }}>
                {healthKpis.overall_health === 'green' ? 'All Systems Operational' : healthKpis.overall_health === 'amber' ? 'Degraded Performance' : 'Critical — Action Required'}
              </p>
              <p className="text-xs text-slate-500 mt-2">{fmtPct(healthKpis.availability_pct)} availability · {healthKpis.mtbf_days}d MTBF</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'Active Services', value: `${healthKpis.active_services}/${healthKpis.total_services}`, tone: 'success' },
                { label: 'Degraded', value: healthKpis.degraded_services, tone: healthKpis.degraded_services > 0 ? 'warning' : 'neutral' },
                { label: 'Failed', value: healthKpis.failed_services, tone: healthKpis.failed_services > 0 ? 'danger' : 'success' },
                { label: 'Critical Alerts', value: healthKpis.critical_alerts, tone: healthKpis.critical_alerts > 3 ? 'danger' : 'warning' },
                { label: 'Active Incidents', value: healthKpis.active_incidents, tone: healthKpis.active_incidents > 2 ? 'warning' : 'neutral' },
                { label: 'MTTR (min)', value: healthKpis.mttr_minutes, tone: healthKpis.mttr_minutes < 30 ? 'success' : 'warning' },
              ].map(({ label, value, tone }) => (
                <div key={label} className="p-2.5 rounded-lg border border-slate-100 text-center">
                  <p className={`text-xl font-bold ${tone === 'danger' ? 'text-red-600' : tone === 'warning' ? 'text-amber-600' : tone === 'success' ? 'text-green-600' : 'text-slate-700'}`}>{value}</p>
                  <p className="text-xs text-slate-500">{label}</p>
                </div>
              ))}
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Service Status Distribution</p>
              <div className="space-y-2">
                {svcStatusPie.map(d => (
                  <div key={d.label} className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                    <span className="text-xs text-slate-600 flex-1">{d.label}</span>
                    <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(d.count / services.length) * 100}%`, backgroundColor: d.color }} />
                    </div>
                    <span className="text-xs font-semibold text-slate-700 w-4">{d.count}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-1.5">
                {[
                  { label: 'System Load', value: healthKpis.system_load_pct },
                  { label: 'Capacity Used', value: healthKpis.capacity_utilization_pct },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="text-slate-500">{label}</span>
                      <span className="font-medium">{fmtPct(value)}</span>
                    </div>
                    <ProgressBar value={value} height={5} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 2: Service Registry ──────────────────────────────────── */}
      {activeSection === 'services' && (
        <Panel title={titleWithIcon('Service Registry', Package, `${services.length} registered services`)} data-testid="ops-section-services">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Service', 'Version', 'Owner', 'Status', 'Uptime', 'Response', 'CPU', 'Memory', 'Instances', 'Last Deploy'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {services.map(svc => (
                  <tr key={svc.service_id} className={`border-b border-slate-50 hover:bg-slate-50 ${svc.status === 'critical' || svc.status === 'offline' ? 'bg-red-50/20' : svc.status === 'degraded' ? 'bg-amber-50/20' : ''}`} data-testid={`ops-svc-${svc.service_id}`}>
                    <td className="py-1.5 pr-3 font-semibold text-slate-800">{svc.name}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500">{svc.version}</td>
                    <td className="py-1.5 pr-3 text-slate-500 max-w-28 truncate">{svc.owner}</td>
                    <td className="py-1.5 pr-3"><ServiceStatusBadge status={svc.status} /></td>
                    <td className="py-1.5 pr-3"><span className={svc.uptime_pct >= 99.5 ? 'text-green-600 font-medium' : 'text-amber-600'}>{fmtPct(svc.uptime_pct)}</span></td>
                    <td className="py-1.5 pr-3"><span className={svc.avg_response_ms > 150 ? 'text-amber-600' : 'text-slate-600'}>{fmtMs(svc.avg_response_ms)}</span></td>
                    <td className="py-1.5 pr-3"><span className={svc.cpu_pct > 70 ? 'text-amber-600 font-medium' : 'text-slate-600'}>{fmtPct(svc.cpu_pct)}</span></td>
                    <td className="py-1.5 pr-3"><span className={svc.memory_pct > 75 ? 'text-amber-600' : 'text-slate-600'}>{fmtPct(svc.memory_pct)}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500">{svc.instances}×</td>
                    <td className="py-1.5 pr-3 text-slate-400">{timeSince(svc.last_deployment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 3: API Operations ─────────────────────────────────────── */}
      {activeSection === 'apis' && (
        <Panel title={titleWithIcon('API Operations', Zap, `${apiOps.length} APIs · ${apiOps.filter(a => a.sla_met).length} meeting SLA`)} data-testid="ops-section-apis">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="APIs Healthy"     value={String(apiOps.filter(a => a.status === 'healthy').length)}  tone="success" testId="ops-api-healthy" />
            <MetricCard label="SLA Met"          value={String(apiOps.filter(a => a.sla_met).length)}              tone="success" testId="ops-api-sla-met" />
            <MetricCard label="Avg Availability" value={fmtPct(apiOps.reduce((s,a) => s + a.availability_pct, 0) / apiOps.length)} tone="success" testId="ops-api-avail" />
            <MetricCard label="Total Req/min"    value={fmtInt(apiOps.reduce((s,a) => s + a.requests_per_min, 0))} tone="neutral" testId="ops-api-req" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['API', 'Type', 'Availability', 'Avg Latency', 'P95', 'Error Rate', 'Req/min', 'SLA', 'Owner', 'Status'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {apiOps.map(api => (
                  <tr key={api.api_id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-1.5 pr-3 font-medium text-slate-700 max-w-36 truncate">{api.name}</td>
                    <td className="py-1.5 pr-3"><span className="text-xs bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">{api.api_type}</span></td>
                    <td className="py-1.5 pr-3"><span className={api.availability_pct >= 99.5 ? 'text-green-600 font-medium' : 'text-amber-600'}>{fmtPct(api.availability_pct)}</span></td>
                    <td className="py-1.5 pr-3"><span className={api.avg_latency_ms > api.sla_ms * 0.8 ? 'text-amber-600' : 'text-slate-600'}>{fmtMs(api.avg_latency_ms)}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500">{fmtMs(api.p95_latency_ms)}</td>
                    <td className="py-1.5 pr-3"><span className={api.error_rate_pct > 1 ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtPct(api.error_rate_pct)}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500">{fmtInt(api.requests_per_min)}</td>
                    <td className="py-1.5 pr-3"><span className={api.sla_met ? 'text-green-600' : 'text-red-600 font-medium'}>{fmtMs(api.sla_ms)}</span></td>
                    <td className="py-1.5 pr-3 text-slate-400 max-w-24 truncate">{api.owner}</td>
                    <td className="py-1.5"><span className={`text-xs px-1.5 py-0.5 rounded font-medium ${api.status === 'healthy' ? 'bg-green-50 text-green-700' : api.status === 'degraded' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{api.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 4: Incidents ──────────────────────────────────────────── */}
      {activeSection === 'incidents' && (
        <Panel title={titleWithIcon('Incident Management Center', AlertTriangle, `${openIncidents.length} active · ${incidents.length} total`)} data-testid="ops-section-incidents">
          {openIncidents.some(i => i.war_room_active) && (
            <div className="mb-3 p-2.5 rounded-lg border border-red-300 bg-red-50 flex items-center gap-2">
              <AlertTriangle className="size-4 text-red-600 shrink-0 animate-pulse" aria-hidden />
              <p className="text-xs text-red-700 font-semibold">WAR ROOM ACTIVE — P1 incident in progress. All hands on deck.</p>
            </div>
          )}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs text-slate-500 font-medium">Severity:</span>
            {(['all', ...INCIDENT_SEVERITIES] as const).map(s => (
              <button key={s} onClick={() => setIncidentFilter(s as IncidentSeverity | 'all')} className={`px-2.5 py-0.5 rounded-full text-xs border transition-colors ${incidentFilter === s ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>
                {s === 'all' ? `All (${incidents.length})` : `${s} (${incidents.filter(i => i.severity === s).length})`}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {filteredIncidents.map(inc => (
              <div key={inc.incident_id} className={`p-3 rounded-lg border ${inc.state === 'open' || inc.state === 'investigating' ? 'border-red-200 bg-red-50/20' : inc.state === 'mitigated' ? 'border-amber-200 bg-amber-50/20' : 'border-slate-100'}`}>
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <IncidentSeverityBadge sev={inc.severity} />
                    <IncidentStateBadge state={inc.state} />
                    {inc.war_room_active && <span className="text-xs bg-red-200 text-red-800 px-1.5 py-0.5 rounded font-bold animate-pulse">WAR ROOM</span>}
                    <span className="text-sm font-semibold text-slate-800">{inc.title}</span>
                  </div>
                  <span className="text-xs text-slate-400 shrink-0">{timeSince(inc.opened_at)}</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div><span className="text-slate-400">Service: </span><span className="font-medium text-slate-700">{inc.affected_service}</span></div>
                  <div><span className="text-slate-400">Owner: </span><span className="text-slate-600">{inc.owner.split('@')[0]}</span></div>
                  <div><span className="text-slate-400">MTTR: </span><span className={inc.resolution_time_min ? 'text-green-600' : 'text-slate-400'}>{inc.resolution_time_min ? `${inc.resolution_time_min}m` : 'Ongoing'}</span></div>
                  {inc.postmortem_due && <div><span className="text-slate-400">PIR due: </span><span className="text-amber-600">{inc.postmortem_due}</span></div>}
                </div>
                {inc.root_cause !== 'Under investigation' && (
                  <p className="text-xs text-slate-500 mt-1.5 flex items-start gap-1"><ChevronRight className="size-3 shrink-0 mt-0.5 text-indigo-400" aria-hidden />{inc.root_cause}</p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 5: Change Management ────────────────────────────────── */}
      {activeSection === 'changes' && (
        <Panel title={titleWithIcon('Change Management', GitBranch, `${changes.length} change requests`)} data-testid="ops-section-changes">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['CR ID', 'Title', 'State', 'Type', 'Risk', 'Service', 'Submitter', 'Planned Window', 'Downtime'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {changes.map(cr => (
                  <tr key={cr.cr_id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-1.5 pr-3 font-mono text-slate-600">{cr.cr_id}</td>
                    <td className="py-1.5 pr-3 text-slate-700 max-w-48 truncate font-medium">{cr.title}</td>
                    <td className="py-1.5 pr-3"><ChangeStateBadge state={cr.state} /></td>
                    <td className="py-1.5 pr-3"><span className={`text-xs px-1.5 py-0.5 rounded ${cr.change_type === 'emergency' ? 'bg-red-50 text-red-700' : cr.change_type === 'normal' ? 'bg-indigo-50 text-indigo-700' : 'bg-slate-50 text-slate-600'}`}>{cr.change_type}</span></td>
                    <td className="py-1.5 pr-3"><span className={`text-xs font-medium ${cr.risk_level === 'high' ? 'text-red-600' : cr.risk_level === 'medium' ? 'text-amber-600' : 'text-green-600'}`}>{cr.risk_level}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500 max-w-28 truncate">{cr.affected_service}</td>
                    <td className="py-1.5 pr-3 text-slate-400">{cr.submitter.split('@')[0]}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{cr.planned_window.slice(0, 10)}</td>
                    <td className="py-1.5 pr-3"><span className={cr.estimated_downtime_min > 0 ? 'text-amber-600' : 'text-green-600'}>{cr.estimated_downtime_min === 0 ? 'None' : `${cr.estimated_downtime_min}m`}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 6: Releases ──────────────────────────────────────────── */}
      {activeSection === 'releases' && (
        <Panel title={titleWithIcon('Release Management', RefreshCw, `${releases.length} recent releases · ${fmtPct(releases.filter(r => r.success).length / releases.length * 100)} success`)} data-testid="ops-section-releases">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Success Rate"      value={fmtPct(releases.filter(r => r.success).length / releases.length * 100)} tone="success" testId="ops-rel-success" />
            <MetricCard label="Rollbacks"         value={String(releases.filter(r => r.rollback_triggered).length)} tone={releases.some(r => r.rollback_triggered) ? 'warning' : 'success'} testId="ops-rel-rollbacks" />
            <MetricCard label="Breaking Changes"  value={String(releases.filter(r => r.breaking_changes).length)} tone="neutral" testId="ops-rel-breaking" />
            <MetricCard label="Avg Deploy Time"   value={`${Math.round(releases.reduce((s, r) => s + r.deployment_time_min, 0) / releases.length)}m`} tone="neutral" testId="ops-rel-deploy-time" />
          </div>
          <div className="space-y-2">
            {releases.map(rel => (
              <div key={rel.release_id} className={`flex items-start gap-3 p-3 rounded-lg border ${!rel.success ? 'border-red-200 bg-red-50/20' : rel.rollback_triggered ? 'border-amber-200 bg-amber-50/20' : 'border-slate-100 hover:bg-slate-50'}`}>
                <div className={`mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${rel.success ? 'bg-green-100' : 'bg-red-100'}`}>
                  {rel.success ? <CheckCircle2 className="size-3 text-green-600" aria-hidden /> : <AlertTriangle className="size-3 text-red-600" aria-hidden />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono font-bold text-slate-800">{rel.version}</span>
                    <span className="text-xs text-slate-500">{rel.service}</span>
                    {rel.rollback_triggered && <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">ROLLED BACK</span>}
                    {rel.breaking_changes && <span className="text-xs bg-red-50 text-red-700 px-1.5 py-0.5 rounded">Breaking</span>}
                    <EnvBadge env={rel.environment} />
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{rel.release_notes}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                    <span>By: {rel.deployed_by.split('@')[0]}</span>
                    <span>·</span>
                    <span>{rel.deployment_time_min}m deploy</span>
                    <span>·</span>
                    <span>{rel.features_count} features, {rel.bug_fixes_count} fixes</span>
                    <span>·</span>
                    <span>{timeSince(rel.deployed_at)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 7: Environments ───────────────────────────────────────── */}
      {activeSection === 'environments' && (
        <Panel title={titleWithIcon('Environment Management', Globe, `${ENVIRONMENTS.length} environments`)} data-testid="ops-section-environments">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
            {environments.map(env => (
              <div key={env.env_id} className={`p-3 rounded-xl border-2 ${env.health_color === 'green' ? 'border-green-200 bg-green-50/30' : env.health_color === 'amber' ? 'border-amber-200 bg-amber-50/30' : 'border-red-200 bg-red-50/30'}`} data-testid={`ops-env-${env.name}`}>
                <div className="flex items-center justify-between mb-2">
                  <EnvBadge env={env.name} />
                  <div className="flex items-center gap-1.5">
                    <HealthDot color={env.health_color} />
                    <span className="text-xs font-bold">{env.health_score}</span>
                  </div>
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">Services</span><span className="font-medium">{env.services_healthy}/{env.services_total}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Incidents</span><span className={env.active_incidents > 0 ? 'text-red-600 font-medium' : 'text-slate-600'}>{env.active_incidents}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Deployments</span><span className="text-slate-600">{env.active_deployments}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Uptime</span><span className="text-slate-600">{env.uptime_days}d</span></div>
                </div>
                <div className="mt-2 space-y-1">
                  <div><span className="text-xs text-slate-400">CPU</span><ProgressBar value={env.cpu_pct} height={3} /></div>
                  <div><span className="text-xs text-slate-400">Memory</span><ProgressBar value={env.memory_pct} height={3} /></div>
                </div>
                <p className="text-xs text-slate-400 mt-1.5">Last deploy: {timeSince(env.last_deployment)}</p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 8: Capacity ──────────────────────────────────────────── */}
      {activeSection === 'capacity' && (
        <Panel title={titleWithIcon('Capacity & Performance Center', BarChart3, `${capacity.pod_count}/${capacity.pod_capacity} pods`)} data-testid="ops-section-capacity">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="CPU"          value={fmtPct(capacity.cpu_current_pct)}     tone={capacity.cpu_current_pct > 80 ? 'danger' : capacity.cpu_current_pct > 65 ? 'warning' : 'success'} testId="ops-cap-cpu" />
            <MetricCard label="Memory"       value={fmtPct(capacity.memory_current_pct)}  tone={capacity.memory_current_pct > 85 ? 'danger' : capacity.memory_current_pct > 70 ? 'warning' : 'success'} testId="ops-cap-mem" />
            <MetricCard label="Storage"      value={fmtPct(capacity.storage_current_pct)} tone={capacity.storage_current_pct > 80 ? 'warning' : 'neutral'} testId="ops-cap-storage" />
            <MetricCard label="DB Load"      value={fmtPct(capacity.db_connections_pct)}  tone={capacity.db_connections_pct > 70 ? 'warning' : 'neutral'} testId="ops-cap-db" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">12-Hour Capacity Trend</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={capChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} domain={[0, 100]} unit="%" />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="CPU" stroke="#6366F1" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Memory" stroke="#10B981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2">
              {[
                { label: 'CPU (Current)', value: capacity.cpu_current_pct, forecast: capacity.cpu_forecast_7d_pct },
                { label: 'Memory (Current)', value: capacity.memory_current_pct, forecast: capacity.memory_forecast_7d_pct },
                { label: 'Storage (Current)', value: capacity.storage_current_pct, forecast: capacity.storage_forecast_7d_pct },
                { label: 'DB Connections', value: capacity.db_connections_pct, forecast: capacity.db_connections_pct + 4 },
                { label: 'Network Bandwidth', value: capacity.network_bandwidth_pct, forecast: capacity.network_bandwidth_pct + 2 },
              ].map(({ label, value, forecast }) => (
                <div key={label}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="text-slate-600">{label}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{fmtPct(value)}</span>
                      <span className="text-slate-400">→ {fmtPct(Math.min(forecast, 99.9))} (7d)</span>
                      {forecast > 80 && <AlertTriangle className="size-3 text-amber-500" aria-hidden />}
                    </div>
                  </div>
                  <ProgressBar value={value} height={5} />
                </div>
              ))}
              {capacity.scale_out_recommended && (
                <div className="p-2 rounded-lg border border-amber-200 bg-amber-50/40 text-xs text-amber-700">
                  <strong>Scale-out recommended</strong> — CPU or Memory exceeding 72%. Add 4 pods to achieve headroom.
                </div>
              )}
              <p className="text-xs text-slate-500">Capacity headroom: <strong className={capacity.capacity_headroom_days < 30 ? 'text-amber-600' : 'text-green-600'}>{capacity.capacity_headroom_days} days</strong> · Queue backlog: {fmtInt(capacity.queue_backlog)}</p>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 9: Security Ops ───────────────────────────────────────── */}
      {activeSection === 'security' && (
        <Panel title={titleWithIcon('Security Operations View', Shield, `Score: ${secOps.security_score}/100`)} data-testid="ops-section-security">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Failed Logins 24h"    value={String(secOps.failed_logins_24h)}     tone={secOps.failed_logins_24h > 20 ? 'warning' : 'neutral'} testId="ops-sec-logins" />
            <MetricCard label="Suspicious Activity"  value={String(secOps.suspicious_activities_24h)} tone={secOps.suspicious_activities_24h > 3 ? 'warning' : 'neutral'} testId="ops-sec-suspicious" />
            <MetricCard label="Critical Vulns"       value={String(secOps.vulnerability_critical)}   tone={secOps.vulnerability_critical > 0 ? 'danger' : 'success'} testId="ops-sec-crit-vuln" />
            <MetricCard label="Patch Compliance"     value={fmtPct(secOps.patch_compliance_pct)}      tone={secOps.patch_compliance_pct >= 95 ? 'success' : 'warning'} testId="ops-sec-patch" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              {[
                { label: 'MFA Compliance', value: secOps.mfa_compliance_pct, target: 100 },
                { label: 'Patch Compliance', value: secOps.patch_compliance_pct, target: 95 },
              ].map(({ label, value, target }) => (
                <div key={label} className="p-2.5 rounded-lg border border-slate-100">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-slate-700">{label}</span>
                    <span className={value >= target ? 'text-green-600 font-medium' : 'text-amber-600 font-medium'}>{fmtPct(value)} (target: {target}%)</span>
                  </div>
                  <ProgressBar value={value} height={5} color={value >= target ? '#10B981' : '#F59E0B'} />
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2 text-xs text-center">
                {[
                  { l: 'Privileged Sessions', v: secOps.privileged_sessions_active, warn: 6 },
                  { l: 'Active Security Incidents', v: secOps.security_incidents_active, warn: 1 },
                  { l: 'Privilege Changes 24h', v: secOps.privilege_changes_24h, warn: 5 },
                  { l: 'High Vulns', v: secOps.vulnerability_high, warn: 3 },
                ].map(({ l, v, warn }) => (
                  <div key={l} className="p-2 rounded-lg border border-slate-100 bg-slate-50/50">
                    <p className={`text-xl font-bold ${v >= warn ? 'text-amber-600' : 'text-slate-700'}`}>{v}</p>
                    <p className="text-slate-500">{l}</p>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Recent Security Events</p>
              <div className="space-y-1.5">
                {secOps.recent_events.map((evt, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-slate-50">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${evt.severity === 'warning' ? 'bg-amber-400' : 'bg-blue-400'}`} />
                    <span className="text-slate-700 flex-1">{evt.event}</span>
                    <span className="text-slate-400 shrink-0">{timeSince(evt.time)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 10: Business Continuity ──────────────────────────────── */}
      {activeSection === 'continuity' && (
        <Panel title={titleWithIcon('Business Continuity Center', ShieldCheck, 'DR Readiness · RTO/RPO')} data-testid="ops-section-continuity">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Backup Status"   value={bcp.backup_status.replace('_', ' ')} tone={bcp.backup_status === 'current' ? 'success' : 'warning'} testId="ops-bcp-backup" />
            <MetricCard label="RTO Tested"      value={`${bcp.rto_tested_min}m`}            tone={bcp.rto_tested_min <= bcp.rto_target_min ? 'success' : 'warning'} testId="ops-bcp-rto" />
            <MetricCard label="RPO Tested"      value={`${bcp.rpo_tested_min}m`}            tone={bcp.rpo_tested_min <= bcp.rpo_target_min ? 'success' : 'warning'} testId="ops-bcp-rpo" />
            <MetricCard label="DR Readiness"    value={bcp.dr_readiness}                    tone={bcp.dr_readiness === 'ready' ? 'success' : 'warning'} testId="ops-bcp-dr" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-2">
              {[
                { label: 'RTO Target', target: bcp.rto_target_min, actual: bcp.rto_tested_min, unit: 'min' },
                { label: 'RPO Target', target: bcp.rpo_target_min, actual: bcp.rpo_tested_min, unit: 'min' },
              ].map(({ label, target, actual, unit }) => (
                <div key={label} className="p-2.5 rounded-lg border border-slate-100">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-slate-700">{label}</span>
                    <span className={actual <= target ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>Tested: {actual}{unit} (Target: {target}{unit})</span>
                  </div>
                  <ProgressBar value={Math.min((target / actual) * 100, 100)} height={5} color={actual <= target ? '#10B981' : '#EF4444'} />
                </div>
              ))}
              <div className="text-xs space-y-1 p-2.5 rounded-lg border border-slate-100 bg-slate-50/50">
                <div className="flex justify-between"><span className="text-slate-500">Last Backup</span><span className="text-slate-700 font-medium">{timeSince(bcp.last_backup_at)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Backup Success Rate</span><span className={bcp.backup_success_rate_pct >= 99 ? 'text-green-600 font-medium' : 'text-amber-600'}>{fmtPct(bcp.backup_success_rate_pct)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Last DR Drill</span><span className="text-slate-700">{bcp.last_dr_drill}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Next DR Drill</span><span className="text-indigo-600">{bcp.next_dr_drill}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">Failover Tested</span><span className={bcp.failover_tested ? 'text-green-600' : 'text-amber-600'}>{bcp.failover_tested ? 'Yes ✓' : 'Pending'}</span></div>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Service Recovery Tiers</p>
              <div className="space-y-1.5">
                {bcp.recovery_tier.map(t => (
                  <div key={t.service} className="flex items-center gap-2 text-xs py-1 border-b border-slate-50">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${t.status === 'ready' ? 'bg-green-400' : t.status === 'partial' ? 'bg-amber-400' : 'bg-slate-300'}`} />
                    <span className="text-slate-700 flex-1 font-medium truncate">{t.service}</span>
                    <span className="text-slate-400">RTO: {t.rto_min}m</span>
                    <span className="text-slate-400">RPO: {t.rpo_min}m</span>
                    <span className={`text-xs ${t.status === 'ready' ? 'text-green-600' : t.status === 'partial' ? 'text-amber-600' : 'text-slate-400'}`}>{t.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 11: Observability ────────────────────────────────────── */}
      {activeSection === 'observability' && (
        <Panel title={titleWithIcon('Observability Dashboard', Network, 'Logs · Metrics · Traces · Alerts')} data-testid="ops-section-observability">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Logs/min"          value={fmtInt(observability.logs_per_min)}      tone="neutral" testId="ops-obs-logs" />
            <MetricCard label="Error Logs/min"    value={String(observability.error_logs_per_min)} tone={observability.error_logs_per_min > 30 ? 'warning' : 'neutral'} testId="ops-obs-errors" />
            <MetricCard label="Traces/min"        value={fmtInt(observability.traces_per_min)}     tone="neutral" testId="ops-obs-traces" />
            <MetricCard label="Active Alerts"     value={String(observability.active_alerts)}      tone={observability.active_alerts > 8 ? 'warning' : 'neutral'} testId="ops-obs-alerts" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Service Dependencies</p>
              <div className="space-y-1.5">
                {observability.service_dependencies.map((dep, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-1.5 border-b border-slate-50">
                    <span className="text-slate-700 font-medium">{dep.from}</span>
                    <ArrowRight className="size-3 text-slate-400" aria-hidden />
                    <span className="text-slate-600">{dep.to}</span>
                    <span className={`ml-auto ${dep.status === 'ok' ? 'text-green-600' : dep.status === 'slow' ? 'text-amber-600' : 'text-red-600'} font-medium`}>{fmtMs(dep.latency_ms)}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${dep.status === 'ok' ? 'bg-green-50 text-green-700' : dep.status === 'slow' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{dep.status}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Top Error Sources</p>
              <div className="space-y-2">
                {observability.top_error_sources.map((src, i) => (
                  <div key={i} className="p-2 rounded-lg border border-slate-100">
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="font-medium text-slate-700">{src.service}</span>
                      <span className={src.error_count > 30 ? 'text-red-600 font-medium' : 'text-amber-600'}>{src.error_count} errors</span>
                    </div>
                    <p className="text-xs text-slate-500 truncate">{src.top_error}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-500 mt-2">Metric anomalies 24h: <strong>{observability.metric_anomalies_24h}</strong> · Alert noise ratio: <strong>{fmtPct(observability.alert_noise_ratio * 100)}</strong></p>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 12: Executive Dashboard ─────────────────────────────── */}
      {activeSection === 'executive' && (
        <Panel title={titleWithIcon('Executive Operations Dashboard', Award, 'Board-level operational intelligence')} data-testid="ops-section-executive">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Platform Availability" value={fmtPct(execOps.platform_availability_pct)} tone="success" testId="ops-exec-avail" />
            <MetricCard label="SLA Compliance"        value={fmtPct(execOps.sla_compliance_pct)}         tone="success" testId="ops-exec-sla" />
            <MetricCard label="Operational Risk"      value={`${execOps.operational_risk_score}/50`}     tone={execOps.operational_risk_score > 35 ? 'warning' : 'success'} testId="ops-exec-risk" />
            <MetricCard label="Service Maturity"      value={`${execOps.service_maturity_score}/100`}    tone={execOps.service_maturity_score >= 80 ? 'success' : 'warning'} testId="ops-exec-maturity" />
          </div>

          <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3 mb-4">
            <p className="text-xs font-semibold text-indigo-700 mb-1 flex items-center gap-1"><Brain className="size-3" aria-hidden /> Executive Narrative</p>
            <p className="text-sm text-slate-700 leading-relaxed">{execOps.executive_narrative}</p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Incident Trend (7 days)</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={execOps.incident_trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="day" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="p1" fill="#EF4444" name="P1" stackId="a" radius={[0,0,0,0]} />
                  <Bar dataKey="p2" fill="#F97316" name="P2" stackId="a" />
                  <Bar dataKey="p3" fill="#F59E0B" name="P3" stackId="a" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">MTTR Trend (last 5 incidents)</p>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={execOps.mttr_trend_min.map((v, i) => ({ n: `INC-${i + 1}`, MTTR: v }))} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="n" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} unit="m" />
                  <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [`${v}m`, 'MTTR']} />
                  <Area type="monotone" dataKey="MTTR" stroke="#6366F1" fill="#6366F1" fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-center">
            {[
              { label: 'Release Success Rate', value: fmtPct(execOps.release_success_rate_pct), good: execOps.release_success_rate_pct >= 95 },
              { label: 'Cost Optimisation Opp.', value: fmtCr(execOps.cost_optimization_opportunity_cr), good: true },
            ].map(({ label, value, good }) => (
              <div key={label} className="p-2.5 rounded-lg border border-slate-100 bg-slate-50/50">
                <p className={`text-xl font-bold ${good ? 'text-slate-700' : 'text-amber-600'}`}>{value}</p>
                <p className="text-slate-500">{label}</p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 13: AI Ops Insights ──────────────────────────────────── */}
      {activeSection === 'ai-insights' && (
        <Panel title={titleWithIcon('AI Operations Insights', Brain, `${aiInsights.length} insights`)} data-testid="ops-section-ai-insights">
          <div className="space-y-3">
            {aiInsights.map(insight => {
              const sevBg = { critical: 'border-l-red-400 bg-red-50/20', warning: 'border-l-amber-400 bg-amber-50/20', info: 'border-l-blue-400 bg-blue-50/20' };
              const typeLabel: Record<string, string> = { failure_prediction: 'Failure Prediction', capacity_forecast: 'Capacity Forecast', incident_hotspot: 'Incident Hotspot', release_risk: 'Release Risk', recommendation: 'Recommendation' };
              return (
                <div key={insight.insight_id} className={`rounded-lg border border-l-4 p-3 ${sevBg[insight.severity]}`} data-testid={`ops-insight-${insight.insight_id}`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">{typeLabel[insight.type]}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium uppercase ${insight.severity === 'critical' ? 'bg-red-100 text-red-700' : insight.severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{insight.severity}</span>
                      <span className="text-sm font-semibold text-slate-800">{insight.title}</span>
                    </div>
                    <span className="text-xs text-indigo-600 font-semibold shrink-0">{Math.round(insight.confidence_score * 100)}%</span>
                  </div>
                  <p className="text-xs text-slate-600 mb-2">{insight.description}</p>
                  <p className="text-xs text-slate-700 flex items-start gap-1.5">
                    <ChevronRight className="size-3 text-green-400 shrink-0 mt-0.5" aria-hidden />
                    <span><strong>Action: </strong>{insight.recommendation}</span>
                  </p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-400">
                    <span>Service: <strong className="text-slate-600">{insight.affected_service}</strong></span>
                    <span>·</span>
                    <span className="text-amber-600">{insight.predicted_impact}</span>
                    <span>·</span>
                    <span>{timeSince(insight.detected_at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ─── Cross-IA footer ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1 border-t border-slate-100">
        <span className="font-medium text-slate-500">Production Operations Center · Phase 23</span>
        <span>·</span>
        {[
          ['/event-streaming-center', 'Event Streaming'],
          ['/board-reporting-center', 'Board Reporting'],
          ['/ai-decisioning-center', 'AI Decisioning'],
          ['/autonomous-risk-center', 'AI Agents'],
          ['/admin/security', 'Security Center'],
          ['/recovery-center', 'Recovery Center'],
          ['/audit-center', 'Audit Center'],
          ['/integration-marketplace', 'Integrations'],
        ].map(([path, label]) => (
          <Link key={path} to={path} className="hover:text-indigo-600 transition-colors">{label}</Link>
        ))}
        <span className="ml-auto text-slate-300">All 23 IA overlays active</span>
      </div>

    </div>
  );
}
