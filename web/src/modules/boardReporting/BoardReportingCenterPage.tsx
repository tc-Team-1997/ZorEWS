// web/src/modules/boardReporting/BoardReportingCenterPage.tsx
//
// Enterprise Reporting & Board Packs Center — Phase 21 IA overlay.
//
// 12 sections: Board Pack Library, Executive KPIs, Board Dashboards,
//   Regulatory Reporting, AI Governance Reports, Compliance Reports,
//   Predictive Reporting, Digital Twin Reports, Autonomous AI Reports,
//   Board Pack Generator, Report Scheduler, Executive Intelligence Summary.
//
// Additive — every existing module untouched.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3,
  Brain, Calendar, CheckCircle2, ChevronRight, Download,
  FileText, Globe, LucideIcon,
  PieChart, Shield, ShieldCheck,
  Sparkles, Target, TrendingDown, TrendingUp, Zap,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  FORECAST_HORIZONS, PACK_METADATA,
  buildAiGovernanceReports, buildAutonomousAiReport,
  buildBoardDashboards, buildBoardPackLibrary,
  buildBoardReportingKpis, buildComplianceSummary,
  buildDigitalTwinReports, buildExecutiveIntelligenceSummary,
  buildExecutiveKpis, buildPredictiveForecasts,
  buildRecentGenerations, buildRegulatoryReports,
  buildReportSchedules, canAccessBoardReportingCenter,
  type ApprovalStatus, type ForecastHorizon, type PackType,
} from './boardReportingEngine';

const ACTIVE_TENANT = 'BANK_DEMO';
const AS_OF = new Date('2026-06-01T12:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtInt(n: number): string { return n.toLocaleString('en-IN'); }
function fmtPct(n: number): string { return (Math.round(n * 10) / 10) + '%'; }
function fmtConf(c: number): string { return Math.round(c * 100) + '%'; }
function fmtCr(n: number): string { return '₹' + (Math.round(n * 10) / 10) + ' Cr'; }

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

function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  const cls: Record<ApprovalStatus, string> = {
    draft:         'bg-slate-100 text-slate-600',
    under_review:  'bg-amber-50 text-amber-700',
    approved:      'bg-green-50 text-green-700',
    distributed:   'bg-indigo-50 text-indigo-700',
    archived:      'bg-purple-50 text-purple-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[status]}`}>{status.replace('_', ' ')}</span>;
}

function TrendIcon({ trend }: { trend: string }) {
  if (trend === 'improving') return <TrendingUp className="size-3.5 text-green-500" aria-hidden />;
  if (trend === 'deteriorating') return <TrendingDown className="size-3.5 text-red-500" aria-hidden />;
  return <span className="text-slate-400 text-xs">─</span>;
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = { within: 'bg-green-400', watch: 'bg-amber-400', breach: 'bg-red-400', healthy: 'bg-green-400', action_required: 'bg-red-400' };
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${colors[status] ?? 'bg-slate-300'}`} />;
}

function SeverityBadge({ level }: { level: string }) {
  const cls: Record<string, string> = { critical: 'bg-red-50 text-red-700', high: 'bg-orange-50 text-orange-700', medium: 'bg-amber-50 text-amber-700', low: 'bg-green-50 text-green-700' };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium uppercase ${cls[level] ?? 'bg-slate-50 text-slate-600'}`}>{level}</span>;
}

const PACK_LABELS: Record<PackType, string> = {
  board_risk: 'Board Risk', executive_risk: 'Exec Risk', cro: 'CRO Pack', ceo: 'CEO Pack',
  cfo: 'CFO Pack', audit_committee: 'Audit Cmte', risk_committee: 'Risk Cmte',
  compliance_committee: 'Compliance Cmte', regulatory_filing: 'Regulatory',
};

