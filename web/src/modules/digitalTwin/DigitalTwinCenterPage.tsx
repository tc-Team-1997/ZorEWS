// web/src/modules/digitalTwin/DigitalTwinCenterPage.tsx
//
// Digital Twin Risk Simulation Center — Phase 17 IA overlay.
//
// Additive — every existing module untouched. Gated to admin / supervisor /
// risk_analyst at the sidebar; page-level gate covers enterprise personas.
//
// 8 sections rendered; deterministic pure-function engines via useMemo.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3, BookOpen, Brain,
  CheckCircle2, ChevronRight, Cpu, Database, FileBarChart2,
  FileText, Globe, LucideIcon,
  Settings2, ShieldAlert, Sparkles, Target,
  TrendingDown, TrendingUp, Workflow, Zap, Clock, Award,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell,
  RadarChart, Radar, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  SCENARIO_TEMPLATES, SIMULATION_DOMAINS,
  buildAiRecommendations, buildBoardReports, buildDigitalTwinKpis,
  buildImpactAnalysis, buildSavedScenarios, buildScenarioComparison,
  buildSimulationRun, buildWorkflowTimeline,
  canAccessDigitalTwinCenter, levelToColor, levelTone, scoreToLevel,
  type BoardReportKind, type ImpactLevel, type SimulationDomain,
  type SimulationHorizon,
} from './digitalTwinEngine';

const ACTIVE_TENANT = 'BANK_DEMO';

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtInt(n: number): string {
  return n.toLocaleString('en-IN');
}

function fmtPct(n: number, decimals = 1): string {
  return `${round(n, decimals)}%`;
}

