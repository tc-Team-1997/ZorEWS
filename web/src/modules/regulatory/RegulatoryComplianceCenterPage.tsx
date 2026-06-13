// web/src/modules/regulatory/RegulatoryComplianceCenterPage.tsx
//
// Regulatory Compliance Center — landing page.
//
// 13th IA addition this session. Additive overlay — every existing module
// untouched (Audit Center / Governance / IAM / Rule / AI Governance /
// Recovery / Predictive Risk / Investigation / Executive Cockpit /
// Role-Based Dashboard / Security Activity). Mounted at
// /regulatory-compliance-center. Gated inside the page; sidebar visible
// to admin / supervisor / risk_analyst.
//
// Sections rendered:
//   1. Regulatory Command Center            — KPI strip + audit-readiness chip
//   2. Banking + Insurance Compliance       — split-tab framework cards
//   3. Obligation Registry                  — filterable table (40 obligations × tenant)
//   4. Compliance Monitoring + Heatmap      — open findings + framework heatmap
//   5. Regulatory Reporting Hub             — RBI / Basel / AML / KYC / IRDAI / Solvency / Fraud / Exec reports + export
//   6. Regulatory Calendar                  — filing deadlines + review cycles
//   7. Compliance Workflow                  — 5-state workflow items + 6 actions
//   8. AI Compliance Assistant              — gaps + upcoming risks + recommendations + exception analysis
//   9. Executive Compliance Dashboard       — health score + risk score + trend + regulator breakdown
//
// Production wire-up (BFF): replaces deterministic engine resolvers with
// GET /regulatory-compliance-center, GET /compliance-obligations,
// GET /compliance-findings, GET /regulatory-reports, POST /compliance-review,
// POST /compliance-action, POST /report-export. Shape stays stable.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3, Briefcase, Calendar,
  CheckCircle2, ChevronRight, ClipboardList, Crown, FileBadge2,
  FileBarChart, FileCheck, FileText, Filter, Gauge, Gavel, GitBranch,
  Lightbulb, ListChecks, LucideIcon, Megaphone, Microscope, Radar, Radio,
  Search, Shield, ShieldAlert, ShieldCheck, Sparkles, Target, Timer,
  TrendingDown, TrendingUp, Users, XCircle,
} from 'lucide-react';
import {
  AreaChart, Area, Bar, BarChart, CartesianGrid, Cell, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { ExportButton } from '@/components/export/ExportButton';
import { buildRegulatoryReportData } from './regulatoryReportAdapter';
import {
  BANKING_FRAMEWORKS,
  COMPLIANCE_WORKFLOW_ACTIONS,
  COMPLIANCE_WORKFLOW_STATUSES,
  FINDING_SEVERITIES,
  INSURANCE_FRAMEWORKS,
  OBLIGATION_CATEGORIES,
  OBLIGATION_STATUSES,
  REGULATORY_FRAMEWORKS,
  REPORT_FORMATS,
  REPORT_KINDS,
  canAccessRegulatoryCenter,
  listComplianceItems,
  listObligations,
  type ComplianceWorkflowStatus,
  type FindingSeverity,
  type FindingStatus,
  type ObligationCategory,
  type ObligationStatus,
  type RegulatoryDomain,
  type ReportFormat,
  type ReportKind,
} from './regulatoryFrameworkEngine';
import {
  buildComplianceCommandCenter,
  buildComplianceHeatmap,
  listFindings,
} from './complianceMonitoring';
import {
  buildReportingHubSummary,
  listRegulatoryCalendar,
  listRegulatoryReports,
  requestReportExport,
} from './regulatoryReportingHub';
import {
  buildAIComplianceReport,
  buildExecutiveComplianceDashboard,
} from './aiComplianceAssistant';

const ACTIVE_TENANT = 'BANK_DEMO';
const ACTOR = 'compliance.lead';

const SEVERITY_TONE: Record<FindingSeverity, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  moderate: 'warning',
  high: 'warning',
  severe: 'danger',
  critical: 'danger',
};

const OBLIGATION_STATUS_TONE: Record<ObligationStatus, 'success' | 'warning' | 'danger' | 'blue' | 'neutral'> = {
  compliant: 'success',
  at_risk: 'warning',
  overdue: 'danger',
  in_review: 'blue',
  closed: 'neutral',
};