const SECTION_TABS = [
  { id: 'packs',       label: 'Board Packs',   icon: FileText },
  { id: 'kpis',        label: 'Exec KPIs',     icon: BarChart3 },
  { id: 'dashboards',  label: 'Dashboards',    icon: PieChart },
  { id: 'regulatory',  label: 'Regulatory',    icon: Shield },
  { id: 'ai-gov',      label: 'AI Governance', icon: Brain },
  { id: 'compliance',  label: 'Compliance',    icon: ShieldCheck },
  { id: 'predictive',  label: 'Forecasts',     icon: Target },
  { id: 'digital-twin', label: 'Digital Twin', icon: Zap },
  { id: 'agents',      label: 'AI Agents',     icon: Activity },
  { id: 'generator',   label: 'Generator',     icon: Download },
  { id: 'scheduler',   label: 'Scheduler',     icon: Calendar },
  { id: 'intel',       label: 'Intelligence',  icon: Sparkles },
];

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function BoardReportingCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessBoardReportingCenter(user.roles)) return <Navigate to="/" replace />;

  const asOf = useMemo(() => AS_OF, []);

  const kpis         = useMemo(() => buildBoardReportingKpis(ACTIVE_TENANT, asOf), [asOf]);
  const packs        = useMemo(() => buildBoardPackLibrary(ACTIVE_TENANT, asOf), [asOf]);
  const execKpis     = useMemo(() => buildExecutiveKpis(ACTIVE_TENANT, asOf), [asOf]);
  const dashboards   = useMemo(() => buildBoardDashboards(ACTIVE_TENANT, asOf), [asOf]);
  const regReports   = useMemo(() => buildRegulatoryReports(ACTIVE_TENANT, asOf), [asOf]);
  const aiReports    = useMemo(() => buildAiGovernanceReports(ACTIVE_TENANT, asOf), [asOf]);
  const compliance   = useMemo(() => buildComplianceSummary(ACTIVE_TENANT, asOf), [asOf]);
  const forecasts    = useMemo(() => buildPredictiveForecasts(ACTIVE_TENANT, asOf), [asOf]);
  const dtReports    = useMemo(() => buildDigitalTwinReports(ACTIVE_TENANT, asOf), [asOf]);
  const agentReport  = useMemo(() => buildAutonomousAiReport(ACTIVE_TENANT, asOf), [asOf]);
  const generations  = useMemo(() => buildRecentGenerations(ACTIVE_TENANT, asOf), [asOf]);
  const schedules    = useMemo(() => buildReportSchedules(ACTIVE_TENANT, asOf), [asOf]);
  const intelligence = useMemo(() => buildExecutiveIntelligenceSummary(ACTIVE_TENANT, asOf), [asOf]);

  const [activeSection, setActiveSection] = useState('intel');
  const [forecastHorizon, setForecastHorizon] = useState<ForecastHorizon>('30d');
  const [forecastDomain, setForecastDomain] = useState<'banking' | 'insurance' | 'enterprise'>('banking');
  const [kpiDomain, setKpiDomain] = useState<'banking' | 'insurance' | 'enterprise'>('banking');

  const activeForecast = forecasts.find(f => f.horizon === forecastHorizon && f.domain === forecastDomain);
  const forecastData = (activeForecast?.banking_forecasts ?? activeForecast?.insurance_forecasts ?? activeForecast?.enterprise_forecasts ?? []);

  const agentPerfData = agentReport.agent_performance.map(a => ({
    name: a.agent.split(' ').slice(-2).join(' '),
    Success: Math.round(a.success_rate * 100),
    Escalations: a.escalations,
  }));

  return (
    <div className="space-y-4" data-testid="board-reporting-center">

      <PageHeader
        title="Enterprise Reporting & Board Packs Center"
        subtitle="Board reporting · Executive intelligence · Regulatory filings · AI governance · Predictive forecasts"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="neutral" className="text-xs">Phase 21</Badge>
            <Badge tone="success" className="text-xs">{kpis.approved_packs}/{kpis.total_packs} Packs Approved</Badge>
            <Badge tone={kpis.overdue_regulatory > 0 ? 'danger' : 'neutral'} className="text-xs">
              {kpis.overdue_regulatory} Overdue Returns
            </Badge>
            <Badge tone="neutral" className="text-xs">Board: {kpis.next_board_meeting}</Badge>
          </div>
        }
      />

      {/* Top KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <MetricCard label="Total Packs"        value={String(kpis.total_packs)}           tone="neutral"  testId="brc-kpi-total" />
        <MetricCard label="Approved"           value={String(kpis.approved_packs)}        tone="success"  testId="brc-kpi-approved" />
        <MetricCard label="Pending Review"     value={String(kpis.pending_approval)}      tone={kpis.pending_approval > 2 ? 'warning' : 'neutral'} testId="brc-kpi-pending" />
        <MetricCard label="Reg. Overdue"       value={String(kpis.overdue_regulatory)}    tone={kpis.overdue_regulatory > 0 ? 'danger' : 'success'} testId="brc-kpi-overdue" />
        <MetricCard label="Scheduled"          value={String(kpis.scheduled_reports)}     tone="neutral"  testId="brc-kpi-sched" />
        <MetricCard label="Compliance Score"   value={String(kpis.compliance_score)}      tone={kpis.compliance_score >= 80 ? 'success' : 'warning'} testId="brc-kpi-compliance" />
        <MetricCard label="Board Health"       value={`${kpis.board_health_score}/100`}   tone={kpis.board_health_score >= 80 ? 'success' : 'warning'} testId="brc-kpi-health" />
        <MetricCard label="AI Confidence"      value={fmtConf(kpis.ai_report_confidence)} tone="success"  testId="brc-kpi-ai-conf" />
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

      {/* ─── Section 1: Board Pack Library ───────────────────────────────── */}
      {activeSection === 'packs' && (
        <Panel title={titleWithIcon('Board Pack Library', FileText, `${packs.length} predefined packs`)} data-testid="brc-section-packs">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {packs.map(pack => (
              <div key={pack.pack_id} className="p-3 rounded-lg border border-slate-100 hover:border-indigo-200 hover:shadow-sm transition-all" data-testid={`brc-pack-${pack.pack_type}`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <p className="text-xs font-semibold text-slate-800">{pack.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{pack.owner} · {pack.review_cycle}</p>
                  </div>
                  <ApprovalBadge status={pack.approval_status} />
                </div>
                <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
                  <span>v{pack.version}</span>
                  <span>·</span>
                  <span>{pack.pages_count} pages</span>
                  <span>·</span>
                  <span>{Math.round(pack.size_kb / 1024 * 10) / 10} MB</span>
                </div>
                <div className="mb-2">
                  <p className="text-xs text-slate-500 mb-1">Sections ({pack.sections.length})</p>
                  <div className="flex flex-wrap gap-1">
                    {pack.sections.slice(0, 3).map(s => (
                      <span key={s} className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 px-1.5 py-0.5 rounded">{s}</span>
                    ))}
                    {pack.sections.length > 3 && <span className="text-xs text-slate-400">+{pack.sections.length - 3}</span>}
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Last: {pack.last_generated}</span>
                  <span>Next: {pack.next_due}</span>
                </div>
                {pack.distribution_list.length > 0 && (
                  <p className="text-xs text-slate-400 mt-1 truncate">To: {pack.distribution_list.join(', ')}</p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 2: Executive KPIs ────────────────────────────────────── */}
      {activeSection === 'kpis' && (
        <Panel title={titleWithIcon('Executive KPI Dashboard', BarChart3, 'Banking · Insurance · Enterprise')} data-testid="brc-section-kpis">
          <div className="flex items-center gap-2 mb-3">
            {(['banking', 'insurance', 'enterprise'] as const).map(d => (
              <button key={d} onClick={() => setKpiDomain(d)} className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${kpiDomain === d ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>
                {d}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['KPI', 'Value', 'Period', 'Trend', 'Status', 'Benchmark'].map(h => (
                    <th key={h} className="py-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {execKpis[kpiDomain].map((kpi, i) => (
                  <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2 pr-4 font-medium text-slate-800">{kpi.kpi}</td>
                    <td className="py-2 pr-4">
                      <span className={`font-bold ${kpi.threshold_status === 'breach' ? 'text-red-600' : kpi.threshold_status === 'watch' ? 'text-amber-600' : 'text-slate-800'}`}>
                        {kpi.value} {kpi.unit}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-slate-500">{kpi.period}</td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-1.5">
                        <TrendIcon trend={kpi.trend} />
                        <span className="text-slate-500">{kpi.change}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={kpi.threshold_status} />
                        <span className="capitalize text-slate-600">{kpi.threshold_status}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-slate-400">{kpi.benchmark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 3: Board Dashboards ──────────────────────────────────── */}
      {activeSection === 'dashboards' && (
        <Panel title={titleWithIcon('Board Dashboards', PieChart, `${dashboards.length} live dashboards`)} data-testid="brc-section-dashboards">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {dashboards.map(d => (
              <div key={d.dashboard_id} className="p-3 rounded-lg border border-slate-100 hover:border-indigo-200 transition-all" data-testid={`brc-dash-${d.dashboard_id}`}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="text-xs font-semibold text-slate-800">{d.title}</p>
                    <p className="text-xs text-slate-500">{d.category}</p>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${d.status === 'live' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>{d.status}</span>
                </div>
                <p className="text-xs text-slate-500 mb-2 line-clamp-2">{d.description}</p>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500">{d.kpi_count} KPIs · {d.alert_count} alerts</span>
                  <span className={`font-semibold ${d.health_score >= 85 ? 'text-green-600' : 'text-amber-600'}`}>Health: {d.health_score}</span>
                </div>
                <p className="text-xs text-slate-400 mt-1 truncate">Viewers: {d.viewers.join(', ')}</p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 4: Regulatory Reporting ─────────────────────────────── */}
      {activeSection === 'regulatory' && (
        <Panel title={titleWithIcon('Regulatory Reporting', Shield, `${regReports.length} tracked returns`)} data-testid="brc-section-regulatory">
          {regReports.filter(r => r.submission_status === 'due_soon' || r.submission_status === 'overdue').length > 0 && (
            <div className="mb-3 p-2.5 rounded-lg border border-amber-200 bg-amber-50 flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-500 shrink-0" aria-hidden />
              <p className="text-xs text-amber-700">
                <strong>{regReports.filter(r => r.submission_status === 'due_soon').length}</strong> returns due soon ·
                <strong className="ml-1 text-red-700">{regReports.filter(r => r.submission_status === 'overdue').length}</strong> overdue
              </p>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Report', 'Framework', 'Domain', 'Frequency', 'Status', 'Due Date', 'Last Filed', 'Authority'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {regReports.map(r => (
                  <tr key={r.report_id} className={`border-b border-slate-50 hover:bg-slate-50 ${r.submission_status === 'overdue' ? 'bg-red-50/30' : r.submission_status === 'due_soon' ? 'bg-amber-50/30' : ''}`}>
                    <td className="py-1.5 pr-3 font-medium text-slate-700 max-w-48 truncate">{r.report_name}</td>
                    <td className="py-1.5 pr-3"><span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs font-medium">{r.framework}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500 capitalize">{r.domain}</td>
                    <td className="py-1.5 pr-3 text-slate-500 capitalize">{r.frequency}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`text-xs font-medium ${r.submission_status === 'filed' ? 'text-green-600' : r.submission_status === 'due_soon' ? 'text-amber-600' : r.submission_status === 'overdue' ? 'text-red-600 font-bold' : 'text-slate-500'}`}>
                        {r.submission_status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600">{r.due_date}</td>
                    <td className="py-1.5 pr-3 text-slate-400">{r.last_filed}</td>
                    <td className="py-1.5 pr-3 text-slate-400 max-w-32 truncate">{r.filing_authority}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 5: AI Governance Reports ─────────────────────────────── */}
      {activeSection === 'ai-gov' && (
        <Panel title={titleWithIcon('AI Governance Reports', Brain, `${aiReports.length} reports`)} data-testid="brc-section-ai-gov">
          <div className="space-y-3">
            {aiReports.map(report => (
              <div key={report.report_id} className={`p-3 rounded-lg border ${report.overall_status === 'action_required' ? 'border-red-200 bg-red-50/20' : report.overall_status === 'watch' ? 'border-amber-200 bg-amber-50/20' : 'border-slate-100 hover:border-indigo-200'} transition-colors`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{report.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{report.period_label} · {report.generated_at.slice(0, 10)} · Confidence: {fmtConf(0.9)}</p>
                  </div>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${report.overall_status === 'healthy' ? 'bg-green-50 text-green-700' : report.overall_status === 'watch' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{report.overall_status.replace('_', ' ')}</span>
                </div>
                <p className="text-xs text-slate-600 mb-2">{report.summary}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                  {report.key_metrics.map(m => (
                    <div key={m.metric} className={`p-1.5 rounded text-center ${m.status === 'good' ? 'bg-green-50' : m.status === 'fair' ? 'bg-amber-50' : 'bg-red-50'}`}>
                      <p className={`text-xs font-bold ${m.status === 'good' ? 'text-green-700' : m.status === 'fair' ? 'text-amber-700' : 'text-red-700'}`}>{m.value}</p>
                      <p className="text-xs text-slate-500">{m.metric}</p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-0.5">
                  {report.recommendations.map((rec, i) => (
                    <p key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                      <ChevronRight className="size-3 text-indigo-400 shrink-0 mt-0.5" aria-hidden />
                      {rec}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* ─── Section 6: Compliance Reports ───────────────────────────────── */}
      {activeSection === 'compliance' && (
        <Panel title={titleWithIcon('Compliance Reports', ShieldCheck, `Score: ${compliance.compliance_score}/100`)} data-testid="brc-section-compliance">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Open Obligations"    value={String(compliance.open_obligations)}      tone="neutral" testId="brc-comp-obligations" />
            <MetricCard label="Active Breaches"     value={String(compliance.breaches_active)}       tone={compliance.breaches_active > 5 ? 'danger' : 'warning'} testId="brc-comp-breaches" />
            <MetricCard label="Pending Escalations" value={String(compliance.escalations_pending)}   tone={compliance.escalations_pending > 0 ? 'warning' : 'neutral'} testId="brc-comp-escalations" />
            <MetricCard label="Open Audit Findings" value={String(compliance.audit_findings_open)}   tone={compliance.audit_findings_open > 10 ? 'warning' : 'neutral'} testId="brc-comp-audit" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Active Breaches</p>
              <div className="space-y-2">
                {compliance.top_breaches.map((b, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 rounded-lg border border-slate-100">
                    <SeverityBadge level={b.severity.toLowerCase()} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-800 truncate">{b.obligation}</p>
                      <p className="text-xs text-slate-500">{b.days_open} days open · {b.owner}</p>
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-xs font-semibold text-slate-700 mt-3 mb-2">Upcoming Obligations</p>
              <div className="space-y-1.5">
                {compliance.upcoming_obligations.map((o, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-slate-50">
                    <span className="text-slate-700 font-medium">{o.obligation}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">{o.due_date}</span>
                      <SeverityBadge level={o.risk.toLowerCase()} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Remediation Plans</p>
              <div className="space-y-2">
                {compliance.remediation_plans.map(plan => (
                  <div key={plan.plan_id} className={`p-2.5 rounded-lg border ${plan.status === 'completed' ? 'border-green-100 bg-green-50/30' : plan.status === 'delayed' ? 'border-red-100 bg-red-50/30' : 'border-slate-100'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-700">{plan.plan_id}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${plan.status === 'completed' ? 'bg-green-100 text-green-700' : plan.status === 'on_track' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{plan.status.replace('_', ' ')}</span>
                    </div>
                    <p className="text-xs text-slate-600">{plan.description}</p>
                    <p className="text-xs text-slate-400 mt-0.5">Target: {plan.target_date}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 7: Predictive Reporting ──────────────────────────────── */}
      {activeSection === 'predictive' && (
        <Panel title={titleWithIcon('Predictive Forecasts', Target, `${FORECAST_HORIZONS.length} horizons`)} data-testid="brc-section-predictive">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <div className="flex gap-1.5">
              {(['banking', 'insurance', 'enterprise'] as const).map(d => (
                <button key={d} onClick={() => setForecastDomain(d)} className={`px-2.5 py-1 rounded-full text-xs border transition-colors capitalize ${forecastDomain === d ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>{d}</button>
              ))}
            </div>
            <div className="flex gap-1.5">
              {FORECAST_HORIZONS.map(h => (
                <button key={h} onClick={() => setForecastHorizon(h)} className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${forecastHorizon === h ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300'}`}>{h}</button>
              ))}
            </div>
            {activeForecast && (
              <span className="text-xs text-slate-400">Scenario: {activeForecast.scenario_label} · Confidence: {fmtConf(activeForecast.confidence_score)}</span>
            )}
          </div>

          {activeForecast && forecastData.length > 0 && (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={forecastData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="metric" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} formatter={(v: number) => [v.toFixed(2), 'Value']} />
                  <Bar dataKey="current" name="Current" fill="#94A3B8" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="projected" name="Projected" radius={[2, 2, 0, 0]}>
                    {forecastData.map((entry, i) => (
                      <Cell key={i} fill={entry.risk_flag ? '#EF4444' : '#6366F1'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-slate-500 border-b border-slate-100">{['Metric', 'Current', 'Projected', 'Change', 'Risk'].map(h => <th key={h} className="py-2 pr-3 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {forecastData.map((f, i) => (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="py-1.5 pr-3 font-medium text-slate-700">{f.metric}</td>
                        <td className="py-1.5 pr-3 text-slate-600">{f.current.toFixed(2)}</td>
                        <td className={`py-1.5 pr-3 font-medium ${f.risk_flag ? 'text-red-600' : 'text-slate-800'}`}>{f.projected.toFixed(2)}</td>
                        <td className={`py-1.5 pr-3 font-medium ${f.change_pp > 0 ? (f.risk_flag ? 'text-red-600' : 'text-amber-600') : 'text-green-600'}`}>
                          {f.change_pp > 0 ? '+' : ''}{f.change_pp.toFixed(2)}pp
                        </td>
                        <td className="py-1.5">{f.risk_flag ? <AlertTriangle className="size-4 text-red-500" aria-hidden /> : <CheckCircle2 className="size-4 text-green-500" aria-hidden />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 p-2.5 rounded-lg border border-amber-100 bg-amber-50/40">
                <p className="text-xs font-semibold text-amber-700 mb-1">Key Forecast Risks</p>
                {activeForecast.key_risks.map((risk, i) => (
                  <p key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                    <AlertTriangle className="size-3 text-amber-400 shrink-0 mt-0.5" aria-hidden /> {risk}
                  </p>
                ))}
              </div>
            </>
          )}
        </Panel>
      )}

      {/* ─── Section 8: Digital Twin Reports ──────────────────────────────── */}
      {activeSection === 'digital-twin' && (
        <Panel title={titleWithIcon('Digital Twin Simulation Reports', Zap, `${dtReports.length} reports`)} data-testid="brc-section-digital-twin">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {dtReports.map(report => {
              const stressColors = { mild: 'border-blue-200 bg-blue-50/30', moderate: 'border-amber-200 bg-amber-50/30', severe: 'border-red-200 bg-red-50/30' };
              return (
                <div key={report.report_id} className={`p-3 rounded-lg border ${stressColors[report.stress_level]}`} data-testid={`brc-dt-${report.report_id}`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-xs font-semibold text-slate-800">{report.title}</p>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium uppercase ${report.stress_level === 'severe' ? 'bg-red-100 text-red-700' : report.stress_level === 'moderate' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{report.stress_level}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mb-2 text-xs text-center">
                    <div className="p-1.5 bg-white/60 rounded"><p className="font-bold text-slate-800">{report.scenarios_included}</p><p className="text-slate-500">Scenarios</p></div>
                    <div className="p-1.5 bg-white/60 rounded"><p className="font-bold text-red-600">+{report.worst_case_npa_impact_pp}pp</p><p className="text-slate-500">NPA Impact</p></div>
                    <div className="p-1.5 bg-white/60 rounded"><p className="font-bold text-red-600">₹{(report.worst_case_ecl_increase_cr / 100).toFixed(1)}Cr</p><p className="text-slate-500">ECL Increase</p></div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-slate-600"><span className="font-medium">Action: </span>{report.recommended_action}</p>
                    <p className="text-xs text-indigo-600"><span className="font-medium">Board: </span>{report.board_recommendation}</p>
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5">Confidence: {fmtConf(report.confidence)} · {report.generated_at.slice(0, 10)}</p>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ─── Section 9: Autonomous AI Reports ────────────────────────────── */}
      {activeSection === 'agents' && (
        <Panel title={titleWithIcon('Autonomous AI Agent Reports', Activity, agentReport.period_label)} data-testid="brc-section-agents">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Total Executions"  value={fmtInt(agentReport.total_agent_executions)}    tone="neutral"  testId="brc-agent-execs" />
            <MetricCard label="Automation Rate"   value={fmtPct(agentReport.automation_rate_pct)}       tone="success"  testId="brc-agent-auto" />
            <MetricCard label="Human Overrides"   value={fmtInt(agentReport.human_override_count)}      tone="neutral"  testId="brc-agent-overrides" />
            <MetricCard label="Cost Savings"      value={fmtCr(agentReport.cost_savings_cr)}            tone="success"  testId="brc-agent-savings" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Agent Performance (Success Rate %)</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={agentPerfData} layout="vertical" margin={{ top: 4, right: 8, left: 60, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 9 }} unit="%" />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={60} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Success" fill="#10B981" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Top Automated Actions</p>
              <div className="space-y-2">
                {agentReport.top_automated_actions.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="w-5 h-5 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-700 font-medium truncate">{a.action}</p>
                      <p className="text-slate-400">{fmtInt(a.count)} actions · {a.savings_hours}h saved</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs font-semibold text-slate-700 mt-3 mb-2">Override Reasons</p>
              {agentReport.escalation_reasons.map((r, i) => (
                <div key={i} className="flex items-center gap-2 mb-1.5">
                  <span className="text-xs text-slate-600 flex-1 truncate">{r.reason}</span>
                  <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-amber-400" style={{ width: `${r.percentage}%` }} />
                  </div>
                  <span className="text-xs text-slate-500 w-8 text-right">{r.percentage}%</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 10: Generator ────────────────────────────────────────── */}
      {activeSection === 'generator' && (
        <Panel title={titleWithIcon('Board Pack Generator', Download, 'PDF · Excel · CSV')} data-testid="brc-section-generator">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-1">
              <p className="text-xs font-semibold text-slate-700 mb-2">Generate New Pack</p>
              <div className="space-y-2">
                <div className="p-2.5 rounded-lg border border-slate-200 space-y-2">
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Pack Type</label>
                    <div className="flex flex-wrap gap-1">
                      {(['board_risk', 'cro', 'ceo', 'cfo', 'audit_committee'] as PackType[]).map(t => (
                        <span key={t} className="text-xs px-1.5 py-0.5 bg-indigo-50 text-indigo-700 border border-indigo-100 rounded cursor-pointer hover:bg-indigo-100">{PACK_LABELS[t]}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 block mb-1">Format</label>
                    <div className="flex gap-1.5">
                      {(['pdf', 'excel', 'csv'] as const).map(f => (
                        <span key={f} className="text-xs px-2 py-0.5 bg-slate-50 text-slate-700 border border-slate-200 rounded uppercase cursor-pointer hover:bg-slate-100">{f}</span>
                      ))}
                    </div>
                  </div>
                  <button className="w-full px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 transition-colors flex items-center justify-center gap-1.5">
                    <Download className="size-3" aria-hidden />
                    Generate Now
                  </button>
                </div>
              </div>
            </div>

            <div className="lg:col-span-2">
              <p className="text-xs font-semibold text-slate-700 mb-2">Recent Generations</p>
              <div className="space-y-2">
                {generations.map(gen => (
                  <div key={gen.request_id} className="flex items-center gap-3 p-2.5 rounded-lg border border-slate-100 hover:bg-slate-50">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-800">{PACK_METADATA[gen.pack_type].title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{gen.version} · {gen.requested_by} · {gen.requested_at.slice(0, 10)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${gen.status === 'ready' ? 'bg-green-50 text-green-700' : gen.status === 'generating' ? 'bg-blue-50 text-blue-700' : 'bg-slate-50 text-slate-600'}`}>{gen.status}</span>
                      {gen.status === 'ready' && (
                        <div className="flex gap-1">
                          {gen.formats.map(f => (
                            <button key={f} className="p-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-100 text-xs uppercase">{f}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 11: Scheduler ────────────────────────────────────────── */}
      {activeSection === 'scheduler' && (
        <Panel title={titleWithIcon('Report Scheduler', Calendar, `${schedules.filter(s => s.is_active).length} active schedules`)} data-testid="brc-section-scheduler">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Report', 'Frequency', 'Next Run', 'Last Run', 'Last Status', 'Success %', 'Failures', 'Recipients', 'Active'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedules.map(s => (
                  <tr key={s.schedule_id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-1.5 pr-3 font-medium text-slate-700 max-w-36 truncate">{s.report_name}</td>
                    <td className="py-1.5 pr-3 text-slate-500 capitalize">{s.frequency}</td>
                    <td className="py-1.5 pr-3 text-slate-600">{s.next_run}</td>
                    <td className="py-1.5 pr-3 text-slate-400">{s.last_run}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`text-xs font-medium ${s.last_run_status === 'success' ? 'text-green-600' : 'text-red-600'}`}>{s.last_run_status}</span>
                    </td>
                    <td className="py-1.5 pr-3"><span className={s.success_rate_pct >= 98 ? 'text-green-600 font-medium' : 'text-amber-600'}>{fmtPct(s.success_rate_pct)}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500">{s.failure_count_30d}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{s.recipients_count}</td>
                    <td className="py-1.5">
                      <span className={`inline-block w-4 h-4 rounded-full ${s.is_active ? 'bg-green-400' : 'bg-slate-300'}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 12: Executive Intelligence ───────────────────────────── */}
      {activeSection === 'intel' && (
        <Panel title={titleWithIcon('Executive Intelligence Summary', Sparkles, `Confidence: ${fmtConf(intelligence.confidence_score)} · Board Health: ${intelligence.board_health_score}/100`)} data-testid="brc-section-intel">
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3 mb-4">
            <div className="flex items-start gap-2">
              <Brain className="size-4 text-indigo-400 shrink-0 mt-0.5" aria-hidden />
              <p className="text-sm text-slate-700 leading-relaxed">{intelligence.executive_narrative}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="size-3.5 text-red-400" aria-hidden /> Top Risks
                </p>
                {intelligence.top_risks.map(risk => (
                  <div key={risk.rank} className="flex items-start gap-2 mb-2 p-2 rounded-lg border border-slate-100">
                    <span className="w-5 h-5 rounded-full bg-red-100 text-red-700 text-xs flex items-center justify-center font-bold shrink-0">{risk.rank}</span>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-slate-800">{risk.title}</span>
                        <SeverityBadge level={risk.severity} />
                        <span className="text-xs text-slate-400">{risk.domain}</span>
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">{risk.summary}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div>
                <p className="text-xs font-semibold text-green-700 mb-1.5 flex items-center gap-1.5">
                  <TrendingUp className="size-3.5" aria-hidden /> Top Opportunities
                </p>
                {intelligence.top_opportunities.map((o, i) => (
                  <p key={i} className="text-xs text-slate-600 flex items-start gap-1.5 mb-1">
                    <ArrowRight className="size-3 text-green-400 shrink-0 mt-0.5" aria-hidden /> {o}
                  </p>
                ))}
              </div>

              <div>
                <p className="text-xs font-semibold text-amber-700 mb-1.5 flex items-center gap-1.5">
                  <Globe className="size-3.5" aria-hidden /> Emerging Threats
                </p>
                {intelligence.emerging_threats.map((t, i) => (
                  <p key={i} className="text-xs text-slate-600 flex items-start gap-1.5 mb-1">
                    <ChevronRight className="size-3 text-amber-400 shrink-0 mt-0.5" aria-hidden /> {t}
                  </p>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold text-slate-700 mb-1.5">Forecast Highlights</p>
                {intelligence.forecast_highlights.map((f, i) => (
                  <p key={i} className="text-xs text-slate-600 flex items-start gap-1.5 mb-1 p-1.5 bg-slate-50 rounded">
                    <Target className="size-3 text-indigo-400 shrink-0 mt-0.5" aria-hidden /> {f}
                  </p>
                ))}
              </div>

              <div>
                <p className="text-xs font-semibold text-slate-700 mb-2">Recommended Actions</p>
                {intelligence.recommended_actions.map((a, i) => (
                  <div key={i} className={`p-2 rounded-lg border mb-1.5 ${a.priority === 'immediate' ? 'border-red-100 bg-red-50/30' : a.priority === 'this_week' ? 'border-amber-100 bg-amber-50/20' : 'border-slate-100'}`}>
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium uppercase ${a.priority === 'immediate' ? 'bg-red-100 text-red-700' : a.priority === 'this_week' ? 'bg-amber-100 text-amber-700' : 'bg-blue-50 text-blue-700'}`}>{a.priority.replace('_', ' ')}</span>
                      <span className="text-xs text-slate-500">→ {a.owner}</span>
                    </div>
                    <p className="text-xs text-slate-700">{a.action}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Cross-IA footer ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1 border-t border-slate-100">
        <span className="font-medium text-slate-500">Board Reporting Center · Phase 21</span>
        <span>·</span>
        {[
          ['/ai-decisioning-center', 'AI Decisioning'],
          ['/autonomous-risk-center', 'AI Agents'],
          ['/digital-twin-center', 'Digital Twin'],
          ['/integration-marketplace', 'Integrations'],
          ['/regulatory-compliance-center', 'Compliance'],
          ['/predictive-risk-center', 'Predictive Risk'],
          ['/executive-cockpit', 'Exec Cockpit'],
          ['/audit-center', 'Audit Center'],
        ].map(([path, label]) => (
          <Link key={path} to={path} className="hover:text-indigo-600 transition-colors">{label}</Link>
        ))}
        <span className="ml-auto text-slate-300">All 21 IA overlays active</span>
      </div>

    </div>
  );
}
