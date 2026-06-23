// web/src/modules/investigation/InvestigationCenterPage.tsx
//
// Investigation Center — landing page.
//
// 12th IA addition this session. Additive overlay — existing CMS modules
// (CmsCaseListPage / CmsCaseKanbanPage / CmsCaseDetailPage / CaseWorkflowPage /
// CaseTrackingTimeline / CaseCausalAnalysisPage) untouched. Mounted at
// /investigation-center. Gated inside the page; sidebar entry visible to
// admin / supervisor / risk_analyst.
//
// Sections rendered:
//   1. Case Command Center             — unified ops KPI strip + status/severity/domain breakdowns
//   2. Investigation List              — table view of all 32 synthetic investigations w/ filter chips
//   3. Investigation Workspace         — full per-case workspace (timeline + evidence + AI + workflow)
//   4. Evidence Vault                  — chain-of-custody view for the selected investigation
//   5. AI Investigator                 — root-cause + related entities + drivers + recommendations
//   6. Investigation Analytics         — resolution time + productivity + volume trend + KPIs
//   7. Executive Investigation View    — top open + critical + fraud exposure
//
// Production wire-up (BFF): replaces the deterministic engine resolvers with
// GET /investigations, GET /investigations/:id, POST /investigations,
// PUT /investigations/:id, POST /investigations/:id/{assign,evidence,note,escalate,close}.
// Shape stays stable.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3, Briefcase, CheckCircle2,
  ChevronRight, ClipboardList, Crown, FileCheck, FileLock2, FileText,
  Gauge, GitBranch, Lightbulb, ListChecks, LucideIcon, Megaphone,
  Microscope, Radio, Search, Shield, ShieldAlert, ShieldCheck, Sparkles,
  Target, Timer, TrendingDown, TrendingUp, Users, XCircle,
} from 'lucide-react';
import {
  AreaChart, Area, Bar, BarChart, CartesianGrid, Cell, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ExportButton } from '@/components/export/ExportButton';
import { buildInvestigationsReportData } from './investigationsReportAdapter';
import { useAuth } from '@/store/auth';
import {
  BANKING_INVESTIGATION_KINDS,
  INSURANCE_INVESTIGATION_KINDS,
  INVESTIGATION_STATUSES,
  INVESTIGATION_SEVERITIES,
  buildCaseCommandCenter,
  canAccessInvestigationCenter,
  listInvestigations,
  type Investigation,
  type InvestigationSeverity,
  type InvestigationStatus,
  type InvestigationDomain,
} from './investigationEngine';
import {
  evidenceVaultSummary,
  listEvidence,
  verifyEvidence,
} from './evidenceVault';
import { buildAIInvestigationReport } from './aiInvestigator';
import {
  buildExecutiveInvestigationView,
  buildInvestigationAnalytics,
} from './investigationAnalytics';
import { fmtKES } from '@/lib/currency';

const ACTIVE_TENANT = 'BANK_DEMO';

const STATUS_TONE: Record<InvestigationStatus, 'success' | 'warning' | 'danger' | 'blue' | 'purple' | 'neutral'> = {
  open: 'blue',
  assigned: 'blue',
  in_review: 'warning',
  pending_approval: 'purple',
  escalated: 'danger',
  closed: 'success',
};

const SEVERITY_TONE: Record<InvestigationSeverity, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  moderate: 'warning',
  high: 'warning',
  severe: 'danger',
  critical: 'danger',
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

// Canonical formatter — delegates to @/lib/currency fmtKES
function fmtKes(n: number): string { return fmtKES(n); }

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