const FINDING_STATUS_TONE: Record<FindingStatus, 'success' | 'warning' | 'danger' | 'blue' | 'neutral'> = {
  open: 'danger',
  in_progress: 'warning',
  remediated: 'success',
  accepted_risk: 'blue',
  closed: 'neutral',
};

const WORKFLOW_STATUS_TONE: Record<ComplianceWorkflowStatus, 'success' | 'warning' | 'danger' | 'blue' | 'purple' | 'neutral'> = {
  draft: 'neutral',
  under_review: 'warning',
  approved: 'success',
  submitted: 'blue',
  closed: 'neutral',
};

const URGENCY_TONE: Record<'upcoming' | 'due_soon' | 'due_today' | 'overdue', 'success' | 'warning' | 'danger' | 'blue'> = {
  upcoming: 'success',
  due_soon: 'warning',
  due_today: 'warning',
  overdue: 'danger',
};

function titleWithIcon(label: string, icon: LucideIcon, sub?: string): ReactNode {
  const Icon = icon;
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-orange-400" aria-hidden />
      <span>{label}</span>
      {sub && <span className="text-xs font-normal text-slate-400 ml-2">{sub}</span>}
    </span>
  );
}

function fmtPct(v: number): string {
  return `${Math.round(v)}%`;
}

