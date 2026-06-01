// web/src/modules/autonomousRisk/AutonomousRiskCenterPage.tsx
//
// Autonomous Risk Operations Center — Phase 18 IA overlay.
// 13 AI Agents: 4 Banking + 4 Insurance + 5 Enterprise.
// Human-in-the-loop governance. Additive — all prior modules untouched.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Award, Bot, Brain, CheckCircle2, ChevronRight,
  Cog, FileText, Globe, LucideIcon, Network, ShieldAlert, ShieldCheck,
  Sparkles, Target, Zap,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  AGENT_REGISTRY,
  buildAgentCollaborations,
  buildAgentExecutions,
  buildAgentRecommendations,
  buildAgentWorkbench,
  buildExecutiveBriefing,
  buildHumanApprovalQueue,
  buildPerformanceDashboard,
  canAccessAutonomousRiskCenter,
  type BriefingType,
  type RiskLevel,
} from './autonomousAgentEngine';
import { buildBankingAgentsSummary } from './bankingAgentsEngine';
import { buildInsuranceAgentsSummary } from './insuranceAgentsEngine';
import { buildEnterpriseAgentsSummary } from './enterpriseAgentsEngine';

const ACTIVE_TENANT = 'BANK_DEMO';
const AS_OF = new Date('2026-05-31T12:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtInt(n: number): string { return n.toLocaleString('en-IN'); }
function fmtPct(n: number): string { return Math.round(n * 10) / 10 + '%'; }
function fmtCr(n: number): string { return '₹' + (Math.round(n * 10) / 10) + ' Cr'; }
function fmtMs(ms: number): string { return ms < 60000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm'; }
function scoreTone(score: number): 'success' | 'warning' | 'danger' {
  return score >= 85 ? 'success' : score >= 65 ? 'warning' : 'danger';
}
function riskColor(level: string): string {
  return level === 'critical' ? '#EF4444' : level === 'high' ? '#F97316' : level === 'medium' ? '#F59E0B' : '#10B981';
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

// ─────────────────────────────────────────────────────────────────────────────
// Micro-components
// ─────────────────────────────────────────────────────────────────────────────

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-700 border border-green-200',
    idle: 'bg-slate-100 text-slate-600 border border-slate-200',
    busy: 'bg-amber-100 text-amber-700 border border-amber-200',
    escalated: 'bg-red-100 text-red-700 border border-red-200',
    suspended: 'bg-purple-100 text-purple-700 border border-purple-200',
    offline: 'bg-gray-100 text-gray-500 border border-gray-200',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colors[state] ?? 'bg-slate-100 text-slate-600'}`}>
      {state}
    </span>
  );
}

function RiskBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    critical: 'bg-red-50 text-red-700 border border-red-200',
    high: 'bg-orange-50 text-orange-700 border border-orange-200',
    medium: 'bg-amber-50 text-amber-700 border border-amber-200',
    low: 'bg-green-50 text-green-700 border border-green-200',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${colors[level] ?? 'bg-slate-100 text-slate-600'}`}>
      {level}
    </span>
  );
}