function fmtINR(n: number): string {
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(1)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${fmtInt(Math.round(n))}`;
}

function round(v: number, d = 0): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
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

function ImpactBadge({ level }: { level: ImpactLevel }) {
  const tone = levelTone(level);
  const colors: Record<typeof tone, string> = {
    danger: 'bg-red-50 text-red-700 border border-red-200',
    warning: 'bg-orange-50 text-orange-700 border border-orange-200',
    neutral: 'bg-amber-50 text-amber-700 border border-amber-200',
    success: 'bg-green-50 text-green-700 border border-green-200',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${colors[tone]}`}>
      {level}
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    approved: 'bg-green-50 text-green-700 border border-green-200',
    review: 'bg-blue-50 text-blue-700 border border-blue-200',
    draft: 'bg-slate-50 text-slate-600 border border-slate-200',
    rejected: 'bg-red-50 text-red-700 border border-red-200',
    archived: 'bg-purple-50 text-purple-700 border border-purple-200',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[state] ?? 'bg-slate-100 text-slate-600'}`}>
      {state}
    </span>
  );
}

const HORIZON_LABELS: Record<SimulationHorizon, string> = {
  '30d': '30 Days', '60d': '60 Days', '90d': '90 Days', '180d': '180 Days',
};

const DOMAIN_LABELS: Record<SimulationDomain, string> = {
  banking: 'Banking', insurance: 'Insurance', cross_domain: 'Cross Domain',
};

const BOARD_LABELS: Record<BoardReportKind, string> = {
  board: 'Board Report', risk_committee: 'Risk Committee', audit_committee: 'Audit Committee', regulatory: 'Regulatory',
};

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export function DigitalTwinCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessDigitalTwinCenter(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const asOf = useMemo(() => new Date(), []);

  // Active template selection
  const [activeTemplateId, setActiveTemplateId] = useState<string>(SCENARIO_TEMPLATES[0].template_id);
  const [activeDomainFilter, setActiveDomainFilter] = useState<SimulationDomain | 'all'>('all');

  // Compute all data from engines
  const kpis = useMemo(() => buildDigitalTwinKpis(ACTIVE_TENANT, asOf), [asOf]);
  const savedScenarios = useMemo(() => buildSavedScenarios(ACTIVE_TENANT, asOf), [asOf]);
  const activeRun = useMemo(
    () => buildSimulationRun(ACTIVE_TENANT, activeTemplateId, asOf),
    [activeTemplateId, asOf],
  );
  const impactAnalysis = useMemo(
    () => buildImpactAnalysis(ACTIVE_TENANT, activeRun, asOf),
    [activeRun, asOf],
  );
  const aiRecommendations = useMemo(
    () => buildAiRecommendations(ACTIVE_TENANT, activeRun, asOf),
    [activeRun, asOf],
  );
  const workflowEvents = useMemo(
    () => buildWorkflowTimeline(ACTIVE_TENANT, activeTemplateId, asOf),
    [activeTemplateId, asOf],
  );
  const boardReports = useMemo(() => buildBoardReports(ACTIVE_TENANT, asOf), [asOf]);

  // Comparison: pick two approved scenarios for A vs B
  const runA = useMemo(
    () => buildSimulationRun(ACTIVE_TENANT, SCENARIO_TEMPLATES[0].template_id, asOf),
    [asOf],
  );
  const runB = useMemo(
    () => buildSimulationRun(ACTIVE_TENANT, SCENARIO_TEMPLATES[2].template_id, asOf),
    [asOf],
  );
  const comparison = useMemo(
    () => buildScenarioComparison(ACTIVE_TENANT, runA, runB, asOf),
    [runA, runB, asOf],
  );

  // Filtered templates
  const filteredTemplates = useMemo(
    () =>
      activeDomainFilter === 'all'
        ? SCENARIO_TEMPLATES
        : SCENARIO_TEMPLATES.filter((t) => t.domain === activeDomainFilter),
    [activeDomainFilter],
  );

  // Active template metadata
  const activeTemplate = SCENARIO_TEMPLATES.find((t) => t.template_id === activeTemplateId)!;

  // Radar data for impact categories
  const radarData = impactAnalysis.categories.map((c) => ({
    category: c.category.charAt(0).toUpperCase() + c.category.slice(1),
    score: c.score,
  }));

  // Metric deltas for bar chart (top 5)
  const metricBars = activeRun.metrics.slice(0, 6).map((m) => ({
    name: m.label.split(' ').slice(0, 2).join(' '),
    delta: m.delta_pct,
    fill: m.risk_flag ? '#EF4444' : m.delta_value < 0 ? '#10B981' : '#F59E0B',
  }));

  return (
    <div className="space-y-4" data-testid="digital-twin-center">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <PageHeader
        title="Digital Twin Risk Simulation Center"
        subtitle="Deterministic scenario modeling · Multi-horizon impact analysis · AI-powered recommendations"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="neutral" className="text-xs">Phase 17</Badge>
            <Badge tone="success" className="text-xs flex items-center gap-1">
              <Cpu className="size-3" aria-hidden />
              {SCENARIO_TEMPLATES.length} Templates Live
            </Badge>
            <Badge tone="neutral" className="text-xs">{kpis.simulations_run_30d} Runs · 30d</Badge>
          </div>
        }
      />

      {/* ─── Section 1: KPI Command Center ─────────────────────────────── */}
      <Panel
        title={titleWithIcon('Command Center', Activity, 'Real-time simulation intelligence')}
        data-testid="dt-section-kpis"
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard
            label="Active Scenarios"
            value={fmtInt(kpis.active_scenarios)}
            sub={`${kpis.approved_scenarios} approved`}
            tone="success"
            testId="dt-kpi-active-scenarios"
          />
          <MetricCard
            label="Simulations Run"
            value={fmtInt(kpis.simulations_run_30d)}
            sub="Last 30 days"
            tone="neutral"
            testId="dt-kpi-simulations"
          />
          <MetricCard
            label="High+ Impact Events"
            value={fmtInt(kpis.high_critical_events)}
            sub="Requires action"
            tone={kpis.high_critical_events > 5 ? 'danger' : 'warning'}
            testId="dt-kpi-high-impact"
          />
          <MetricCard
            label="AI Confidence"
            value={fmtPct(kpis.avg_confidence_score * 100)}
            sub="Avg across runs"
            tone={kpis.avg_confidence_score >= 0.85 ? 'success' : 'warning'}
            testId="dt-kpi-confidence"
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <MetricCard
            label="Pending Review"
            value={fmtInt(kpis.pending_review)}
            sub="Awaiting sign-off"
            tone={kpis.pending_review > 2 ? 'warning' : 'neutral'}
            testId="dt-kpi-pending"
          />
          <MetricCard
            label="Board Reports"
            value={fmtInt(kpis.board_reports_generated)}
            sub="Generated"
            tone="neutral"
            testId="dt-kpi-board-reports"
          />
          <MetricCard
            label="Scenario Coverage"
            value={fmtPct(kpis.scenario_coverage_pct)}
            sub="Risk universe"
            tone={kpis.scenario_coverage_pct >= 85 ? 'success' : 'warning'}
            testId="dt-kpi-coverage"
          />
          <MetricCard
            label="Impact Level"
            value={scoreToLevel(impactAnalysis.overall_score).toUpperCase()}
            sub={`Score: ${impactAnalysis.overall_score}`}
            tone={levelTone(impactAnalysis.overall_level)}
            testId="dt-kpi-impact-level"
          />
        </div>
      </Panel>

      {/* ─── Section 2: Template Library ────────────────────────────────── */}
      <Panel
        title={titleWithIcon('Scenario Template Library', Database, `${SCENARIO_TEMPLATES.length} BIL certified templates`)}
        data-testid="dt-section-templates"
      >
        {/* Domain filter tabs */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {(['all', ...SIMULATION_DOMAINS] as const).map((d) => (
            <button
              key={d}
              onClick={() => setActiveDomainFilter(d)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                activeDomainFilter === d
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
              }`}
            >
              {d === 'all' ? 'All Domains' : DOMAIN_LABELS[d]}
              <span className="ml-1 opacity-70">
                ({d === 'all' ? SCENARIO_TEMPLATES.length : SCENARIO_TEMPLATES.filter((t) => t.domain === d).length})
              </span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filteredTemplates.map((template) => {
            const isActive = template.template_id === activeTemplateId;
            const domainColors: Record<SimulationDomain, string> = {
              banking: 'border-blue-200 bg-blue-50/40',
              insurance: 'border-teal-200 bg-teal-50/40',
              cross_domain: 'border-purple-200 bg-purple-50/40',
            };
            return (
              <button
                key={template.template_id}
                onClick={() => setActiveTemplateId(template.template_id)}
                className={`text-left p-3 rounded-lg border transition-all ${
                  isActive
                    ? 'border-indigo-400 bg-indigo-50 ring-1 ring-indigo-200'
                    : `${domainColors[template.domain]} hover:border-indigo-300`
                }`}
                data-testid={`dt-template-${template.template_id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{template.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{template.description}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                      template.domain === 'banking' ? 'bg-blue-100 text-blue-700' :
                      template.domain === 'insurance' ? 'bg-teal-100 text-teal-700' :
                      'bg-purple-100 text-purple-700'
                    }`}>
                      {DOMAIN_LABELS[template.domain]}
                    </span>
                    {isActive && <CheckCircle2 className="size-3.5 text-indigo-500" />}
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                  <span>Severity: <strong>{template.default_severity_pct}%</strong></span>
                  <span>Horizon: <strong>{HORIZON_LABELS[template.default_horizon]}</strong></span>
                  <span>NPA impact: <strong>+{template.estimated_npa_impact_bps > 0 ? `${template.estimated_npa_impact_bps}bps` : 'n/a'}</strong></span>
                </div>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* ─── Section 3: Active Simulation Run ───────────────────────────── */}
      <Panel
        title={titleWithIcon('Active Simulation Run', Zap, activeTemplate.name)}
        data-testid="dt-section-simulation"
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Run metadata */}
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 p-3 bg-slate-50/50">
              <p className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wide">Simulation Parameters</p>
              <div className="space-y-1.5 text-sm">
                {[
                  { label: 'Template', value: activeTemplate.name },
                  { label: 'Domain', value: DOMAIN_LABELS[activeRun.domain] },
                  { label: 'Severity', value: `${activeRun.severity_pct}% stress` },
                  { label: 'Horizon', value: HORIZON_LABELS[activeRun.horizon] },
                  { label: 'Confidence', value: fmtPct(activeRun.confidence_score * 100) },
                  { label: 'Run ID', value: activeRun.run_id.split('-').slice(-3).join('-') },
                ].map(({ label, value }) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-slate-500">{label}</span>
                    <span className="font-medium text-slate-800">{value}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-slate-500">Impact Level</span>
                <ImpactBadge level={activeRun.impact_level} />
              </div>
              {activeTemplate.risk_drivers.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-slate-500 mb-1.5 font-medium">Key Risk Drivers</p>
                  <div className="flex flex-wrap gap-1">
                    {activeTemplate.risk_drivers.map((d) => (
                      <span key={d} className="text-xs bg-red-50 text-red-700 border border-red-100 px-1.5 py-0.5 rounded">
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Metric deltas bar chart */}
          <div className="lg:col-span-2">
            <p className="text-xs text-slate-500 mb-2 font-medium uppercase tracking-wide">Metric Impact (% Change from Baseline)</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={metricBars} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} unit="%" />
                <Tooltip
                  formatter={(v: number) => [`${v.toFixed(1)}%`, 'Delta']}
                  contentStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="delta" name="Δ %" radius={[3, 3, 0, 0]}>
                  {metricBars.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            {/* Metrics table */}
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-100">
                    <th className="py-1.5 pr-3 font-medium">Metric</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Baseline</th>
                    <th className="py-1.5 pr-3 font-medium text-right">Projected</th>
                    <th className="py-1.5 font-medium text-right">Δ %</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRun.metrics.map((m) => (
                    <tr key={m.metric} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-1.5 pr-3 font-medium text-slate-700 flex items-center gap-1">
                        {m.risk_flag && <AlertTriangle className="size-3 text-red-400" aria-hidden />}
                        {m.label}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-slate-500">
                        {m.baseline_value.toFixed(1)}{m.unit === '%' ? '%' : ''}
                      </td>
                      <td className={`py-1.5 pr-3 text-right font-medium ${
                        m.risk_flag ? 'text-red-600' : 'text-slate-800'
                      }`}>
                        {m.projected_value.toFixed(1)}{m.unit === '%' ? '%' : ''}
                      </td>
                      <td className={`py-1.5 text-right font-medium ${
                        m.delta_pct > 0 ? (m.risk_flag ? 'text-red-600' : 'text-amber-600') : 'text-green-600'
                      }`}>
                        {m.delta_pct > 0 ? '+' : ''}{m.delta_pct.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Section 4: Impact Analysis ─────────────────────────────────── */}
      <Panel
        title={titleWithIcon('Impact Analysis', ShieldAlert, '5-category risk decomposition')}
        data-testid="dt-section-impact"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Radar chart */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">Overall Score: {impactAnalysis.overall_score}</p>
                <p className="text-xs text-slate-500 mt-0.5">Composite risk across 5 dimensions</p>
              </div>
              <ImpactBadge level={impactAnalysis.overall_level} />
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <RadarChart cx="50%" cy="50%" outerRadius="80%" data={radarData}>
                <PolarGrid stroke="#e2e8f0" />
                <PolarAngleAxis dataKey="category" tick={{ fontSize: 10 }} />
                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 9 }} />
                <Radar
                  name="Risk Score"
                  dataKey="score"
                  stroke="#6366F1"
                  fill="#6366F1"
                  fillOpacity={0.35}
                />
                <Tooltip contentStyle={{ fontSize: 11 }} />
              </RadarChart>
            </ResponsiveContainer>
          </div>

          {/* Category breakdown */}
          <div className="space-y-2">
            {impactAnalysis.categories.map((cat) => (
              <div
                key={cat.category}
                className="rounded-lg border border-slate-100 p-2.5 hover:bg-slate-50 transition-colors"
                data-testid={`dt-impact-${cat.category}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-medium text-slate-800 capitalize">{cat.category}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${cat.score}%`, backgroundColor: levelToColor(cat.level) }}
                      />
                    </div>
                    <span className="text-xs font-semibold w-8 text-right" style={{ color: levelToColor(cat.level) }}>
                      {cat.score}
                    </span>
                    <ImpactBadge level={cat.level} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {cat.key_drivers.slice(0, 2).map((d) => (
                    <span key={d} className="text-xs text-slate-500 bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded">
                      {d}
                    </span>
                  ))}
                </div>
                {cat.financial_estimate_inr && (
                  <p className="text-xs text-slate-500 mt-1">
                    Estimated financial impact: <strong>{fmtINR(cat.financial_estimate_inr)}</strong>
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </Panel>

      {/* ─── Section 5: AI Recommendations ─────────────────────────────── */}
      <Panel
        title={titleWithIcon('AI Risk Intelligence', Brain, `Confidence: ${fmtPct(aiRecommendations.confidence_score * 100)}`)}
        data-testid="dt-section-ai"
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Narrative */}
          <div className="lg:col-span-2 space-y-3">
            <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
              <div className="flex items-start gap-2">
                <Sparkles className="size-4 text-indigo-400 mt-0.5 shrink-0" aria-hidden />
                <p className="text-sm text-slate-700 leading-relaxed">{aiRecommendations.narrative}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Immediate actions */}
              <div>
                <p className="text-xs font-semibold text-red-700 mb-2 flex items-center gap-1">
                  <AlertTriangle className="size-3" aria-hidden />
                  Immediate Actions
                </p>
                <ul className="space-y-1.5">
                  {aiRecommendations.immediate_actions.map((a, i) => (
                    <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                      <ArrowRight className="size-3 text-red-400 mt-0.5 shrink-0" aria-hidden />
                      {a}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Medium-term actions */}
              <div>
                <p className="text-xs font-semibold text-amber-700 mb-2 flex items-center gap-1">
                  <Target className="size-3" aria-hidden />
                  Medium-Term Actions
                </p>
                <ul className="space-y-1.5">
                  {aiRecommendations.medium_term_actions.map((a, i) => (
                    <li key={i} className="text-xs text-slate-600 flex items-start gap-1.5">
                      <ChevronRight className="size-3 text-amber-400 mt-0.5 shrink-0" aria-hidden />
                      {a}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Risk appetite note */}
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 p-3 bg-slate-50/50">
              <p className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-1">
                <Settings2 className="size-3" aria-hidden />
                Risk Appetite Note
              </p>
              <p className="text-xs text-slate-600 leading-relaxed">
                {aiRecommendations.risk_appetite_note}
              </p>
            </div>
            <div className="rounded-lg border border-green-100 bg-green-50/40 p-3">
              <p className="text-xs font-semibold text-green-700 mb-2">Model Confidence</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-green-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500"
                    style={{ width: `${aiRecommendations.confidence_score * 100}%` }}
                  />
                </div>
                <span className="text-sm font-bold text-green-700">
                  {fmtPct(aiRecommendations.confidence_score * 100)}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1.5">
                Based on {fmtInt(kpis.simulations_run_30d)} historical simulation runs
              </p>
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Section 6: Scenario Comparison ─────────────────────────────── */}
      <Panel
        title={titleWithIcon('Scenario Comparison', BarChart3, 'A vs B stress test delta')}
        data-testid="dt-section-comparison"
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Scenario labels */}
          <div className="space-y-2">
            {[
              { label: 'Scenario A', name: comparison.scenario_a, run: runA, color: 'blue' },
              { label: 'Scenario B', name: comparison.scenario_b, run: runB, color: 'purple' },
            ].map(({ label, name, run, color }) => (
              <div key={label} className={`rounded-lg border border-${color}-200 bg-${color}-50/40 p-3`}>
                <p className="text-xs text-slate-500 font-medium">{label}</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5">{name}</p>
                <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500">
                  <span>Severity: {run.severity_pct}%</span>
                  <span>Impact: <ImpactBadge level={run.impact_level} /></span>
                </div>
              </div>
            ))}
            <div className={`rounded-lg border p-3 ${
              comparison.winner === 'A' ? 'border-blue-300 bg-blue-50' :
              comparison.winner === 'B' ? 'border-purple-300 bg-purple-50' :
              'border-amber-200 bg-amber-50/40'
            }`}>
              <p className="text-xs text-slate-500 font-medium">Preferred Scenario</p>
              <p className="text-sm font-bold mt-0.5">
                {comparison.winner === 'tie' ? 'Comparable risk profiles' :
                 `Scenario ${comparison.winner} preferred`}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {comparison.winner === 'A' ? `Lower severity by ${runA.severity_pct - runB.severity_pct} pp` :
                 comparison.winner === 'B' ? `Lower severity by ${runB.severity_pct - runA.severity_pct} pp` :
                 'Within ±5 pp of each other'}
              </p>
            </div>
          </div>

          {/* Delta metrics */}
          <div className="lg:col-span-2">
            <p className="text-xs text-slate-500 font-medium mb-2 uppercase tracking-wide">Key Delta Metrics (B minus A)</p>
            <div className="space-y-2">
              {[
                { label: 'Risk Score', value: comparison.risk_delta_pp, unit: 'pp', flip: false },
                { label: 'NPA Ratio', value: comparison.npa_delta_pp, unit: 'pp', flip: false },
                { label: 'Solvency Ratio', value: comparison.solvency_delta_pp, unit: 'pp', flip: true },
                { label: 'Compliance Score', value: comparison.compliance_delta_pp, unit: 'pp', flip: true },
                { label: 'Revenue Impact', value: comparison.revenue_delta_inr / 1e7, unit: ' Cr', flip: true },
              ].map(({ label, value, unit, flip }) => {
                const isPositive = value > 0;
                const isGood = flip ? isPositive : !isPositive;
                return (
                  <div key={label} className="flex items-center gap-3">
                    <span className="text-xs text-slate-600 w-32 shrink-0">{label}</span>
                    <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden relative">
                      <div
                        className={`absolute top-0 h-full rounded-full ${isGood ? 'bg-green-400' : 'bg-red-400'}`}
                        style={{
                          width: `${Math.min(Math.abs(value) * 10, 100)}%`,
                          left: value < 0 ? 'auto' : '50%',
                          right: value >= 0 ? 'auto' : '50%',
                        }}
                      />
                    </div>
                    <span className={`text-xs font-medium w-20 text-right ${isGood ? 'text-green-600' : 'text-red-600'}`}>
                      {value > 0 ? '+' : ''}{unit === ' Cr' ? fmtINR(value * 1e7) : `${value.toFixed(2)}${unit}`}
                    </span>
                    {isGood
                      ? <TrendingUp className="size-3.5 text-green-500 shrink-0" aria-hidden />
                      : <TrendingDown className="size-3.5 text-red-500 shrink-0" aria-hidden />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </Panel>

      {/* ─── Section 7: Workflow & Saved Scenarios ───────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="dt-section-workflow">
        {/* Workflow timeline */}
        <Panel title={titleWithIcon('Workflow Timeline', Workflow, 'Maker / Checker / Approver')}>
          <div className="space-y-2">
            {workflowEvents.map((evt, i) => {
              const actionColors: Record<string, string> = {
                submit_for_review: 'bg-blue-100 text-blue-700',
                approve: 'bg-green-100 text-green-700',
                reject: 'bg-red-100 text-red-700',
                archive: 'bg-purple-100 text-purple-700',
                restore: 'bg-amber-100 text-amber-700',
                clone: 'bg-slate-100 text-slate-600',
              };
              return (
                <div key={evt.event_id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${actionColors[evt.action] ?? 'bg-slate-100 text-slate-600'}`}>
                      {i + 1}
                    </div>
                    {i < workflowEvents.length - 1 && (
                      <div className="w-0.5 h-4 bg-slate-200 mt-1" />
                    )}
                  </div>
                  <div className="flex-1 pb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${actionColors[evt.action] ?? 'bg-slate-100 text-slate-600'}`}>
                        {evt.action.replace(/_/g, ' ')}
                      </span>
                      <span className="text-xs text-slate-400">
                        {new Date(evt.ts).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                      </span>
                      {evt.to_state && <StateBadge state={evt.to_state} />}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      <span className="font-medium">{evt.actor}</span> — {evt.comment}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* Saved scenarios list */}
        <Panel title={titleWithIcon('Scenario Library', BookOpen, 'Saved simulation registry')}>
          <div className="space-y-1.5">
            {savedScenarios.slice(0, 8).map((s) => (
              <div key={s.scenario_id} className="flex items-center gap-2 p-2 rounded-lg border border-slate-100 hover:bg-slate-50">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-800 truncate">{s.name}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-slate-400">{DOMAIN_LABELS[s.domain]}</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-400">Runs: {s.run_count}</span>
                    {s.last_run_at && (
                      <>
                        <span className="text-xs text-slate-400">·</span>
                        <span className="text-xs text-slate-400">
                          {new Date(s.last_run_at).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {s.latest_impact_level && <ImpactBadge level={s.latest_impact_level} />}
                  <StateBadge state={s.state} />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* ─── Section 8: Board Reports ────────────────────────────────────── */}
      <Panel
        title={titleWithIcon('Board & Regulatory Reports', FileText, 'Generated risk intelligence packages')}
        data-testid="dt-section-reports"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {boardReports.map((report) => {
            const kindColors: Record<BoardReportKind, string> = {
              board: 'border-blue-200 bg-blue-50/40',
              risk_committee: 'border-orange-200 bg-orange-50/40',
              audit_committee: 'border-purple-200 bg-purple-50/40',
              regulatory: 'border-red-200 bg-red-50/40',
            };
            const kindIcons: Record<BoardReportKind, LucideIcon> = {
              board: Award, risk_committee: ShieldAlert, audit_committee: FileBarChart2, regulatory: Globe,
            };
            const Icon = kindIcons[report.kind];
            return (
              <div
                key={report.report_id}
                className={`rounded-lg border p-3 ${kindColors[report.kind]}`}
                data-testid={`dt-board-${report.kind}`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-slate-500" aria-hidden />
                    <span className="text-sm font-semibold text-slate-800">{BOARD_LABELS[report.kind]}</span>
                  </div>
                  <span className="text-xs text-slate-400 uppercase font-medium">{report.format}</span>
                </div>
                <p className="text-xs text-slate-500">{report.recipient_audience}</p>
                <div className="flex items-center gap-3 mt-2 text-xs text-slate-500">
                  <span>{report.period_label}</span>
                  <span>·</span>
                  <span>{report.scenarios_included} scenarios</span>
                  {report.high_impact_count > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-red-600 font-medium">{report.high_impact_count} high impact</span>
                    </>
                  )}
                </div>
                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-1 flex-wrap">
                    {report.sign_off_required_from.map((s) => (
                      <span key={s} className="text-xs bg-white border border-slate-200 text-slate-600 px-1.5 py-0.5 rounded">
                        {s}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-slate-400">
                    <Clock className="size-3" aria-hidden />
                    {new Date(report.generated_at).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* ─── Cross-IA footer ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1 border-t border-slate-100">
        <span className="font-medium text-slate-500">Digital Twin Phase 17</span>
        <span>·</span>
        <Link to="/data-fabric-center" className="hover:text-indigo-600 transition-colors">Data Fabric</Link>
        <Link to="/enterprise-demo-center" className="hover:text-indigo-600 transition-colors">Enterprise Demo</Link>
        <Link to="/demo-readiness-center" className="hover:text-indigo-600 transition-colors">Demo Readiness</Link>
        <Link to="/analytics" className="hover:text-indigo-600 transition-colors">Analytics</Link>
        <Link to="/scenarios" className="hover:text-indigo-600 transition-colors">Scenario Engine</Link>
        <span className="ml-auto text-slate-300">All 17 IA overlays active</span>
      </div>

      {/* Suppress unused import warnings */}
      {/* suppress unused imports from lucide-react */}
    </div>
  );
}