function fmtPct01(v: number): string {
  return `${Math.round(v * 100)}%`;
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export function RegulatoryComplianceCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessRegulatoryCenter(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const asOf = useMemo(() => new Date(), []);
  const [domainTab, setDomainTab] = useState<'all' | RegulatoryDomain>('all');
  const [statusFilter, setStatusFilter] = useState<ObligationStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<ObligationCategory | 'all'>('all');
  const [findingSeverityFilter, setFindingSeverityFilter] = useState<FindingSeverity | 'all'>('all');
  const [reportKindFilter, setReportKindFilter] = useState<ReportKind | 'all'>('all');
  const [exportReceipt, setExportReceipt] = useState<{
    report_id: string;
    format: ReportFormat;
    status: string;
    estimated_ready_at: string;
  } | null>(null);

  const allObligations = useMemo(() => listObligations(ACTIVE_TENANT, asOf), [asOf]);
  const filteredObligations = useMemo(() => {
    return allObligations.filter((ob) => {
      if (domainTab !== 'all' && ob.domain !== domainTab) return false;
      if (statusFilter !== 'all' && ob.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && ob.category !== categoryFilter) return false;
      return true;
    });
  }, [allObligations, domainTab, statusFilter, categoryFilter]);

  const command = useMemo(() => buildComplianceCommandCenter(ACTIVE_TENANT, asOf), [asOf]);
  const heatmap = useMemo(() => buildComplianceHeatmap(ACTIVE_TENANT, asOf), [asOf]);
  const findings = useMemo(() => {
    const all = listFindings(ACTIVE_TENANT, asOf);
    return findingSeverityFilter === 'all' ? all : all.filter((f) => f.severity === findingSeverityFilter);
  }, [asOf, findingSeverityFilter]);

  const reportsAll = useMemo(() => listRegulatoryReports(ACTIVE_TENANT, asOf), [asOf]);
  const reports = useMemo(
    () => reportKindFilter === 'all' ? reportsAll : reportsAll.filter((r) => r.kind === reportKindFilter),
    [reportsAll, reportKindFilter],
  );
  const reportingSummary = useMemo(() => buildReportingHubSummary(ACTIVE_TENANT, asOf), [asOf]);
  const calendar = useMemo(() => listRegulatoryCalendar(ACTIVE_TENANT, asOf, 60), [asOf]);

  const items = useMemo(() => listComplianceItems(ACTIVE_TENANT, asOf), [asOf]);

  const aiReport = useMemo(() => buildAIComplianceReport(ACTIVE_TENANT, asOf), [asOf]);
  const execDash = useMemo(() => buildExecutiveComplianceDashboard(ACTIVE_TENANT, asOf), [asOf]);

  const bankingHeatmap = heatmap.filter((c) => c.domain === 'banking');
  const insuranceHeatmap = heatmap.filter((c) => c.domain === 'insurance');

  const handleExport = (report_id: string, format: ReportFormat) => {
    const receipt = requestReportExport(
      { tenant_id: ACTIVE_TENANT, report_id, format, requested_by: ACTOR },
      asOf,
    );
    setExportReceipt({
      report_id: receipt.report_id,
      format: receipt.format,
      status: receipt.status,
      estimated_ready_at: receipt.estimated_ready_at,
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Regulatory Compliance Center"
        subtitle="Central control tower for regulatory monitoring + compliance tracking + audit readiness + reporting — banking + insurance, with AI compliance assistant + executive dashboard."
        actions={
          <div className="flex items-center gap-2">
            <ExportButton
              module="regulatory_center"
              reportType="compliance"
              adapter={(config) =>
                buildRegulatoryReportData(
                  {
                    command: {
                      compliance_health_score: command.compliance_health_score,
                      total_obligations: command.total_obligations,
                      open_findings: command.open_findings,
                      regulatory_breaches: command.regulatory_breaches,
                      sla_violations: command.sla_violations,
                      high_risk_obligations: command.high_risk_obligations,
                      pending_actions: command.pending_actions,
                      audit_readiness: command.audit_readiness,
                    },
                    obligations: filteredObligations.map((ob) => ({
                      obligation_id: ob.obligation_id,
                      regulation: ob.regulation,
                      framework: ob.framework,
                      category: ob.category,
                      owner: ob.owner,
                      priority: ob.priority,
                      status: ob.status,
                      next_due_date: ob.next_due_date,
                    })),
                    meta: { tenant_id: ACTIVE_TENANT, generated_by: user?.username ?? 'operator', role: user?.roles?.[0] ?? 'admin' },
                  },
                  config,
                )
              }
            />
            <Badge tone="warning"><Gavel className="size-3 mr-1 inline" />Regulatory</Badge>
            <Badge tone="neutral">Tenant: {ACTIVE_TENANT}</Badge>
            <Badge
              tone={
                command.audit_readiness === 'ready'
                  ? 'success'
                  : command.audit_readiness === 'needs_attention'
                  ? 'warning'
                  : 'danger'
              }
            >
              Audit: {command.audit_readiness.replace('_', ' ')}
            </Badge>
          </div>
        }
      />

      {/* 1. Command Center KPIs */}
      <Panel title={titleWithIcon('Regulatory command center', Gauge)} data-testid="reg-section-command">
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-3 mb-3">
          <MetricCard label="Total obligations" value={String(command.total_obligations)} testId="kpi-total-obligations" />
          <MetricCard label="Open findings" value={String(command.open_findings)} tone={command.open_findings > 0 ? 'warning' : 'success'} testId="kpi-open-findings" />
          <MetricCard label="Regulatory breaches" value={String(command.regulatory_breaches)} tone={command.regulatory_breaches > 0 ? 'danger' : 'success'} testId="kpi-breaches" />
          <MetricCard label="SLA violations" value={String(command.sla_violations)} tone={command.sla_violations > 0 ? 'danger' : 'success'} testId="kpi-sla" />
          <MetricCard label="Audit findings" value={String(command.audit_findings)} testId="kpi-audit-findings" />
          <MetricCard label="Pending actions" value={String(command.pending_actions)} tone={command.pending_actions > 0 ? 'warning' : 'success'} testId="kpi-pending" />
          <MetricCard label="High-risk obligations" value={String(command.high_risk_obligations)} tone={command.high_risk_obligations > 0 ? 'warning' : 'success'} testId="kpi-high-risk" />
          <MetricCard
            label="Health score"
            value={fmtPct(command.compliance_health_score)}
            sub={`risk ${fmtPct(command.regulatory_risk_score)}`}
            tone={command.compliance_health_score >= 80 ? 'success' : command.compliance_health_score >= 50 ? 'warning' : 'danger'}
            testId="kpi-health"
          />
        </div>
        <div className="text-xs text-slate-400 flex flex-wrap gap-2">
          {OBLIGATION_STATUSES.map((s) => (
            <span key={s} className="font-mono">
              <Badge tone={OBLIGATION_STATUS_TONE[s]}>{s}</Badge> {command.by_status[s] ?? 0}
            </span>
          ))}
        </div>
      </Panel>

      {/* 2. Banking + Insurance Frameworks */}
      <Panel
        title={titleWithIcon('Banking + Insurance frameworks', Shield, `${REGULATORY_FRAMEWORKS.length} frameworks tracked`)}
        data-testid="reg-section-frameworks"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div data-testid="frameworks-banking">
            <div className="text-xs uppercase tracking-wider text-blue-300 font-mono mb-2 flex items-center gap-1">
              <Activity className="size-3" /> Banking ({BANKING_FRAMEWORKS.length})
            </div>
            <ul className="space-y-1 text-xs">
              {bankingHeatmap.map((cell) => (
                <li key={cell.framework} data-testid={`framework-cell-${cell.framework}`} className="flex justify-between items-center border-b border-slate-900/50 py-1.5">
                  <div className="min-w-0">
                    <div className="text-slate-200 font-medium truncate">{cell.framework}</div>
                    <div className="text-slate-500 font-mono text-[10px]">
                      {cell.total_obligations} oblig · {cell.open_findings} findings · {cell.breaches} breaches
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-orange-300 font-bold tabular-nums">{fmtPct(cell.health_score)}</div>
                    <Badge tone={cell.band === 'green' ? 'success' : cell.band === 'amber' ? 'warning' : 'danger'}>{cell.band}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div data-testid="frameworks-insurance">
            <div className="text-xs uppercase tracking-wider text-teal-300 font-mono mb-2 flex items-center gap-1">
              <Shield className="size-3" /> Insurance ({INSURANCE_FRAMEWORKS.length})
            </div>
            <ul className="space-y-1 text-xs">
              {insuranceHeatmap.map((cell) => (
                <li key={cell.framework} data-testid={`framework-cell-${cell.framework}`} className="flex justify-between items-center border-b border-slate-900/50 py-1.5">
                  <div className="min-w-0">
                    <div className="text-slate-200 font-medium truncate">{cell.framework}</div>
                    <div className="text-slate-500 font-mono text-[10px]">
                      {cell.total_obligations} oblig · {cell.open_findings} findings · {cell.breaches} breaches
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-orange-300 font-bold tabular-nums">{fmtPct(cell.health_score)}</div>
                    <Badge tone={cell.band === 'green' ? 'success' : cell.band === 'amber' ? 'warning' : 'danger'}>{cell.band}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      {/* 3. Obligation Registry (filterable table) */}
      <Panel
        title={titleWithIcon('Obligation registry', ClipboardList, `${filteredObligations.length} of ${allObligations.length} obligations`)}
        action={
          <div className="flex gap-1.5 flex-wrap">
            {(['all', 'banking', 'insurance'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDomainTab(d)}
                data-testid={`obligation-domain-${d}`}
                className={`px-2.5 py-0.5 rounded text-xs font-medium transition border ${
                  d === domainTab
                    ? 'bg-orange-500/15 text-orange-300 border-orange-500'
                    : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        }
        data-testid="reg-section-obligations"
      >
        <div className="flex gap-1.5 flex-wrap mb-3 text-xs">
          <span className="text-slate-500 mr-1">Status:</span>
          {(['all', ...OBLIGATION_STATUSES] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              data-testid={`obligation-status-${s}`}
              className={`px-2 py-0.5 rounded font-medium transition border ${
                s === statusFilter
                  ? 'bg-orange-500/15 text-orange-300 border-orange-500'
                  : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
              }`}
            >
              {s}
            </button>
          ))}
          <span className="text-slate-500 ml-3 mr-1">Category:</span>
          {(['all', ...OBLIGATION_CATEGORIES] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategoryFilter(c)}
              data-testid={`obligation-category-${c}`}
              className={`px-2 py-0.5 rounded font-medium transition border ${
                c === categoryFilter
                  ? 'bg-orange-500/15 text-orange-300 border-orange-500'
                  : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">ID</th>
                <th className="text-left py-2 px-3">Regulation</th>
                <th className="text-left py-2 px-3">Framework</th>
                <th className="text-left py-2 px-3">Clause</th>
                <th className="text-left py-2 px-3">Category</th>
                <th className="text-left py-2 px-3">Frequency</th>
                <th className="text-left py-2 px-3">Owner</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-left py-2 px-3">Priority</th>
                <th className="text-left py-2 px-3">Last review</th>
                <th className="text-left py-2 px-3">Next due</th>
              </tr>
            </thead>
            <tbody>
              {filteredObligations.slice(0, 16).map((ob) => (
                <tr key={ob.obligation_id} data-testid={`obligation-row-${ob.obligation_id}`} className="border-b border-slate-900/50 hover:bg-slate-900/30 transition">
                  <td className="py-1.5 px-3 font-mono text-xs text-slate-300">{ob.obligation_id}</td>
                  <td className="py-1.5 px-3 text-slate-200">{ob.regulation}</td>
                  <td className="py-1.5 px-3 text-slate-400 font-mono text-xs">{ob.framework}</td>
                  <td className="py-1.5 px-3 text-slate-400 font-mono text-xs">{ob.clause}</td>
                  <td className="py-1.5 px-3 text-slate-400 capitalize text-xs">{ob.category.replace('_', ' ')}</td>
                  <td className="py-1.5 px-3 text-slate-400 capitalize text-xs">{ob.review_frequency.replace('_', ' ')}</td>
                  <td className="py-1.5 px-3 text-slate-300 font-mono text-xs">{ob.owner}</td>
                  <td className="py-1.5 px-3"><Badge tone={OBLIGATION_STATUS_TONE[ob.status]}>{ob.status}</Badge></td>
                  <td className="py-1.5 px-3"><Badge tone={SEVERITY_TONE[ob.priority]}>{ob.priority}</Badge></td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{ob.last_review_date}</td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{ob.next_due_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredObligations.length === 0 && (
            <div className="text-center text-slate-400 py-6 text-sm">No obligations match the current filters.</div>
          )}
        </div>
      </Panel>

      {/* 4. Compliance Findings */}
      <Panel
        title={titleWithIcon('Compliance findings', ShieldAlert, `${findings.length} of ${listFindings(ACTIVE_TENANT, asOf).length} findings`)}
        action={
          <div className="flex gap-1.5 flex-wrap">
            <span className="text-xs text-slate-500 self-center mr-1">Severity:</span>
            {(['all', ...FINDING_SEVERITIES] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setFindingSeverityFilter(s)}
                data-testid={`finding-severity-${s}`}
                className={`px-2 py-0.5 rounded text-xs font-medium transition border ${
                  s === findingSeverityFilter
                    ? 'bg-orange-500/15 text-orange-300 border-orange-500'
                    : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        }
        data-testid="reg-section-findings"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">ID</th>
                <th className="text-left py-2 px-3">Title</th>
                <th className="text-left py-2 px-3">Framework</th>
                <th className="text-left py-2 px-3">Severity</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-left py-2 px-3">Owner</th>
                <th className="text-left py-2 px-3">Identified</th>
                <th className="text-left py-2 px-3">Due</th>
              </tr>
            </thead>
            <tbody>
              {findings.slice(0, 12).map((f) => (
                <tr key={f.finding_id} data-testid={`finding-row-${f.finding_id}`} className="border-b border-slate-900/50">
                  <td className="py-1.5 px-3 font-mono text-xs text-slate-300">{f.finding_id}</td>
                  <td className="py-1.5 px-3 text-slate-200">{f.title}</td>
                  <td className="py-1.5 px-3 text-slate-400 font-mono text-xs">{f.framework}</td>
                  <td className="py-1.5 px-3"><Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge></td>
                  <td className="py-1.5 px-3"><Badge tone={FINDING_STATUS_TONE[f.status]}>{f.status}</Badge></td>
                  <td className="py-1.5 px-3 text-slate-300 font-mono text-xs">{f.owner}</td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{f.identified_at}</td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{f.due_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 5. Regulatory Reporting Hub */}
      <Panel
        title={titleWithIcon('Regulatory reporting hub', FileBarChart, `${reportingSummary.total_reports} reports · ${reportingSummary.reports_due_30d} due 30d · ${reportingSummary.reports_overdue} overdue`)}
        action={
          <div className="flex gap-1.5 flex-wrap">
            {(['all', ...REPORT_KINDS] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setReportKindFilter(k)}
                data-testid={`report-kind-${k}`}
                className={`px-2 py-0.5 rounded text-xs font-medium transition border ${
                  k === reportKindFilter
                    ? 'bg-orange-500/15 text-orange-300 border-orange-500'
                    : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        }
        data-testid="reg-section-reports"
      >
        {exportReceipt && (
          <div className="mb-2 text-xs text-emerald-300 bg-emerald-950/30 border border-emerald-500/30 rounded p-2" data-testid="export-receipt">
            Export queued: <span className="font-mono">{exportReceipt.report_id}</span> as <strong>{exportReceipt.format}</strong> · {exportReceipt.status} · ready ~ {exportReceipt.estimated_ready_at}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">ID</th>
                <th className="text-left py-2 px-3">Report</th>
                <th className="text-left py-2 px-3">Kind</th>
                <th className="text-left py-2 px-3">Regulator</th>
                <th className="text-left py-2 px-3">Frequency</th>
                <th className="text-left py-2 px-3">Pages</th>
                <th className="text-left py-2 px-3">Next due</th>
                <th className="text-left py-2 px-3">Export</th>
              </tr>
            </thead>
            <tbody>
              {reports.slice(0, 12).map((r) => (
                <tr key={r.report_id} data-testid={`report-row-${r.report_id}`} className="border-b border-slate-900/50">
                  <td className="py-1.5 px-3 font-mono text-xs text-slate-300">{r.report_id}</td>
                  <td className="py-1.5 px-3 text-slate-200">{r.label}</td>
                  <td className="py-1.5 px-3"><Badge tone="warning">{r.kind}</Badge></td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{r.regulator}</td>
                  <td className="py-1.5 px-3 text-slate-400 capitalize text-xs">{r.frequency.replace('_', ' ')}</td>
                  <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">{r.page_count}</td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{r.next_due_at}</td>
                  <td className="py-1.5 px-3">
                    <div className="flex gap-1">
                      {REPORT_FORMATS.map((fmt) => (
                        <button
                          key={fmt}
                          type="button"
                          onClick={() => handleExport(r.report_id, fmt)}
                          data-testid={`export-${r.report_id}-${fmt}`}
                          className="px-2 py-0.5 rounded bg-slate-900/40 text-slate-300 hover:bg-orange-500/15 hover:text-orange-300 border border-slate-700 hover:border-orange-500 text-[10px] font-medium font-mono uppercase transition"
                        >
                          {fmt}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 6. Regulatory Calendar */}
      <Panel
        title={titleWithIcon('Regulatory calendar', Calendar, `${calendar.length} entries in next 60 days`)}
        data-testid="reg-section-calendar"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-xs">
          {(['overdue', 'due_today', 'due_soon', 'upcoming'] as const).map((u) => {
            const count = calendar.filter((c) => c.urgency === u).length;
            return (
              <div key={u} data-testid={`calendar-bucket-${u}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
                <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{u.replace('_', ' ')}</div>
                <div className={`text-xl font-bold tabular-nums ${u === 'overdue' ? 'text-red-400' : u === 'due_soon' || u === 'due_today' ? 'text-orange-300' : 'text-emerald-300'}`}>{count}</div>
              </div>
            );
          })}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">Title</th>
                <th className="text-left py-2 px-3">Kind</th>
                <th className="text-left py-2 px-3">Framework</th>
                <th className="text-left py-2 px-3">Owner</th>
                <th className="text-left py-2 px-3">Due</th>
                <th className="text-left py-2 px-3">Days until</th>
                <th className="text-left py-2 px-3">Urgency</th>
              </tr>
            </thead>
            <tbody>
              {calendar.slice(0, 12).map((c) => (
                <tr key={c.calendar_entry_id} data-testid={`calendar-row-${c.calendar_entry_id}`} className="border-b border-slate-900/50">
                  <td className="py-1.5 px-3 text-slate-200">{c.title}</td>
                  <td className="py-1.5 px-3 text-slate-400 capitalize text-xs">{c.entry_kind.replace('_', ' ')}</td>
                  <td className="py-1.5 px-3 text-slate-400 font-mono text-xs">{c.framework ?? '—'}</td>
                  <td className="py-1.5 px-3 text-slate-300 font-mono text-xs">{c.owner}</td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{c.due_date}</td>
                  <td className="py-1.5 px-3 text-slate-300 tabular-nums text-xs">{c.days_until_due}d</td>
                  <td className="py-1.5 px-3"><Badge tone={URGENCY_TONE[c.urgency]}>{c.urgency.replace('_', ' ')}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 7. Compliance Workflow */}
      <Panel
        title={titleWithIcon('Compliance workflow', GitBranch, `${items.length} items in lifecycle`)}
        data-testid="reg-section-workflow"
      >
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3 text-xs">
          {COMPLIANCE_WORKFLOW_STATUSES.map((s) => {
            const count = items.filter((it) => it.status === s).length;
            return (
              <div key={s} data-testid={`workflow-bucket-${s}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
                <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{s.replace('_', ' ')}</div>
                <div className="text-xl font-bold text-white tabular-nums">{count}</div>
              </div>
            );
          })}
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3" data-testid="workflow-actions">
          <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Workflow actions</div>
          <div className="flex flex-wrap gap-1.5">
            {COMPLIANCE_WORKFLOW_ACTIONS.map((a) => (
              <button
                key={a}
                type="button"
                data-testid={`workflow-action-${a}`}
                className="px-2.5 py-1 rounded bg-slate-900/40 text-slate-300 hover:bg-orange-500/15 hover:text-orange-300 border border-slate-700 hover:border-orange-500 text-xs font-medium transition flex items-center gap-1"
              >
                {a} <ChevronRight className="size-3" />
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">ID</th>
                <th className="text-left py-2 px-3">Title</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-left py-2 px-3">Owner</th>
                <th className="text-left py-2 px-3">Reviewer</th>
                <th className="text-left py-2 px-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 10).map((it) => (
                <tr key={it.item_id} data-testid={`workflow-row-${it.item_id}`} className="border-b border-slate-900/50">
                  <td className="py-1.5 px-3 font-mono text-xs text-slate-300">{it.item_id}</td>
                  <td className="py-1.5 px-3 text-slate-200">{it.title}</td>
                  <td className="py-1.5 px-3"><Badge tone={WORKFLOW_STATUS_TONE[it.status]}>{it.status.replace('_', ' ')}</Badge></td>
                  <td className="py-1.5 px-3 text-slate-300 font-mono text-xs">{it.owner}</td>
                  <td className="py-1.5 px-3 text-slate-400 font-mono text-xs">{it.reviewer ?? '—'}</td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{it.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 8. AI Compliance Assistant */}
      <Panel
        title={titleWithIcon('AI compliance assistant', Lightbulb, `${aiReport.model_id} v${aiReport.model_version} · ${fmtPct01(aiReport.confidence)} conf`)}
        data-testid="reg-section-ai"
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-orange-300 font-mono mb-2 flex items-center gap-1">
              <Target className="size-3" /> Compliance gaps ({aiReport.compliance_gaps.length})
            </div>
            <ul className="space-y-1 text-xs">
              {aiReport.compliance_gaps.map((g) => (
                <li key={g.gap_id} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-slate-200 font-medium">{g.title}</span>
                    <Badge tone={SEVERITY_TONE[g.severity]}>{g.severity}</Badge>
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">{g.description}</div>
                  <div className="text-slate-500 font-mono text-[10px]">{g.framework} · owner: {g.recommended_owner}</div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-orange-300 font-mono mb-2 flex items-center gap-1">
              <TrendingUp className="size-3" /> Upcoming risks ({aiReport.upcoming_risks.length})
            </div>
            <ul className="space-y-1 text-xs">
              {aiReport.upcoming_risks.map((r) => (
                <li key={r.risk_id} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-slate-200 font-medium">{r.title}</span>
                    <Badge tone={SEVERITY_TONE[r.impact]}>{r.impact}</Badge>
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">{r.description}</div>
                  <div className="text-slate-500 font-mono text-[10px]">prob {fmtPct01(r.probability)} · {r.horizon_days}d</div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-orange-300 font-mono mb-2 flex items-center gap-1">
              <ListChecks className="size-3" /> Recommendations ({aiReport.recommendations.length})
            </div>
            <ul className="space-y-1 text-xs">
              {aiReport.recommendations.map((rec) => (
                <li key={rec.recommendation_id} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-slate-200 font-medium">{rec.title}</span>
                    <Badge tone={rec.priority === 'high' ? 'danger' : rec.priority === 'medium' ? 'warning' : 'success'}>{rec.priority}</Badge>
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">{rec.description}</div>
                  <div className="text-slate-500 font-mono text-[10px]">category: {rec.category} · target: {rec.target_framework ?? '—'}</div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-orange-300 font-mono mb-2 flex items-center gap-1">
              <AlertTriangle className="size-3" /> Exception analysis ({aiReport.exception_analysis.length})
            </div>
            <ul className="space-y-1 text-xs">
              {aiReport.exception_analysis.map((e) => (
                <li key={e.exception_id} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-slate-200 font-medium font-mono text-xs">{e.obligation_id}</span>
                    <span className="text-slate-400 font-mono text-xs">freq 30d: {e.frequency_30d}</span>
                  </div>
                  <div className="text-slate-500 text-[11px] mt-0.5">{e.recommended_action}</div>
                  <div className="text-slate-500 font-mono text-[10px]">{e.framework} · reason: {e.reason.replace('_', ' ')} · last seen {e.last_seen_at}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      {/* 9. Executive Compliance Dashboard */}
      <Panel
        title={titleWithIcon('Executive compliance dashboard', Crown, `health ${fmtPct(execDash.compliance_health_score)} · risk ${fmtPct(execDash.regulatory_risk_score)} · audit ${execDash.audit_readiness.replace('_', ' ')}`)}
        data-testid="reg-section-exec"
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <MetricCard
            label="Health score"
            value={fmtPct(execDash.compliance_health_score)}
            tone={execDash.compliance_health_score >= 80 ? 'success' : execDash.compliance_health_score >= 50 ? 'warning' : 'danger'}
            testId="exec-kpi-health"
          />
          <MetricCard
            label="Regulatory risk"
            value={fmtPct(execDash.regulatory_risk_score)}
            tone={execDash.regulatory_risk_score >= 60 ? 'danger' : execDash.regulatory_risk_score >= 30 ? 'warning' : 'success'}
            testId="exec-kpi-risk"
          />
          <MetricCard label="Open findings" value={String(execDash.open_findings)} testId="exec-kpi-findings" />
          <MetricCard
            label="Upcoming deadlines"
            value={String(execDash.upcoming_deadlines_count)}
            sub={`pending actions ${execDash.pending_actions}`}
            testId="exec-kpi-deadlines"
          />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Compliance trend (30 days)</div>
            <div className="h-40 w-full">
              <ResponsiveContainer>
                <AreaChart data={execDash.compliance_trend_30d} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="day_offset" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={28} domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="health_score" stroke="#10B981" fill="rgba(16,185,129,0.2)" name="Health" />
                  <Area type="monotone" dataKey="risk_score" stroke="#F97316" fill="rgba(249,115,22,0.2)" name="Risk" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Top obligations at risk</div>
            <ul className="text-xs space-y-1.5">
              {execDash.top_obligations_at_risk.map((ob) => (
                <li key={ob.obligation_id} data-testid={`exec-obligation-${ob.obligation_id}`} className="flex items-start justify-between gap-2 border-b border-slate-900/50 py-1.5">
                  <div className="min-w-0">
                    <div className="text-slate-200 font-medium truncate">{ob.regulation}</div>
                    <div className="text-slate-500 font-mono text-[10px]">{ob.obligation_id} · {ob.framework} · {ob.domain}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge tone={ob.priority === 'high' || ob.priority === 'critical' ? 'danger' : ob.priority === 'medium' ? 'warning' : 'success'}>{ob.priority}</Badge>
                    <div className={`text-xs mt-0.5 tabular-nums ${ob.days_until_due < 0 ? 'text-red-400' : 'text-slate-400'}`}>{ob.days_until_due}d</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
          <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Regulator breakdown</div>
          <table className="w-full text-xs">
            <thead className="text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-1 px-2">Regulator</th>
                <th className="text-right py-1 px-2">Obligations</th>
                <th className="text-right py-1 px-2">Open findings</th>
                <th className="text-right py-1 px-2">Breaches</th>
              </tr>
            </thead>
            <tbody>
              {execDash.regulator_breakdown.map((b) => (
                <tr key={b.regulator} data-testid={`exec-regulator-${b.regulator}`} className="border-b border-slate-900/50">
                  <td className="py-1 px-2 text-slate-200">{b.regulator}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{b.total_obligations}</td>
                  <td className="py-1 px-2 text-right text-orange-300 tabular-nums">{b.open_findings}</td>
                  <td className="py-1 px-2 text-right text-red-400 tabular-nums">{b.breaches}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Cross-IA footer */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1">
        <span>Cross-IA:</span>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/audit-center">Audit Center</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/admin/governance">Governance</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/investigation-center">Investigations</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/predictive-risk-center">Predictive Risk</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/recovery-center">Recovery</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/executive-cockpit">Executive Cockpit</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/cms/cases">CMS Cases</Link>
      </div>
    </div>
  );
}

// silence unused-import warnings for icons reserved for future expansion
void ArrowRight; void Briefcase; void FileCheck; void FileText; void Filter;
void Megaphone; void Microscope; void Radar; void Radio; void Search;
void ShieldCheck; void Sparkles; void Timer; void TrendingDown; void Users;
void XCircle; void CheckCircle2; void FileBadge2; void BarChart3; void Bar;
void BarChart; void Cell;