function DomainBadge({ domain }: { domain: string }) {
  const colors: Record<string, string> = {
    banking: 'bg-blue-100 text-blue-700',
    insurance: 'bg-teal-100 text-teal-700',
    enterprise: 'bg-violet-100 text-violet-700',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colors[domain] ?? 'bg-slate-100'}`}>
      {domain}
    </span>
  );
}

function ProgressBar({ value, color = '#6366F1', height = 2 }: { value: number; color?: string; height?: number }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, backgroundColor: '#e2e8f0' }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, value)}%`, backgroundColor: color }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function AutonomousRiskCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessAutonomousRiskCenter(user.roles)) return <Navigate to="/" replace />;

  const asOf = useMemo(() => AS_OF, []);

  const perf        = useMemo(() => buildPerformanceDashboard(ACTIVE_TENANT, asOf), [asOf]);
  const banking     = useMemo(() => buildBankingAgentsSummary(ACTIVE_TENANT, asOf), [asOf]);
  const insurance   = useMemo(() => buildInsuranceAgentsSummary(ACTIVE_TENANT, asOf), [asOf]);
  const enterprise  = useMemo(() => buildEnterpriseAgentsSummary(ACTIVE_TENANT, asOf), [asOf]);
  const executions  = useMemo(() => buildAgentExecutions(ACTIVE_TENANT, asOf, 12), [asOf]);
  const recommendations = useMemo(() => buildAgentRecommendations(ACTIVE_TENANT, asOf), [asOf]);
  const approvals   = useMemo(() => buildHumanApprovalQueue(ACTIVE_TENANT, asOf), [asOf]);
  const collaborations = useMemo(() => buildAgentCollaborations(ACTIVE_TENANT, asOf), [asOf]);
  const briefingDaily   = useMemo(() => buildExecutiveBriefing(ACTIVE_TENANT, 'daily', asOf), [asOf]);
  const briefingWeekly  = useMemo(() => buildExecutiveBriefing(ACTIVE_TENANT, 'weekly', asOf), [asOf]);
  const briefingMonthly = useMemo(() => buildExecutiveBriefing(ACTIVE_TENANT, 'monthly', asOf), [asOf]);
  const workbench   = useMemo(() => buildAgentWorkbench(ACTIVE_TENANT, asOf), [asOf]);

  const [riskFilter, setRiskFilter] = useState<RiskLevel | 'all'>('all');
  const [briefingType, setBriefingType] = useState<BriefingType>('daily');
  const [domainFilter, setDomainFilter] = useState<'all' | 'banking' | 'insurance' | 'enterprise'>('all');

  const activeBriefing = briefingType === 'daily' ? briefingDaily : briefingType === 'weekly' ? briefingWeekly : briefingMonthly;
  const filteredRecs = riskFilter === 'all' ? recommendations : recommendations.filter((r) => r.risk_level === riskFilter);
  const filteredAgents = domainFilter === 'all' ? AGENT_REGISTRY : AGENT_REGISTRY.filter((a) => a.domain === domainFilter);

  const metricBars = [
    { name: 'Banking', value: perf.recommendations_generated_24h * 0.4, fill: '#3B82F6' },
    { name: 'Insurance', value: perf.recommendations_generated_24h * 0.3, fill: '#14B8A6' },
    { name: 'Enterprise', value: perf.recommendations_generated_24h * 0.3, fill: '#8B5CF6' },
  ].map((d) => ({ ...d, value: Math.round(d.value) }));

  const pendingCount = approvals.filter((a) => a.status === 'pending').length;
  const criticalPendingCount = approvals.filter((a) => a.status === 'pending' && (a.risk_level === 'critical' || a.risk_level === 'high')).length;

  return (
    <div className="space-y-4" data-testid="autonomous-risk-center">

      {/* ─── Header ────────────────────────────────────────────────────────── */}
      <PageHeader
        title="Autonomous Risk Operations Center"
        subtitle="13 AI Agents · Human-in-the-Loop Governance · Real-time Risk Intelligence"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="neutral" className="text-xs">Phase 18</Badge>
            <Badge tone="success" className="text-xs flex items-center gap-1">
              <Bot className="size-3" aria-hidden />
              {perf.active_agents} Active Agents
            </Badge>
            {pendingCount > 0 && (
              <Badge tone="warning" className="text-xs">{pendingCount} Pending Approvals</Badge>
            )}
          </div>
        }
      />

      {/* ─── Section 1: KPI Command Center ────────────────────────────────── */}
      <Panel title={titleWithIcon('Agent Command Center', Bot, 'Fleet performance overview')} data-testid="arc-section-kpis">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Total AI Agents"       value="13"                          sub="4 banking · 4 insurance · 5 enterprise" tone="neutral"  testId="arc-kpi-total" />
          <MetricCard label="Active Agents"         value={fmtInt(perf.active_agents)}  sub={`${perf.idle_agents} idle · ${perf.busy_agents} busy`}  tone="success"  testId="arc-kpi-active" />
          <MetricCard label="Success Rate"          value={fmtPct(perf.overall_success_rate * 100)} sub="30-day rolling avg"  tone={scoreTone(perf.overall_success_rate * 100)} testId="arc-kpi-success" />
          <MetricCard label="Escalations"           value={fmtInt(perf.escalated_agents)} sub="Require human review"  tone={perf.escalated_agents > 2 ? 'warning' : 'neutral'} testId="arc-kpi-escalations" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="Recommendations 24h"  value={fmtInt(perf.recommendations_generated_24h)} sub="AI-generated"          tone="neutral"  testId="arc-kpi-recs" />
          <MetricCard label="Investigations Aided" value={fmtInt(perf.investigations_assisted_24h)}  sub="24h assisted"          tone="neutral"  testId="arc-kpi-inv" />
          <MetricCard label="Compliance Findings"  value={fmtInt(perf.compliance_findings_24h)}       sub="24h detected"          tone={perf.compliance_findings_24h > 5 ? 'warning' : 'neutral'} testId="arc-kpi-compliance" />
          <MetricCard label="Pending Approvals"    value={fmtInt(perf.pending_approvals)}             sub={`${criticalPendingCount} high/critical`} tone={pendingCount > 3 ? 'danger' : 'warning'} testId="arc-kpi-approvals" />
        </div>
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-slate-500 font-medium mb-2 uppercase tracking-wide">Recommendations by Domain (24h)</p>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={metricBars} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11 }} />
                <Bar dataKey="value" name="Recommendations" radius={[3, 3, 0, 0]}>
                  {metricBars.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div>
            <p className="text-xs text-slate-500 font-medium mb-2 uppercase tracking-wide">Recent Agent Activity</p>
            <div className="space-y-1.5 overflow-y-auto max-h-32">
              {executions.slice(0, 6).map((ex) => (
                <div key={ex.execution_id} className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ex.status === 'completed' ? 'bg-green-400' : ex.status === 'escalated' ? 'bg-red-400' : 'bg-amber-400'}`} />
                  <span className="text-slate-600 font-medium truncate flex-1">{ex.agent_name}</span>
                  <span className="text-slate-400">{fmtMs(ex.duration_ms)}</span>
                  <RiskBadge level={ex.risk_level} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Section 2: Agent Registry ─────────────────────────────────────── */}
      <Panel title={titleWithIcon('Agent Registry', Bot, `${AGENT_REGISTRY.length} certified agents`)} data-testid="arc-section-registry">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {(['all', 'banking', 'insurance', 'enterprise'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDomainFilter(d)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                domainFilter === d
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
              }`}
            >
              {d === 'all' ? 'All Domains' : d.charAt(0).toUpperCase() + d.slice(1)}
              <span className="ml-1 opacity-70">
                ({d === 'all' ? AGENT_REGISTRY.length : AGENT_REGISTRY.filter((a) => a.domain === d).length})
              </span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {filteredAgents.map((agent) => (
            <div key={agent.agent_id} className={`p-3 rounded-lg border transition-all hover:shadow-sm ${
              agent.state === 'offline' || agent.state === 'suspended'
                ? 'border-slate-200 bg-slate-50/50 opacity-70'
                : 'border-slate-200 bg-white hover:border-indigo-200'
            }`}>
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-800 truncate">{agent.name}</p>
                  <p className="text-xs text-slate-500 truncate">{agent.type.replace(/_/g, ' ')}</p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <DomainBadge domain={agent.domain} />
                  <StateBadge state={agent.state} />
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Success</span>
                  <span className="font-medium">{fmtPct(agent.success_rate * 100)}</span>
                </div>
                <ProgressBar value={agent.success_rate * 100} color={riskColor(agent.success_rate > 0.9 ? 'low' : agent.success_rate > 0.8 ? 'medium' : 'high')} height={4} />
              </div>
              <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                <span>Escalations: {agent.escalation_count}</span>
                <span>·</span>
                <span>{fmtMs(agent.avg_resolution_ms)} avg</span>
              </div>
              {agent.responsibilities.length > 0 && (
                <p className="text-xs text-slate-500 mt-1.5 truncate">
                  <ChevronRight className="size-3 inline mr-0.5" aria-hidden />
                  {agent.responsibilities[0]}
                </p>
              )}
            </div>
          ))}
        </div>
      </Panel>

      {/* ─── Section 3: Banking AI Agents ──────────────────────────────────── */}
      <Panel title={titleWithIcon('Banking AI Agents', Brain, 'Credit Risk · Fraud · Collections · Portfolio')} data-testid="arc-section-banking">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

          {/* Credit Risk */}
          <div className="rounded-lg border-l-4 border-blue-400 border border-blue-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Credit Risk Agent</span>
              <RiskBadge level={banking.credit_risk.npa_risk_count > 500 ? 'high' : 'medium'} />
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="text-center p-2 bg-blue-50 rounded">
                <p className="text-lg font-bold text-blue-700">{fmtInt(banking.credit_risk.deteriorating_count)}</p>
                <p className="text-xs text-slate-500">Deteriorating</p>
              </div>
              <div className="text-center p-2 bg-red-50 rounded">
                <p className="text-lg font-bold text-red-700">{fmtInt(banking.credit_risk.npa_risk_count)}</p>
                <p className="text-xs text-slate-500">NPA Risk</p>
              </div>
            </div>
            <div className="space-y-0.5">
              {banking.credit_risk.key_findings.slice(0, 2).map((f, i) => (
                <p key={i} className="text-xs text-slate-600 flex items-start gap-1">
                  <AlertTriangle className="size-3 text-amber-400 shrink-0 mt-0.5" />
                  {f}
                </p>
              ))}
            </div>
          </div>

          {/* Fraud Detection */}
          <div className="rounded-lg border-l-4 border-red-400 border border-red-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Fraud Detection Agent</span>
              <RiskBadge level="high" />
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="text-center p-2 bg-red-50 rounded">
                <p className="text-lg font-bold text-red-700">{fmtInt(banking.fraud.fraud_signals_24h)}</p>
                <p className="text-xs text-slate-500">Signals 24h</p>
              </div>
              <div className="text-center p-2 bg-amber-50 rounded">
                <p className="text-lg font-bold text-amber-700">{fmtInt(banking.fraud.active_investigations)}</p>
                <p className="text-xs text-slate-500">Active Inv.</p>
              </div>
            </div>
            <div className="space-y-1">
              {banking.fraud.top_fraud_patterns.slice(0, 2).map((p, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-slate-600 truncate">{p.pattern}</span>
                  <span className="text-red-600 font-medium ml-2 shrink-0">{fmtCr(p.estimated_loss_cr)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Collections */}
          <div className="rounded-lg border-l-4 border-amber-400 border border-amber-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Collections Agent</span>
              <span className="text-sm font-bold text-amber-700">{fmtPct(banking.collections.recovery_rate_pct)}%</span>
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>Recovery Rate</span>
                <span>{fmtCr(banking.collections.recovery_achieved_cr)} / {fmtCr(banking.collections.recovery_target_cr)}</span>
              </div>
              <ProgressBar value={banking.collections.recovery_rate_pct} color="#F59E0B" height={6} />
            </div>
            <div className="text-xs text-slate-500">
              <span className="font-medium text-slate-700">{fmtInt(banking.collections.total_overdue_accounts)}</span> overdue accounts ·{' '}
              <span className="font-medium text-red-600">{fmtInt(banking.collections.critical_bucket_count)}</span> critical (90+ DPD)
            </div>
          </div>

          {/* Portfolio Risk */}
          <div className="rounded-lg border-l-4 border-violet-400 border border-violet-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Portfolio Risk Agent</span>
              <span className={`text-sm font-bold ${banking.portfolio.portfolio_health_score >= 70 ? 'text-green-600' : 'text-amber-600'}`}>
                Score: {banking.portfolio.portfolio_health_score}
              </span>
            </div>
            <ProgressBar value={banking.portfolio.portfolio_health_score} color={banking.portfolio.portfolio_health_score >= 70 ? '#10B981' : '#F59E0B'} height={6} />
            <div className="mt-2 space-y-1">
              {banking.portfolio.sector_concentration_breaches.slice(0, 2).map((b, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-slate-600">{b.sector}</span>
                  <span className="text-red-600 font-medium">+{b.breach_pp.toFixed(1)}pp breach</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Section 4: Insurance AI Agents ────────────────────────────────── */}
      <Panel title={titleWithIcon('Insurance AI Agents', ShieldAlert, 'Claims · Fraud · Retention · Solvency')} data-testid="arc-section-insurance">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

          {/* Claims */}
          <div className="rounded-lg border-l-4 border-teal-400 border border-teal-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Claims Agent</span>
              <RiskBadge level={insurance.claims.suspicious_claims_count > 200 ? 'high' : 'medium'} />
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="text-center p-2 bg-teal-50 rounded">
                <p className="text-lg font-bold text-teal-700">{fmtInt(insurance.claims.suspicious_claims_count)}</p>
                <p className="text-xs text-slate-500">Suspicious</p>
              </div>
              <div className="text-center p-2 bg-red-50 rounded">
                <p className="text-lg font-bold text-red-600">{fmtCr(insurance.claims.claims_amount_at_risk_cr)}</p>
                <p className="text-xs text-slate-500">At Risk</p>
              </div>
            </div>
            <p className="text-xs text-slate-500">{fmtInt(insurance.claims.total_claims_under_review)} total claims under review</p>
          </div>

          {/* Insurance Fraud */}
          <div className="rounded-lg border-l-4 border-red-400 border border-red-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Insurance Fraud Agent</span>
              <RiskBadge level="critical" />
            </div>
            <div className="grid grid-cols-3 gap-1 mb-2">
              {[
                { label: 'Rings', value: insurance.fraud.organized_fraud_rings_detected },
                { label: 'Collusion', value: insurance.fraud.provider_collusion_cases },
                { label: 'Identity', value: insurance.fraud.identity_fraud_cases },
              ].map(({ label, value }) => (
                <div key={label} className="text-center p-1.5 bg-red-50 rounded">
                  <p className="text-sm font-bold text-red-700">{value}</p>
                  <p className="text-xs text-slate-500">{label}</p>
                </div>
              ))}
            </div>
            <div className="text-xs text-slate-500">
              SIU Capacity: <span className={`font-medium ${insurance.fraud.siu_capacity_pct > 85 ? 'text-red-600' : 'text-amber-600'}`}>{fmtPct(insurance.fraud.siu_capacity_pct)}</span>
            </div>
          </div>

          {/* Policy Retention */}
          <div className="rounded-lg border-l-4 border-amber-400 border border-amber-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Policy Retention Agent</span>
              <span className="text-sm font-bold text-teal-700">Persistency: {fmtPct(insurance.retention.persistency_13m)}</span>
            </div>
            <ProgressBar value={insurance.retention.persistency_13m} color="#F59E0B" height={6} />
            <div className="mt-2 text-xs text-slate-500">
              <span className="font-medium text-amber-700">{fmtInt(insurance.retention.policies_at_lapse_risk)}</span> policies at lapse risk ·
              <span className="text-amber-600 font-medium ml-1">{fmtCr(insurance.retention.total_premium_at_risk_cr)}</span> at risk
            </div>
          </div>

          {/* Solvency */}
          <div className="rounded-lg border-l-4 border-blue-400 border border-blue-100 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Solvency Agent</span>
              <span className={`text-sm font-bold ${insurance.solvency.margin_pp > 30 ? 'text-green-600' : 'text-amber-600'}`}>
                Margin: {insurance.solvency.margin_pp.toFixed(1)}pp
              </span>
            </div>
            <div className="flex items-center gap-2 mb-2">
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-500">Current: {insurance.solvency.current_solvency_ratio.toFixed(1)}%</span>
                  <span className="text-slate-400">Required: {insurance.solvency.required_ratio}%</span>
                </div>
                <ProgressBar value={(insurance.solvency.current_solvency_ratio / 300) * 100} color="#3B82F6" height={6} />
              </div>
            </div>
            <p className="text-xs text-slate-500">Status: <span className={`font-medium ${insurance.solvency.capital_adequacy_status === 'adequate' ? 'text-green-600' : 'text-amber-600'}`}>{insurance.solvency.capital_adequacy_status}</span></p>
          </div>
        </div>
      </Panel>

      {/* ─── Section 5: Enterprise AI Agents ───────────────────────────────── */}
      <Panel title={titleWithIcon('Enterprise AI Agents', Globe, 'Compliance · Investigation · Executive · Recovery · Governance')} data-testid="arc-section-enterprise">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">

          {/* Compliance */}
          <div className="rounded-lg border border-green-100 border-l-4 border-l-green-400 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Compliance Agent</span>
              <span className={`text-sm font-bold ${scoreTone(enterprise.compliance.compliance_score) === 'success' ? 'text-green-600' : 'text-amber-600'}`}>
                {enterprise.compliance.compliance_score}
              </span>
            </div>
            <ProgressBar value={enterprise.compliance.compliance_score} color="#10B981" height={4} />
            <div className="mt-2 grid grid-cols-3 gap-1 text-center text-xs">
              <div className="p-1 bg-green-50 rounded"><span className="font-bold text-green-700">{enterprise.compliance.compliant_count}</span><p className="text-slate-500">OK</p></div>
              <div className="p-1 bg-amber-50 rounded"><span className="font-bold text-amber-700">{enterprise.compliance.at_risk_count}</span><p className="text-slate-500">Risk</p></div>
              <div className="p-1 bg-red-50 rounded"><span className="font-bold text-red-700">{enterprise.compliance.breached_count}</span><p className="text-slate-500">Breach</p></div>
            </div>
          </div>

          {/* Investigation */}
          <div className="rounded-lg border border-indigo-100 border-l-4 border-l-indigo-400 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Investigation Agent</span>
              <RiskBadge level={enterprise.investigation.high_priority_count > 5 ? 'high' : 'medium'} />
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="text-center p-1.5 bg-indigo-50 rounded">
                <p className="text-lg font-bold text-indigo-700">{enterprise.investigation.active_investigations}</p>
                <p className="text-xs text-slate-500">Active</p>
              </div>
              <div className="text-center p-1.5 bg-red-50 rounded">
                <p className="text-lg font-bold text-red-700">{enterprise.investigation.high_priority_count}</p>
                <p className="text-xs text-slate-500">High Priority</p>
              </div>
            </div>
            <p className="text-xs text-slate-500">Avg resolution: {enterprise.investigation.avg_resolution_days} days</p>
          </div>

          {/* Executive Briefing */}
          <div className="rounded-lg border border-violet-100 border-l-4 border-l-violet-400 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Executive Briefing</span>
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium border ${
                enterprise.executive_briefing.risk_appetite_status === 'within_limits' ? 'bg-green-50 text-green-700 border-green-200' :
                enterprise.executive_briefing.risk_appetite_status === 'approaching_limit' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                'bg-red-50 text-red-700 border-red-200'
              }`}>
                {enterprise.executive_briefing.risk_appetite_status.replace(/_/g, ' ')}
              </span>
            </div>
            <div className="space-y-1">
              {enterprise.executive_briefing.top_3_risks.slice(0, 2).map((r) => (
                <div key={r.rank} className="flex items-center gap-2 text-xs">
                  <span className="w-4 h-4 rounded-full bg-violet-100 text-violet-700 text-xs flex items-center justify-center font-bold shrink-0">{r.rank}</span>
                  <span className="text-slate-600 truncate">{r.title}</span>
                  <RiskBadge level={r.level} />
                </div>
              ))}
            </div>
          </div>

          {/* Recovery */}
          <div className="rounded-lg border border-amber-100 border-l-4 border-l-amber-400 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Recovery Agent</span>
              <span className="text-sm font-bold text-amber-700">{fmtPct(enterprise.recovery.success_rate_pct)}</span>
            </div>
            <ProgressBar value={enterprise.recovery.success_rate_pct} color="#F59E0B" height={4} />
            <div className="mt-2 text-xs text-slate-500">
              {enterprise.recovery.active_restoration_actions} active actions · {enterprise.recovery.completed_7d} completed (7d)
            </div>
            {enterprise.recovery.critical_pending_actions.length > 0 && (
              <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                <AlertTriangle className="size-3" aria-hidden />
                {enterprise.recovery.critical_pending_actions[0].description}
              </p>
            )}
          </div>

          {/* Governance */}
          <div className="rounded-lg border border-purple-100 border-l-4 border-l-purple-400 p-3 sm:col-span-2 xl:col-span-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-800">Governance Agent</span>
              <span className={`text-sm font-bold ${enterprise.governance.governance_score >= 80 ? 'text-green-600' : 'text-amber-600'}`}>
                Score: {enterprise.governance.governance_score}
              </span>
            </div>
            <ProgressBar value={enterprise.governance.governance_score} color="#8B5CF6" height={4} />
            <div className="mt-2 grid grid-cols-2 gap-1 text-xs">
              <div><span className="text-slate-500">Violations: </span><span className="font-medium text-red-600">{enterprise.governance.policy_violations_detected}</span></div>
              <div><span className="text-slate-500">Board compliance: </span><span className="font-medium">{fmtPct(enterprise.governance.board_policy_compliance_pct)}</span></div>
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Section 6: Recommendation Center ─────────────────────────────── */}
      <Panel title={titleWithIcon('AI Recommendation Center', Sparkles, `${filteredRecs.length} active`)} data-testid="arc-section-recommendations">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {(['all', 'critical', 'high', 'medium', 'low'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setRiskFilter(level)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                riskFilter === level
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
              }`}
            >
              {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
              {level !== 'all' && (
                <span className="ml-1 opacity-70">({recommendations.filter(r => r.risk_level === level).length})</span>
              )}
            </button>
          ))}
        </div>
        <div className="space-y-3">
          {filteredRecs.slice(0, 6).map((rec) => (
            <div key={rec.recommendation_id} className="rounded-lg border border-slate-100 p-3 hover:bg-slate-50 transition-colors">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <DomainBadge domain={AGENT_REGISTRY.find(a => a.agent_id === rec.agent_id)?.domain ?? 'enterprise'} />
                  <span className="text-xs font-medium text-slate-600">{rec.agent_name}</span>
                  <RiskBadge level={rec.risk_level} />
                  {rec.requires_approval && (
                    <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded">Needs Approval</span>
                  )}
                </div>
                <span className="text-xs text-slate-400 shrink-0">{fmtPct(rec.confidence_score * 100)} confidence</span>
              </div>
              <p className="text-sm font-semibold text-slate-800 mb-2">{rec.title}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-slate-500 font-medium mb-1">Key Findings</p>
                  <ul className="space-y-0.5">
                    {rec.findings.slice(0, 2).map((f, i) => (
                      <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                        <AlertTriangle className="size-3 text-amber-400 shrink-0 mt-0.5" aria-hidden />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-medium mb-1">Suggested Actions</p>
                  <ul className="space-y-0.5">
                    {rec.suggested_actions.slice(0, 2).map((a, i) => (
                      <li key={i} className="text-xs text-slate-600 flex items-start gap-1">
                        <ArrowRight className="size-3 text-indigo-400 shrink-0 mt-0.5" aria-hidden />
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <ProgressBar value={rec.confidence_score * 100} color={riskColor(rec.risk_level)} height={2} />
            </div>
          ))}
        </div>
      </Panel>

      {/* ─── Section 7: Human Approval Queue ───────────────────────────────── */}
      <Panel title={titleWithIcon('Human-in-the-Loop Approvals', CheckCircle2, `${pendingCount} pending`)} data-testid="arc-section-approvals">
        {criticalPendingCount > 0 && (
          <div className="mb-3 p-2.5 rounded-lg border border-red-200 bg-red-50 flex items-center gap-2">
            <AlertTriangle className="size-4 text-red-500 shrink-0" aria-hidden />
            <p className="text-xs text-red-700">
              <strong>{criticalPendingCount}</strong> high/critical risk actions require immediate human approval.
              AI agents are paused on these actions pending review.
            </p>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                <th className="py-2 pr-3 font-medium">Agent</th>
                <th className="py-2 pr-3 font-medium">Action Required</th>
                <th className="py-2 pr-3 font-medium">Risk</th>
                <th className="py-2 pr-3 font-medium">Generated</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((item) => (
                <tr key={item.item_id} className="border-b border-slate-50 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-medium text-slate-700">{item.agent_name}</td>
                  <td className="py-2 pr-3 text-slate-600 max-w-48 truncate">{item.action_description}</td>
                  <td className="py-2 pr-3"><RiskBadge level={item.risk_level} /></td>
                  <td className="py-2 pr-3 text-slate-400">{new Date(item.generated_at).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}</td>
                  <td className="py-2 pr-3">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                      item.status === 'pending' ? 'bg-amber-50 text-amber-700' :
                      item.status === 'approved' ? 'bg-green-50 text-green-700' :
                      item.status === 'rejected' ? 'bg-red-50 text-red-700' :
                      'bg-purple-50 text-purple-700'
                    }`}>{item.status}</span>
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      {['Approve', 'Reject', 'Escalate', 'Review'].map((action, i) => (
                        <button key={action} className={`px-1.5 py-0.5 rounded text-xs font-medium border ${
                          i === 0 ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100' :
                          i === 1 ? 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100' :
                          i === 2 ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100' :
                          'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                        } transition-colors`}>{action}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ─── Section 8: Collaboration Network ──────────────────────────────── */}
      <Panel title={titleWithIcon('Agent Collaboration Network', Network, `${collaborations.filter(c => c.status === 'active').length} active flows`)} data-testid="arc-section-collaboration">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {collaborations.map((collab) => (
            <div key={collab.collaboration_id} className={`flex items-center gap-2 p-2.5 rounded-lg border transition-colors ${
              collab.status === 'active' ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-100 bg-slate-50/30 opacity-70'
            }`}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-slate-700">{collab.from_agent_name}</span>
                  <ArrowRight className="size-3 text-slate-400 shrink-0" aria-hidden />
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    collab.collaboration_type === 'escalation' ? 'bg-red-100 text-red-700' :
                    collab.collaboration_type === 'handoff' ? 'bg-blue-100 text-blue-700' :
                    'bg-slate-100 text-slate-600'
                  }`}>{collab.collaboration_type}</span>
                  <ArrowRight className="size-3 text-slate-400 shrink-0" aria-hidden />
                  <span className="text-xs font-medium text-slate-700">{collab.to_agent_name}</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5 truncate">{collab.outcome_summary}</p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <StateBadge state={collab.status} />
                <span className="text-xs text-slate-400">{collab.message_count} msgs</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {/* ─── Section 9: Executive Briefings ────────────────────────────────── */}
      <Panel title={titleWithIcon('Executive AI Briefings', Award, 'Board-ready intelligence')} data-testid="arc-section-briefings">
        <div className="flex items-center gap-2 mb-3">
          {(['daily', 'weekly', 'monthly'] as BriefingType[]).map((t) => (
            <button
              key={t}
              onClick={() => setBriefingType(t)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${
                briefingType === t ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className={`mb-3 p-2.5 rounded-lg border flex items-center gap-2 ${
          activeBriefing.risk_appetite_status === 'within_limits' ? 'border-green-200 bg-green-50' :
          activeBriefing.risk_appetite_status === 'approaching_limit' ? 'border-amber-200 bg-amber-50' :
          'border-red-200 bg-red-50'
        }`}>
          <ShieldCheck className={`size-4 shrink-0 ${activeBriefing.risk_appetite_status === 'within_limits' ? 'text-green-500' : activeBriefing.risk_appetite_status === 'approaching_limit' ? 'text-amber-500' : 'text-red-500'}`} aria-hidden />
          <p className="text-xs font-medium">
            Risk Appetite: <strong>{activeBriefing.risk_appetite_status.replace(/_/g, ' ')}</strong>
            {' · '}Confidence: {fmtPct(activeBriefing.confidence_score * 100)}
          </p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1">
              <Target className="size-3" aria-hidden />
              Top Risks — {activeBriefing.period_label}
            </p>
            <div className="space-y-2">
              {activeBriefing.top_risks.map((risk, i) => (
                <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-slate-100">
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: riskColor(risk.level) + '20', color: riskColor(risk.level) }}>
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-xs font-medium text-slate-800 truncate">{risk.title}</span>
                      <RiskBadge level={risk.level} />
                    </div>
                    <p className="text-xs text-slate-500 truncate">{risk.summary}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1">
              <Zap className="size-3" aria-hidden />
              Emerging Threats
            </p>
            <ul className="space-y-1.5 mb-3">
              {activeBriefing.emerging_risks.map((r, i) => (
                <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                  <AlertTriangle className="size-3 text-amber-400 shrink-0 mt-0.5" aria-hidden />
                  {r}
                </li>
              ))}
            </ul>
            <p className="text-xs font-semibold text-slate-700 mb-2">Investigation Status</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: 'Active', value: activeBriefing.investigation_status.total_active },
                { label: 'High Priority', value: activeBriefing.investigation_status.high_priority },
                { label: 'Avg Days', value: activeBriefing.investigation_status.avg_resolution_days },
              ].map(({ label, value }) => (
                <div key={label} className="p-2 bg-slate-50 rounded">
                  <p className="text-sm font-bold text-slate-800">{value}</p>
                  <p className="text-xs text-slate-500">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Section 10: Agent Workbench ────────────────────────────────────── */}
      <Panel title={titleWithIcon('Agent Workbench', Cog, 'Management console')} data-testid="arc-section-workbench">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-100">
                {['Agent', 'Domain', 'State', 'Last Exec', 'Success %', 'Escalations', 'Avg Resolution', 'Actions'].map((h) => (
                  <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workbench.map((w) => (
                <tr key={w.agent_id} className="border-b border-slate-50 hover:bg-slate-50">
                  <td className="py-1.5 pr-3 font-medium text-slate-800">{w.name.split(' ').slice(0, 2).join(' ')}</td>
                  <td className="py-1.5 pr-3"><DomainBadge domain={w.domain} /></td>
                  <td className="py-1.5 pr-3"><StateBadge state={w.state} /></td>
                  <td className="py-1.5 pr-3 text-slate-400">{new Date(w.last_execution).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}</td>
                  <td className="py-1.5 pr-3">
                    <span className={w.success_rate >= 0.9 ? 'text-green-600 font-medium' : w.success_rate >= 0.8 ? 'text-amber-600' : 'text-red-600'}>
                      {fmtPct(w.success_rate * 100)}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-slate-600">{w.escalation_count}</td>
                  <td className="py-1.5 pr-3 text-slate-600">{fmtMs(w.avg_resolution_ms)}</td>
                  <td className="py-1.5">
                    <div className="flex items-center gap-1">
                      <button className={`px-1.5 py-0.5 rounded text-xs font-medium border transition-colors ${w.is_enabled ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100' : 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'}`}>
                        {w.is_enabled ? 'Pause' : 'Enable'}
                      </button>
                      <button className="p-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-100 transition-colors" title="Configure">
                        <Cog className="size-3" aria-hidden />
                      </button>
                      <button className="p-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-100 transition-colors" title="Clone">
                        <FileText className="size-3" aria-hidden />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-200 bg-slate-50/50">
                <td colSpan={4} className="py-2 pr-3 font-semibold text-slate-600">Fleet Summary</td>
                <td className="py-2 pr-3 font-semibold text-slate-700">
                  {fmtPct(workbench.reduce((s, w) => s + w.success_rate, 0) / workbench.length * 100)} avg
                </td>
                <td className="py-2 pr-3 font-semibold text-slate-700">
                  {workbench.reduce((s, w) => s + w.escalation_count, 0)} total
                </td>
                <td colSpan={2} className="py-2 text-slate-500">
                  {workbench.filter(w => w.is_enabled).length} enabled · {workbench.filter(w => !w.is_enabled).length} disabled
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>

      {/* ─── Cross-IA footer ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1 border-t border-slate-100">
        <span className="font-medium text-slate-500">Autonomous Risk Ops · Phase 18</span>
        <span>·</span>
        <Link to="/digital-twin-center" className="hover:text-indigo-600 transition-colors">Digital Twin</Link>
        <Link to="/demo-readiness-center" className="hover:text-indigo-600 transition-colors">Demo Readiness</Link>
        <Link to="/investigation-center" className="hover:text-indigo-600 transition-colors">Investigation</Link>
        <Link to="/regulatory-compliance-center" className="hover:text-indigo-600 transition-colors">Compliance</Link>
        <Link to="/admin/governance" className="hover:text-indigo-600 transition-colors">Governance</Link>
        <Link to="/ai-governance" className="hover:text-indigo-600 transition-colors">AI Governance</Link>
        <Link to="/recovery-center" className="hover:text-indigo-600 transition-colors">Recovery</Link>
        <span className="ml-auto text-slate-300">All 18 IA overlays active</span>
      </div>

    </div>
  );
}