function ageDays(opened_at: string, asOf: Date): number {
  const ms = asOf.getTime() - new Date(opened_at).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export function InvestigationCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessInvestigationCenter(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const asOf = useMemo(() => new Date(), []);
  const [statusFilter, setStatusFilter] = useState<InvestigationStatus | 'all'>('all');
  const [domainFilter, setDomainFilter] = useState<InvestigationDomain | 'all'>('all');
  const [severityFilter, setSeverityFilter] = useState<InvestigationSeverity | 'all'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const allInvestigations = useMemo(() => listInvestigations(ACTIVE_TENANT, asOf), [asOf]);
  const filtered = useMemo(() => {
    return allInvestigations.filter((inv) => {
      if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
      if (domainFilter !== 'all' && inv.domain !== domainFilter) return false;
      if (severityFilter !== 'all' && inv.severity !== severityFilter) return false;
      return true;
    });
  }, [allInvestigations, statusFilter, domainFilter, severityFilter]);

  // Default selection — first row of the filtered set (or the unfiltered set fallback)
  const selected = useMemo<Investigation | null>(() => {
    if (selectedId) {
      const hit = allInvestigations.find((i) => i.investigation_id === selectedId);
      if (hit) return hit;
    }
    return filtered[0] ?? allInvestigations[0] ?? null;
  }, [selectedId, filtered, allInvestigations]);

  const command = useMemo(() => buildCaseCommandCenter(ACTIVE_TENANT, asOf), [asOf]);
  const vaultSummary = useMemo(() => evidenceVaultSummary(ACTIVE_TENANT, asOf), [asOf]);
  const analytics = useMemo(() => buildInvestigationAnalytics(ACTIVE_TENANT, asOf), [asOf]);
  const execView = useMemo(() => buildExecutiveInvestigationView(ACTIVE_TENANT, asOf), [asOf]);

  // Selected-case derived data
  const evidence = useMemo(
    () => (selected ? listEvidence(selected.investigation_id, ACTIVE_TENANT, asOf) : []),
    [selected, asOf],
  );
  const aiReport = useMemo(
    () =>
      selected
        ? buildAIInvestigationReport(
            selected.investigation_id,
            ACTIVE_TENANT,
            selected.kind,
            selected.domain,
            asOf,
          )
        : null,
    [selected, asOf],
  );

  // Banking / Insurance specialised investigation rows (separate panel)
  const bankingRows = useMemo(
    () => allInvestigations.filter((i) => i.domain === 'banking').slice(0, 6),
    [allInvestigations],
  );
  const insuranceRows = useMemo(
    () => allInvestigations.filter((i) => i.domain === 'insurance').slice(0, 6),
    [allInvestigations],
  );

  // Status colour mapping for the by-status bar chart
  const statusBars = INVESTIGATION_STATUSES.map((s) => ({
    status: s,
    count: command.by_status[s] ?? 0,
  }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Investigation Center"
        subtitle="Enterprise investigation + case intelligence command center — banking + insurance, with evidence vault, AI investigator, workflow engine, and executive view."
        actions={
          <div className="flex items-center gap-2">
            {/* Enterprise export (P2) — RBAC-gated; renders null without
                reports:export. Reports the post-filter Investigation list +
                the Case Command Center KPI strip. */}
            <ExportButton
              module="investigations"
              reportType="case"
              adapter={(config) =>
                buildInvestigationsReportData(
                  {
                    command: {
                      total_cases: command.total_cases,
                      open_cases: command.open_cases,
                      critical_cases: command.critical_cases,
                      high_risk_cases: command.high_risk_cases,
                      escalated_cases: command.escalated_cases,
                      sla_breached_cases: command.sla_breached_cases,
                      fraud_cases: command.fraud_cases,
                      resolution_rate: command.resolution_rate,
                    },
                    investigations: filtered.map((i) => ({
                      investigation_id: i.investigation_id,
                      title: i.title,
                      domain: i.domain,
                      kind: i.kind,
                      status: i.status,
                      severity: i.severity,
                      assignee_username: i.assignee_username,
                      exposure_kes: i.exposure_kes,
                      due_at: i.due_at,
                      opened_at: i.opened_at,
                    })),
                    meta: { tenant_id: ACTIVE_TENANT, generated_by: user?.username ?? 'operator', role: user?.roles?.[0] ?? 'admin' },
                  },
                  config,
                )
              }
            />
            <Badge tone="warning"><Microscope className="size-3 mr-1 inline" />Investigation</Badge>
            <Badge tone="neutral">Tenant: {ACTIVE_TENANT}</Badge>
          </div>
        }
      />

      {/* 1. Case Command Center */}
      <Panel
        title={titleWithIcon('Case command center', Gauge)}
        data-testid="inv-section-command"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-3 mb-4">
          <MetricCard label="Total cases" value={String(command.total_cases)} testId="kpi-total" />
          <MetricCard label="Open" value={String(command.open_cases)} testId="kpi-open" />
          <MetricCard label="Critical" value={String(command.critical_cases)} tone={command.critical_cases > 0 ? 'danger' : 'success'} testId="kpi-critical" />
          <MetricCard label="High risk" value={String(command.high_risk_cases)} tone={command.high_risk_cases > 0 ? 'warning' : 'success'} testId="kpi-high-risk" />
          <MetricCard label="Escalated" value={String(command.escalated_cases)} tone={command.escalated_cases > 0 ? 'danger' : 'success'} testId="kpi-escalated" />
          <MetricCard label="SLA breached" value={String(command.sla_breached_cases)} tone={command.sla_breached_cases > 0 ? 'danger' : 'success'} testId="kpi-sla" />
          <MetricCard label="Fraud" value={String(command.fraud_cases)} tone={command.fraud_cases > 0 ? 'warning' : 'success'} testId="kpi-fraud" />
          <MetricCard label="Resolution rate" value={fmtPct(command.resolution_rate)} sub={`${command.investigation_backlog} backlog`} testId="kpi-resolution" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 font-mono">By status</div>
            <div className="h-48 w-full">
              <ResponsiveContainer>
                <BarChart data={statusBars} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="status" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={28} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Bar dataKey="count" fill="#F97316">
                    {statusBars.map((row, idx) => (
                      <Cell key={idx} fill={row.status === 'escalated' ? '#EF4444' : row.status === 'closed' ? '#10B981' : '#F97316'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2 font-mono">Banking vs Insurance</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-blue-500/40 bg-blue-950/20 p-3" data-testid="domain-tile-banking">
                <div className="text-xs uppercase tracking-wider text-blue-300 font-mono">Banking</div>
                <div className="text-3xl font-bold text-white tabular-nums">{command.banking_cases}</div>
                <div className="text-xs text-slate-400 mt-1">cases under investigation</div>
              </div>
              <div className="rounded-lg border border-teal-500/40 bg-teal-950/20 p-3" data-testid="domain-tile-insurance">
                <div className="text-xs uppercase tracking-wider text-teal-300 font-mono">Insurance</div>
                <div className="text-3xl font-bold text-white tabular-nums">{command.insurance_cases}</div>
                <div className="text-xs text-slate-400 mt-1">cases under investigation</div>
              </div>
            </div>
            <div className="mt-3 text-xs text-slate-400">
              By severity:
              {INVESTIGATION_SEVERITIES.map((s) => (
                <span key={s} className="ml-2 font-mono">
                  <Badge tone={SEVERITY_TONE[s]}>{s}</Badge>{' '}
                  <span className="text-slate-300">{command.by_severity[s] ?? 0}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* 2. Investigation list with filters */}
      <Panel
        title={titleWithIcon('Investigation list', ClipboardList, `${filtered.length} of ${allInvestigations.length} cases`)}
        action={
          <div className="flex gap-1.5 flex-wrap">
            {(['all', ...INVESTIGATION_STATUSES] as const).map((s) => {
              const active = s === statusFilter;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  data-testid={`filter-status-${s}`}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition ${
                    active
                      ? 'bg-orange-500/15 text-orange-300 border border-orange-500'
                      : 'bg-slate-900/40 text-slate-400 border border-slate-700 hover:border-orange-500/60'
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
        }
        data-testid="inv-section-list"
      >
        <div className="flex gap-1.5 flex-wrap mb-3 text-xs">
          <span className="text-slate-500 mr-1">Domain:</span>
          {(['all', 'banking', 'insurance'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDomainFilter(d)}
              data-testid={`filter-domain-${d}`}
              className={`px-2 py-0.5 rounded font-medium transition ${
                d === domainFilter
                  ? 'bg-orange-500/15 text-orange-300 border border-orange-500'
                  : 'bg-slate-900/40 text-slate-400 border border-slate-700 hover:border-orange-500/60'
              }`}
            >
              {d}
            </button>
          ))}
          <span className="text-slate-500 ml-3 mr-1">Severity:</span>
          {(['all', ...INVESTIGATION_SEVERITIES] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSeverityFilter(s)}
              data-testid={`filter-severity-${s}`}
              className={`px-2 py-0.5 rounded font-medium transition ${
                s === severityFilter
                  ? 'bg-orange-500/15 text-orange-300 border border-orange-500'
                  : 'bg-slate-900/40 text-slate-400 border border-slate-700 hover:border-orange-500/60'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">ID</th>
                <th className="text-left py-2 px-3">Title</th>
                <th className="text-left py-2 px-3">Domain</th>
                <th className="text-left py-2 px-3">Kind</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-left py-2 px-3">Severity</th>
                <th className="text-left py-2 px-3">Assignee</th>
                <th className="text-right py-2 px-3">Exposure</th>
                <th className="text-left py-2 px-3">Due</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 16).map((inv) => {
                const isSelected = inv.investigation_id === selected?.investigation_id;
                return (
                  <tr
                    key={inv.investigation_id}
                    data-testid={`inv-row-${inv.investigation_id}`}
                    onClick={() => setSelectedId(inv.investigation_id)}
                    className={`border-b border-slate-900/50 cursor-pointer transition ${
                      isSelected ? 'bg-orange-950/30' : 'hover:bg-slate-900/30'
                    }`}
                  >
                    <td className="py-2 px-3 font-mono text-xs text-slate-300">{inv.investigation_id}</td>
                    <td className="py-2 px-3 text-slate-200 font-medium">{inv.title}</td>
                    <td className="py-2 px-3 text-slate-400 capitalize">{inv.domain}</td>
                    <td className="py-2 px-3 text-slate-400 font-mono text-xs">{inv.kind}</td>
                    <td className="py-2 px-3"><Badge tone={STATUS_TONE[inv.status]}>{inv.status}</Badge></td>
                    <td className="py-2 px-3"><Badge tone={SEVERITY_TONE[inv.severity]}>{inv.severity}</Badge></td>
                    <td className="py-2 px-3 text-slate-300 text-xs font-mono">{inv.assignee_username ?? '—'}</td>
                    <td className="py-2 px-3 text-right text-slate-200 tabular-nums">{fmtKes(inv.exposure_kes)}</td>
                    <td className="py-2 px-3 text-slate-400 text-xs">{fmtDate(inv.due_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="text-center py-6 text-slate-400 text-sm">No investigations match the current filters.</div>
          )}
        </div>
      </Panel>

      {/* 3. Investigation Workspace (per selected case) */}
      {selected && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="xl:col-span-2">
            <Panel
              title={titleWithIcon(`Workspace — ${selected.title}`, Briefcase, selected.investigation_id)}
              action={
                <div className="flex gap-1.5">
                  <Badge tone={STATUS_TONE[selected.status]}>{selected.status}</Badge>
                  <Badge tone={SEVERITY_TONE[selected.severity]}>{selected.severity}</Badge>
                  {selected.fraud_indicator && <Badge tone="danger">FRAUD</Badge>}
                </div>
              }
              data-testid="inv-section-workspace"
            >
              <div className="space-y-3">
                {/* Case summary */}
                <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-1">Case summary</div>
                  <div className="text-sm text-slate-200">{selected.summary || 'No summary provided.'}</div>
                  <div className="text-xs text-slate-500 mt-2 font-mono">
                    Case: {selected.case_id} · Alert: {selected.alert_id ?? '—'} · Customer: {selected.customer_id ?? '—'}
                    {selected.borrower_id && ` · Borrower: ${selected.borrower_id}`}
                    {selected.policy_id && ` · Policy: ${selected.policy_id}`}
                  </div>
                </div>

                {/* Visual timeline */}
                <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2 flex items-center gap-1.5">
                    <Timer className="size-3" /> Case timeline
                  </div>
                  <div className="flex items-center justify-between gap-1 overflow-x-auto" data-testid="case-timeline">
                    {[
                      { label: 'Alert', icon: Radio, complete: !!selected.alert_id },
                      { label: 'Case', icon: FileText, complete: true },
                      { label: 'Assigned', icon: Users, complete: !!selected.assignee_username },
                      { label: 'Investigating', icon: Search, complete: ['in_review', 'pending_approval', 'escalated', 'closed'].includes(selected.status) },
                      { label: 'Evidence', icon: FileCheck, complete: evidence.length > 0 },
                      { label: 'Review', icon: ClipboardList, complete: ['pending_approval', 'closed'].includes(selected.status) },
                      { label: 'Approval', icon: ShieldCheck, complete: selected.status === 'closed' },
                      { label: 'Closure', icon: CheckCircle2, complete: selected.status === 'closed' },
                    ].map((step, idx) => (
                      <div key={idx} className="flex flex-col items-center flex-1 min-w-[60px]">
                        <div
                          className={`size-8 rounded-full flex items-center justify-center border-2 transition ${
                            step.complete
                              ? 'bg-orange-500/30 border-orange-500 text-orange-300'
                              : 'bg-slate-900 border-slate-700 text-slate-500'
                          }`}
                        >
                          <step.icon className="size-4" />
                        </div>
                        <span className={`text-[10px] mt-1 font-medium ${step.complete ? 'text-orange-300' : 'text-slate-500'}`}>{step.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Workflow actions */}
                <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3" data-testid="workflow-actions">
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2 flex items-center gap-1.5">
                    <GitBranch className="size-3" /> Workflow actions
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(['assign', 'reassign', 'escalate', 'approve', 'reject', 'close', 'reopen'] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        data-testid={`workflow-action-${a}`}
                        className="px-2.5 py-1 rounded bg-slate-900/40 text-slate-300 hover:bg-orange-500/15 hover:text-orange-300 hover:border-orange-500 border border-slate-700 text-xs font-medium transition flex items-center gap-1"
                      >
                        {a} <ChevronRight className="size-3" />
                      </button>
                    ))}
                  </div>
                </div>

                {/* Decision + escalation history (compact) */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3">
                    <div className="text-slate-400 uppercase tracking-wider font-mono mb-1">Opened</div>
                    <div className="text-slate-200">{fmtDate(selected.opened_at)} ({ageDays(selected.opened_at, asOf)}d ago)</div>
                  </div>
                  <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3">
                    <div className="text-slate-400 uppercase tracking-wider font-mono mb-1">SLA due</div>
                    <div className="text-slate-200">{fmtDate(selected.due_at)}</div>
                  </div>
                </div>
              </div>
            </Panel>
          </div>

          {/* AI Investigator panel */}
          {aiReport && (
            <Panel
              title={titleWithIcon('AI investigator', Lightbulb, `${aiReport.model_id} v${aiReport.model_version} · ${fmtPct(aiReport.confidence)} conf`)}
              data-testid="inv-section-ai"
            >
              <div className="space-y-3">
                <div className="rounded-lg border border-orange-500/40 bg-orange-950/20 p-3">
                  <div className="text-xs uppercase tracking-wider text-orange-300 font-mono mb-1">Root cause analysis</div>
                  <p className="text-xs text-slate-200 leading-relaxed">{aiReport.root_cause_analysis}</p>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-1">Risk drivers</div>
                  <div className="space-y-1">
                    {aiReport.risk_drivers.map((d) => (
                      <div key={d.driver_id} className="flex items-center justify-between text-xs">
                        <div className="min-w-0">
                          <div className="text-slate-200 font-medium truncate">{d.label}</div>
                          <div className="text-slate-500 font-mono truncate">{d.human_value}</div>
                        </div>
                        <span className={`font-mono shrink-0 ${d.direction === 'up' ? 'text-orange-400' : 'text-emerald-400'}`}>
                          {d.shap_value > 0 ? '+' : ''}{d.shap_value.toFixed(3)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-1">Related entities</div>
                  <div className="space-y-0.5 text-xs text-slate-300">
                    <div>{aiReport.related_alerts.length} alert(s) · {aiReport.related_cases.length} case(s)</div>
                    <div>{aiReport.related_customers.length} customer(s)</div>
                    {aiReport.related_borrowers.length > 0 && <div>{aiReport.related_borrowers.length} borrower(s)</div>}
                    {aiReport.related_policies.length > 0 && <div>{aiReport.related_policies.length} polic(ies)</div>}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-1">Recommendations ({aiReport.recommendations.length})</div>
                  <ul className="space-y-1 text-xs text-slate-300 list-disc list-inside">
                    {aiReport.recommendations.map((r) => (
                      <li key={r.recommendation_id}>
                        <span className="font-medium text-slate-200">{r.title}</span>{' '}
                        <Badge tone={r.priority === 'high' ? 'danger' : r.priority === 'medium' ? 'warning' : 'success'}>{r.priority}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}

      {/* 4. Evidence Vault */}
      {selected && (
        <Panel
          title={titleWithIcon('Evidence vault', FileLock2, `${evidence.length} items for this case · ${vaultSummary.total_items} fleet-wide`)}
          data-testid="inv-section-evidence"
        >
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 mb-3 text-xs">
            {(['document', 'pdf', 'image', 'screenshot', 'external_reference'] as const).map((t) => (
              <div key={t} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center" data-testid={`vault-type-${t}`}>
                <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{t}</div>
                <div className="text-lg font-bold text-white tabular-nums">{vaultSummary.by_type[t] ?? 0}</div>
              </div>
            ))}
            <div className="rounded border border-emerald-500/40 bg-emerald-950/10 p-2 text-center">
              <div className="text-emerald-300 uppercase tracking-wider font-mono text-[10px]">verified rate</div>
              <div className="text-lg font-bold text-emerald-200 tabular-nums">{fmtPct(vaultSummary.verification_rate)}</div>
            </div>
          </div>
          {evidence.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-6">No evidence captured for this case yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-2 px-3">ID</th>
                    <th className="text-left py-2 px-3">Type</th>
                    <th className="text-left py-2 px-3">Title</th>
                    <th className="text-left py-2 px-3">Uploader</th>
                    <th className="text-left py-2 px-3">Uploaded</th>
                    <th className="text-left py-2 px-3">Verification</th>
                    <th className="text-left py-2 px-3">Hash (sha256)</th>
                    <th className="text-left py-2 px-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.map((e) => {
                    const verify = verifyEvidence(e);
                    return (
                      <tr key={e.evidence_id} data-testid={`evidence-row-${e.evidence_id}`} className="border-b border-slate-900/50">
                        <td className="py-2 px-3 font-mono text-xs text-slate-300">{e.evidence_id}</td>
                        <td className="py-2 px-3 text-slate-400 capitalize">{e.evidence_type.replace('_', ' ')}</td>
                        <td className="py-2 px-3 text-slate-200">{e.title}</td>
                        <td className="py-2 px-3 text-slate-400 font-mono text-xs">{e.uploaded_by}</td>
                        <td className="py-2 px-3 text-slate-400 text-xs">{fmtDate(e.uploaded_at)}</td>
                        <td className="py-2 px-3">
                          <Badge tone={e.verification_status === 'verified' ? 'success' : e.verification_status === 'failed' ? 'danger' : 'warning'}>
                            {e.verification_status}
                          </Badge>
                        </td>
                        <td className="py-2 px-3 font-mono text-[10px] text-slate-500 truncate max-w-[160px]" title={e.hash_sha256}>
                          {e.hash_sha256.slice(0, 12)}…
                        </td>
                        <td className="py-2 px-3">
                          <span className={`text-xs font-mono ${verify.ok ? 'text-emerald-400' : 'text-orange-400'}`}>
                            {verify.ok ? '✓ verified' : '⚠ hash drift'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* 5. Banking + Insurance specialised investigation modules */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel
          title={titleWithIcon('Banking investigations', Activity, `${BANKING_INVESTIGATION_KINDS.length} kinds`)}
          data-testid="inv-section-banking"
        >
          <div className="text-xs text-slate-400 mb-2 font-mono">
            Borrower · SMA · NPA · Fraud · Collections · Sector Risk
          </div>
          <ul className="text-xs text-slate-300 space-y-1">
            {bankingRows.map((r) => (
              <li key={r.investigation_id} className="flex justify-between gap-2 border-b border-slate-900/50 py-1.5">
                <span className="truncate">{r.title}</span>
                <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel
          title={titleWithIcon('Insurance investigations', Shield, `${INSURANCE_INVESTIGATION_KINDS.length} kinds`)}
          data-testid="inv-section-insurance"
        >
          <div className="text-xs text-slate-400 mb-2 font-mono">
            Claim Fraud · Policy Risk · Underwriting · Agent · Channel · Solvency
          </div>
          <ul className="text-xs text-slate-300 space-y-1">
            {insuranceRows.map((r) => (
              <li key={r.investigation_id} className="flex justify-between gap-2 border-b border-slate-900/50 py-1.5">
                <span className="truncate">{r.title}</span>
                <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {/* 6. Investigation Analytics */}
      <Panel
        title={titleWithIcon('Investigation analytics', BarChart3, 'resolution time · productivity · volume trend · SLA')}
        data-testid="inv-section-analytics"
      >
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          <MetricCard label="Avg resolution" value={`${analytics.average_resolution_time_days.toFixed(1)}d`} sub={`median ${analytics.median_resolution_time_days.toFixed(1)}d`} testId="kpi-avg-resolution" />
          <MetricCard label="Fraud detect rate" value={fmtPct(analytics.fraud_detection_rate)} testId="kpi-fraud-rate" />
          <MetricCard label="Recovery success" value={fmtPct(analytics.recovery_success_rate)} testId="kpi-recovery" />
          <MetricCard label="SLA compliance" value={fmtPct(analytics.sla_compliance_rate)} tone={analytics.sla_compliance_rate >= 0.8 ? 'success' : 'warning'} testId="kpi-sla-rate" />
          <MetricCard label="Escalation rate" value={fmtPct(analytics.escalation_rate)} tone={analytics.escalation_rate > 0.25 ? 'warning' : 'success'} testId="kpi-escalation" />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Case volume trend (12 weeks)</div>
            <div className="h-40 w-full">
              <ResponsiveContainer>
                <AreaChart data={analytics.case_volume_trend} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="date_label" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={28} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="opened" stroke="#F97316" fill="rgba(249,115,22,0.3)" name="Opened" />
                  <Area type="monotone" dataKey="closed" stroke="#10B981" fill="rgba(16,185,129,0.2)" name="Closed" />
                  <Area type="monotone" dataKey="escalated" stroke="#EF4444" fill="rgba(239,68,68,0.15)" name="Escalated" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Investigator productivity (top 6)</div>
            <table className="w-full text-xs">
              <thead className="text-slate-500 border-b border-slate-800">
                <tr>
                  <th className="text-left py-1 px-1">Investigator</th>
                  <th className="text-right py-1 px-1">Closed 30d</th>
                  <th className="text-right py-1 px-1">Avg days</th>
                  <th className="text-right py-1 px-1">Reopened</th>
                  <th className="text-right py-1 px-1">Score</th>
                </tr>
              </thead>
              <tbody>
                {analytics.investigator_productivity.map((p) => (
                  <tr key={p.investigator_username} className="border-b border-slate-900/50">
                    <td className="py-1 px-1 font-mono text-slate-300">{p.investigator_username}</td>
                    <td className="py-1 px-1 text-right text-slate-200 tabular-nums">{p.closed_cases_30d}</td>
                    <td className="py-1 px-1 text-right text-slate-400 tabular-nums">{p.avg_close_days.toFixed(1)}</td>
                    <td className="py-1 px-1 text-right text-slate-400 tabular-nums">{p.reopened_count}</td>
                    <td className="py-1 px-1 text-right text-orange-300 tabular-nums">{p.satisfaction_score.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>

      {/* 7. Executive Investigation View */}
      <Panel
        title={titleWithIcon('Executive investigation view', Crown, `fraud exposure ${fmtKes(execView.fraud_exposure_kes)} · recovery ${fmtKes(execView.recovery_impact_kes)}`)}
        data-testid="inv-section-exec"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2 flex items-center gap-1.5">
              <ListChecks className="size-3" /> Top open cases (by exposure)
            </div>
            <ul className="text-xs space-y-1.5">
              {execView.top_open_cases.map((c) => (
                <li key={c.investigation_id} data-testid={`exec-top-${c.investigation_id}`} className="flex items-center justify-between gap-2 border-b border-slate-900/50 py-1.5">
                  <div className="min-w-0">
                    <div className="text-slate-200 font-medium truncate">{c.title}</div>
                    <div className="text-slate-500 font-mono text-[10px]">{c.investigation_id} · {c.assignee_username ?? 'unassigned'} · {c.age_days}d old</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-orange-300 font-bold tabular-nums">{fmtKes(c.exposure_kes)}</div>
                    <Badge tone={SEVERITY_TONE[c.severity]}>{c.severity}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2 flex items-center gap-1.5">
              <ShieldAlert className="size-3" /> Critical investigations
            </div>
            <ul className="text-xs space-y-1.5">
              {execView.critical_investigations.length === 0 ? (
                <li className="text-slate-400 text-center py-4">No critical-severity investigations.</li>
              ) : (
                execView.critical_investigations.map((c) => (
                  <li key={c.investigation_id} data-testid={`exec-crit-${c.investigation_id}`} className="flex items-center justify-between gap-2 border-b border-slate-900/50 py-1.5">
                    <div className="min-w-0">
                      <div className="text-slate-200 font-medium truncate">{c.title}</div>
                      <div className="text-slate-500 font-mono text-[10px]">{c.investigation_id} · {c.assignee_username ?? 'unassigned'} · {c.age_days}d old</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-red-400 font-bold tabular-nums">{fmtKes(c.exposure_kes)}</div>
                      <Badge tone="danger">{c.severity}</Badge>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <MetricCard label="SLA compliance" value={fmtPct(execView.investigation_performance.sla_compliance_rate)} testId="exec-kpi-sla" />
          <MetricCard label="Avg resolution" value={`${execView.investigation_performance.avg_resolution_days.toFixed(1)}d`} testId="exec-kpi-avg" />
          <MetricCard label="Closure rate 30d" value={fmtPct(execView.investigation_performance.closure_rate_30d)} testId="exec-kpi-closure" />
        </div>
      </Panel>

      {/* Cross-IA navigation footer */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1">
        <span>Cross-IA:</span>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/alerts">Alerts</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/cms/cases">CMS Cases</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/cms/workflow">Case Workflow</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/cms/causal">Causal Analysis</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/predictive-risk-center">Predictive Risk</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/recovery-center">Recovery</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/audit-center">Audit</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/admin/governance">Governance</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/executive-cockpit">Executive Cockpit</Link>
      </div>
    </div>
  );
}

// silence unused-import warnings for icons reserved for future expansion
void AlertTriangle; void ArrowRight; void Megaphone; void Sparkles; void Target;
void TrendingDown; void TrendingUp; void XCircle;
