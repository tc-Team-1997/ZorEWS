// web/src/modules/dashboard/DashboardPage.tsx
//
// ZorEWS EWS Dashboard — redesigned for correct operational hierarchy.
// Philosophy: "Single Pane of Glass for Early Warning Operations"
//
// Priority order:
//   1. Domain-aware header + business context
//   2. Hero operational KPIs (immediate risk status)
//   3. Top risks right now
//   4. Charts + drilldown (PD trend, alerts)
//   5. Alert analytics workbench
//   6. Executive briefing
//   7. Enterprise Risk Index (analytical)
//   8. Forecasts
//   9. Alerts & Cases side-by-side
//  10. Board view
//  11. All existing operational panels (preserved)
//
// ALL existing widgets, calculations, API calls, and state preserved.
// This is a pure presentation hierarchy reorder + new wrapper sections.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle, ChevronRight, TrendingUp, TrendingDown, Minus,
  Shield, Activity, FileText, Globe, Target, Database,
  Zap, CheckCircle2, Clock, Info, BookOpen, PlayCircle,
  ArrowUpRight,
} from 'lucide-react';
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
import { color } from '@/styles/tokens';
import { useChatContext } from '@/components/copilot/useChatContext';
import { SLABreachMatrix } from '@/components/dashboard/SLABreachMatrix';
import { LiveActivityFeed } from '@/components/dashboard/LiveActivityFeed';
import {
  SeverityDrilldown,
  TrendWeekDrilldown,
} from '@/components/dashboard/AlertDrilldown';
import { AlertAnalyticsSection } from '@/components/dashboard/AlertAnalyticsSection';
import { RecoveryStatsCard } from '@/components/dashboard/RecoveryStatsCard';
import { PortfolioInsightsRow } from '@/modules/dashboard/PortfolioInsightsRow';
import { useAuth } from '@/store/auth';
import { ExportButton } from '@/components/export/ExportButton';
import { buildDashboardReportData } from './dashboardReportAdapter';
import { useDomain, useTenantContext } from '@/lib/useOnboardingContext';
import { getOrganization } from '@/lib/organizations';
import {
  getEnterpriseRiskIndex,
  getExecutiveBriefing,
  getEmergingRisks,
  getAlertRadar,
  getRegulatoryReadiness,
  getForecastStrip,
} from './commandCenterEngine';
import { getWelcomeSnapshot } from '@/components/copilot/copilotEngine';
import { cn } from '@/lib/cn';

// ─── constants ────────────────────────────────────────────────────────────

const SEVERITY_FILL: Record<string, string> = {
  critical: color.danger,
  high: color.warning,
  medium: color.sky,
  low: color.success,
};

const RANGE_LABEL: Record<TimeRangeKey, string> = {
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  all: 'all weeks',
};

const SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'high', 'medium', 'low']);

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
    const idx = parseInt(val, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < trendLen) return { kind: 'week', index: idx };
  }
  return null;
}

// ─── shared helpers ───────────────────────────────────────────────────────

function TrendIcon({ v, size = 12 }: { v: number; size?: number }) {
  if (v > 1) return <TrendingUp size={size} className="text-red-500" />;
  if (v < -1) return <TrendingDown size={size} className="text-green-600" />;
  return <Minus size={size} className="text-gray-400" />;
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-5">
      <div className="flex-1 h-px bg-[#E5E7EB]" />
      <span className="text-[10.5px] font-semibold text-[#9CA3AF] uppercase tracking-[0.1em] px-2 shrink-0">{label}</span>
      <div className="flex-1 h-px bg-[#E5E7EB]" />
    </div>
  );
}

// ─── Section 2: Business Context Panel ────────────────────────────────────

function BusinessContextPanel() {
  const [open, setOpen] = useState(false);

  const INFO_CARDS = [
    { icon: Target,   label: 'Purpose',          value: 'Real-time credit, fraud, compliance & operational risk monitoring across the entire portfolio.' },
    { icon: Activity, label: 'Who Uses It',       value: 'Risk Officers, CROs, Branch Heads, Compliance Managers, Investigation Teams.' },
    { icon: Database, label: 'Data Sources',      value: 'CBS, Bureau, IFRS9, AML Watchlist, Claims System, Policy Master, HR & Operations.' },
    { icon: Clock,    label: 'Refresh',           value: 'KPIs: every 60s · Alerts: every 30s · Predictions: batch 06:00 IST daily.' },
    { icon: FileText, label: 'Output',            value: 'Risk alerts, investigation cases, executive briefings, regulatory filings, board reports.' },
  ];

  return (
    <div className="mb-5">
      <div
        className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden cursor-pointer"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center justify-between px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Info size={13} className="text-[#4F46E5]" strokeWidth={1.75} />
            <span className="text-[12px] font-semibold text-[#111827]">About This Dashboard</span>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/predictive-risk-center" className="flex items-center gap-1 text-[11px] text-[#4F46E5] hover:underline" onClick={e => e.stopPropagation()}>
              <PlayCircle size={11} /> AI Explain Dashboard
            </Link>
            <Link to="/glossary" className="flex items-center gap-1 text-[11px] text-[#4F46E5] hover:underline" onClick={e => e.stopPropagation()}>
              <BookOpen size={11} /> Glossary
            </Link>
            <ChevronRight
              size={13}
              className={cn('text-[#9CA3AF] transition-transform duration-200', open && 'rotate-90')}
            />
          </div>
        </div>

        {open && (
          <div className="border-t border-[#E5E7EB] px-4 py-3 grid grid-cols-2 md:grid-cols-5 gap-3" onClick={e => e.stopPropagation()}>
            {INFO_CARDS.map(({ icon: Icon, label, value }) => (
              <div key={label} className="bg-[#F9FAFB] rounded-[8px] p-2.5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Icon size={12} className="text-[#4F46E5]" strokeWidth={1.75} />
                  <p className="text-[10px] font-bold text-[#6B7280] uppercase tracking-wide">{label}</p>
                </div>
                <p className="text-[11px] text-[#374151] leading-snug">{value}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section 3: Hero Operational KPIs ─────────────────────────────────────

function HeroKpiStrip({
  data, sla, tenantId,
}: {
  data: { customers_monitored: number; high_risk_customers: number; active_alerts: number; cases_open: number; alerts_by_severity?: Array<{ severity: string; count: number }> } | undefined;
  sla: { totals: { breached: number; approaching: number; on_track: number } } | undefined;
  tenantId: string;
}) {
  const snap  = useMemo(() => getWelcomeSnapshot(tenantId), [tenantId]);
  const radar = useMemo(() => getAlertRadar(tenantId), [tenantId]);
  const reg   = useMemo(() => getRegulatoryReadiness(tenantId), [tenantId]);

  const criticalAlerts = data?.alerts_by_severity?.find(r => r.severity === 'critical')?.count
    ?? radar.find(r => r.severity === 'critical')?.count
    ?? snap.criticalAlerts;
  const dqGaps = reg.filter(r => r.status !== 'compliant').length;

  const KPIS = [
    { label: 'Critical Alerts',     value: criticalAlerts,                                   tone: 'danger'  as const, sub: 'requires immediate action', href: '/alerts',                              testId: 'kpi-critical-alerts' },
    { label: 'Open Cases',          value: data?.cases_open ?? snap.activeInvestigations,     tone: 'purple'  as const, sub: 'across all queues',         href: '/cms/cases',                           testId: 'kpi-cases-open' },
    { label: 'High-Risk Accounts',  value: data?.high_risk_customers ?? snap.highRiskAccounts, tone: 'danger' as const, sub: 'PD ≥ 0.5',                  href: '/customers?level=High&pdMin=0.5',       testId: 'kpi-high-risk' },
    { label: 'Active Alerts',       value: data?.active_alerts ?? 0,                          tone: 'warning' as const, sub: 'unresolved',                 href: '/alerts',                              testId: 'kpi-active-alerts' },
    { label: 'SLA Breaches',        value: sla?.totals.breached ?? 0,                         tone: sla?.totals.breached ? 'danger' as const : 'success' as const, sub: `${sla?.totals.approaching ?? 0} approaching`, href: '/cms/cases?breached=true', testId: 'kpi-sla-breaches' },
    { label: 'Recovery Actions',    value: snap.recoveryEvents,                               tone: 'blue'    as const, sub: 'pending review',             href: '/recovery-center',                     testId: 'kpi-recovery' },
    { label: 'Compliance Gaps',     value: dqGaps,                                            tone: dqGaps > 2 ? 'danger' as const : 'warning' as const, sub: 'regulators flagged', href: '/regulatory-compliance-center', testId: 'kpi-compliance' },
    { label: 'Customers Monitored', value: data?.customers_monitored ?? 0,                    tone: 'blue'    as const, sub: 'all portfolios',             href: '/customers',                           testId: 'kpi-customers-monitored' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 mb-5">
      {KPIS.map(({ label, value, tone, sub, href, testId }) => (
        <MetricCard
          key={testId}
          label={label}
          value={typeof value === 'number' ? value.toLocaleString() : value}
          tone={tone}
          sub={sub}
          to={href}
          testId={testId}
        />
      ))}
    </div>
  );
}

// ─── Section 4: Top Risks Right Now ───────────────────────────────────────

function TopRisksPanel({ tenantId }: { tenantId: string }) {
  const risks = useMemo(() => getEmergingRisks(tenantId), [tenantId]);
  const SEV_STYLE = {
    critical: 'bg-red-100 text-red-700 border-red-200',
    high:     'bg-amber-100 text-amber-700 border-amber-200',
    medium:   'bg-indigo-100 text-indigo-700 border-indigo-200',
  };

  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden mb-5">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#F9FAFB] border-b border-[#E5E7EB]">
        <div className="flex items-center gap-2">
          <AlertTriangle size={13} className="text-[#DC2626]" strokeWidth={1.75} />
          <span className="text-[12px] font-semibold text-[#111827]">Top Emerging Risks — Right Now</span>
        </div>
        <Link to="/predictive-risk-center" className="flex items-center gap-0.5 text-[11px] text-[#4F46E5] hover:underline">
          Full Analysis <ChevronRight size={11} />
        </Link>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-0 divide-x divide-y divide-[#F3F4F6]">
        {risks.map((r, i) => (
          <div key={i} className="p-3 hover:bg-[#F9FAFB] transition-colors">
            <div className="flex items-start justify-between gap-2 mb-1.5">
              <p className="text-[12.5px] font-semibold text-[#111827] leading-tight">{r.name}</p>
              <span className={cn('shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full border uppercase', SEV_STYLE[r.severity])}>
                {r.severity}
              </span>
            </div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] text-[#6B7280]">{r.domain}</span>
              <span className="text-[#E5E7EB]">·</span>
              <span className="text-[10px] text-[#6B7280]">{r.daysToMaterial}d to material</span>
            </div>
            <p className="text-[11px] text-[#374151]">{r.impact}</p>
            <div className="flex items-center gap-1 mt-1">
              <TrendIcon v={r.trend === 'accelerating' ? 5 : r.trend === 'decelerating' ? -5 : 0} size={10} />
              <span className="text-[9.5px] text-[#9CA3AF]">{r.trend} · {r.confidence}% conf</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Section 6: Executive Briefing ────────────────────────────────────────

function ExecutiveBriefingPanel({ tenantId, userName }: { tenantId: string; userName: string }) {
  const brief = useMemo(() => getExecutiveBriefing(tenantId, userName), [tenantId, userName]);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#F9FAFB] border-b border-[#E5E7EB]">
        <div className="flex items-center gap-2">
          <Activity size={13} className="text-[#4F46E5]" strokeWidth={1.75} />
          <span className="text-[12px] font-semibold text-[#111827]">Executive Briefing</span>
        </div>
        <Link to="/executive-cockpit" className="flex items-center gap-0.5 text-[11px] text-[#4F46E5] hover:underline">
          Full Cockpit <ChevronRight size={11} />
        </Link>
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Changes */}
        <div>
          <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-2">Today's Movement</p>
          <div className="space-y-1.5">
            {brief.changes.map(c => (
              <div key={c.label} className="flex items-center justify-between">
                <span className="text-[11.5px] text-[#374151]">{c.label}</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[12px] font-bold text-[#111827]">{c.value}</span>
                  <span className={cn('text-[10px] font-medium', c.positive ? 'text-green-600' : 'text-red-500')}>{c.delta}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Priorities */}
        <div>
          <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-2">Priorities</p>
          <div className="space-y-1.5">
            {(expanded ? brief.priorities : brief.priorities.slice(0, 3)).map(p => (
              <div key={p.rank} className="flex items-start gap-2">
                <span className={cn('shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white mt-0.5',
                  p.urgency === 'immediate' ? 'bg-red-500' : p.urgency === 'today' ? 'bg-amber-500' : 'bg-indigo-500')}>
                  {p.rank}
                </span>
                <p className="text-[11.5px] text-[#374151] leading-snug">{p.text}</p>
              </div>
            ))}
            {brief.priorities.length > 3 && (
              <button onClick={() => setExpanded(e => !e)} className="text-[11px] text-[#4F46E5] hover:underline">
                {expanded ? 'Show less' : `+${brief.priorities.length - 3} more`}
              </button>
            )}
          </div>
        </div>
        {/* Actions */}
        <div>
          <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-2">Recommended Actions</p>
          <div className="space-y-1.5">
            {brief.actions.map((a, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <CheckCircle2 size={11} className="text-[#4F46E5] shrink-0 mt-0.5" />
                <p className="text-[11.5px] text-[#374151] leading-snug">{a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Section 7: Enterprise Risk Index ─────────────────────────────────────

function EnterpriseRiskIndexPanel({ tenantId }: { tenantId: string }) {
  const eri = useMemo(() => getEnterpriseRiskIndex(tenantId), [tenantId]);
  const radarData = eri.dimensions.map(d => ({ subject: d.name.replace(' Risk', ''), score: d.score }));
  const BAND_COLOR: Record<string, string> = { low: '#16A34A', medium: '#4F46E5', elevated: '#F59E0B', high: '#DC2626', critical: '#991B1B' };

  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#F9FAFB] border-b border-[#E5E7EB]">
        <div className="flex items-center gap-2">
          <Shield size={13} className="text-[#4F46E5]" strokeWidth={1.75} />
          <span className="text-[12px] font-semibold text-[#111827]">Enterprise Risk Index</span>
        </div>
        <Link to="/executive-cockpit" className="flex items-center gap-0.5 text-[11px] text-[#4F46E5] hover:underline">
          Analytical View <ChevronRight size={11} />
        </Link>
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 shrink-0 rounded-full border-4 flex flex-col items-center justify-center" style={{ borderColor: BAND_COLOR[eri.band] }}>
            <span className="text-2xl font-bold" style={{ color: BAND_COLOR[eri.band] }}>{eri.score}</span>
            <span className="text-[8.5px] font-semibold uppercase tracking-wide text-gray-500">{eri.band}</span>
          </div>
          <div className="space-y-1 flex-1">
            {eri.dimensions.map(d => (
              <div key={d.name} className="flex items-center gap-2">
                <span className="text-[10.5px] text-gray-500 w-28 shrink-0 truncate">{d.name}</span>
                <div className="flex-1 h-1.5 rounded-full bg-gray-100">
                  <div className="h-full rounded-full" style={{ width: `${d.score}%`, background: BAND_COLOR[d.score >= 75 ? 'high' : d.score >= 55 ? 'elevated' : d.score >= 35 ? 'medium' : 'low'] }} />
                </div>
                <span className="text-[10.5px] font-semibold text-gray-700 w-5 text-right shrink-0">{d.score}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData}>
              <PolarGrid stroke="#E5E7EB" />
              <PolarAngleAxis dataKey="subject" tick={{ fontSize: 9, fill: '#6B7280' }} />
              <Radar name="Risk" dataKey="score" stroke="#4F46E5" fill="#4F46E5" fillOpacity={0.12} strokeWidth={1.5} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ─── Section 8: Forecast Strip ────────────────────────────────────────────

function ForecastStrip({ tenantId }: { tenantId: string }) {
  const forecasts = useMemo(() => getForecastStrip(tenantId), [tenantId]);
  const HORIZONS = ['30d', '60d', '90d', '180d'] as const;
  const METRICS = ['NPA Forecast', 'Fraud Exposure', 'Claims Ratio', 'Compliance Score'];

  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#F9FAFB] border-b border-[#E5E7EB]">
        <div className="flex items-center gap-2">
          <TrendingUp size={13} className="text-[#4F46E5]" strokeWidth={1.75} />
          <span className="text-[12px] font-semibold text-[#111827]">Risk Forecast</span>
        </div>
        <Link to="/predictive-risk-center" className="flex items-center gap-0.5 text-[11px] text-[#4F46E5] hover:underline">
          Full Forecast <ChevronRight size={11} />
        </Link>
      </div>
      <div className="p-4 overflow-x-auto">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left text-[10px] font-semibold text-gray-500 pb-2 pr-3">Metric</th>
              {HORIZONS.map(h => <th key={h} className="text-center text-[10px] font-semibold text-gray-500 pb-2 px-3">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {METRICS.map(metric => (
              <tr key={metric} className="hover:bg-gray-50">
                <td className="py-1.5 pr-3 font-medium text-gray-700 whitespace-nowrap">{metric}</td>
                {HORIZONS.map(h => {
                  const item = forecasts.find(f => f.label === metric && f.horizon === h);
                  if (!item) return <td key={h} className="px-3 py-1.5 text-center text-gray-400">—</td>;
                  return (
                    <td key={h} className="px-3 py-1.5 text-center">
                      <span className="font-semibold" style={{ color: item.color }}>{item.value}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Section 10: Board View ───────────────────────────────────────────────

function BoardViewStrip({ tenantId }: { tenantId: string }) {
  const reg = useMemo(() => getRegulatoryReadiness(tenantId), [tenantId]);
  const eri = useMemo(() => getEnterpriseRiskIndex(tenantId), [tenantId]);

  const portfolioHealth = 100 - eri.score;
  const complianceScore = Math.round(reg.reduce((s, r) => s + r.compliance, 0) / reg.length);
  const aiConfidence    = eri.confidence;
  const boardReadiness  = Math.round((portfolioHealth * 0.3 + complianceScore * 0.4 + aiConfidence * 0.3));

  const SCORES = [
    { label: 'Portfolio Health',     score: portfolioHealth, color: portfolioHealth >= 70 ? '#16A34A' : '#F59E0B', href: '/executive-cockpit' },
    { label: 'Risk Appetite',        score: 100 - eri.score, color: '#4F46E5', href: '/executive-cockpit' },
    { label: 'Compliance Readiness', score: complianceScore, color: complianceScore >= 85 ? '#16A34A' : '#F59E0B', href: '/regulatory-compliance-center' },
    { label: 'Operational Stability', score: 88, color: '#16A34A', href: '/operations-center' },
    { label: 'AI Confidence',        score: aiConfidence,   color: '#4F46E5', href: '/ai/governance' },
    { label: 'Board Readiness',      score: boardReadiness, color: boardReadiness >= 75 ? '#16A34A' : '#F59E0B', href: '/board-reporting-center' },
  ];

  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#F9FAFB] border-b border-[#E5E7EB]">
        <div className="flex items-center gap-2">
          <Globe size={13} className="text-[#4F46E5]" strokeWidth={1.75} />
          <span className="text-[12px] font-semibold text-[#111827]">Board View — Executive Scorecards</span>
        </div>
        <Link to="/board-reporting-center" className="flex items-center gap-0.5 text-[11px] text-[#4F46E5] hover:underline">
          Board Reports <ChevronRight size={11} />
        </Link>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-[#F3F4F6]">
        {SCORES.map(({ label, score, color: c, href }) => (
          <Link key={label} to={href} className="flex flex-col items-center justify-center py-3 px-2 hover:bg-[#F9FAFB] transition-colors">
            <div className="w-12 h-12 rounded-full border-[3px] flex items-center justify-center mb-1.5" style={{ borderColor: c }}>
              <span className="text-[14px] font-bold" style={{ color: c }}>{score}</span>
            </div>
            <p className="text-[9.5px] text-center text-[#6B7280] leading-tight">{label}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Main DashboardPage ────────────────────────────────────────────────────

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

  // Existing API queries — fully preserved
  const { data } = useQuery({
    queryKey: ['dashboard.summary'],
    queryFn: api.dashboardSummary,
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
  const drill = parseDrillParam(searchParams.get('drill'), trendSlice.length);
  const drillSeverity   = drill?.kind === 'severity' ? drill.severity   : null;
  const drillWeekIndex  = drill?.kind === 'week'     ? drill.index      : null;
  const setDrillParam = (next: string | null) => {
    const sp = new URLSearchParams(searchParams);
    if (next) sp.set('drill', next); else sp.delete('drill');
    setSearchParams(sp, { replace: true });
  };
  const onBarClick  = (sev: Severity) => setDrillParam(drillSeverity === sev ? null : `severity:${sev}`);
  const onTrendClick = (idx: number)  => setDrillParam(drillWeekIndex === idx ? null : `week:${idx}`);
  const closeDrill  = () => setDrillParam(null);

  // Context
  const user       = useAuth((s) => s.user);
  const [domain]   = useDomain();
  const [tenantCtx] = useTenantContext();
  const tenantId   = tenantCtx?.tenant_id ?? 'BANK_DEMO';
  const userName   = user?.display_name ?? user?.username?.split('.')[0] ?? 'Executive';
  const orgName    = (() => {
    if (tenantCtx?.organization_id) {
      const org = getOrganization(tenantCtx.organization_id);
      if (org) return org.short_name ?? org.name;
    }
    return tenantId === 'BIL' ? 'BIL Insurance' : 'Banking Enterprise';
  })();
  const domainLabel = domain === 'insurance' ? 'Insurance' : 'Banking';
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <div className="space-y-0">

      {/* ─── SECTION 1: Domain-aware Header ───────────────────────────── */}
      <div className="mb-4">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-[18px] font-bold text-[#111827] leading-tight">
              EWS Dashboard — {domainLabel}
            </h1>
            <p className="text-[11.5px] text-[#6B7280] mt-0.5">
              Real-time Early Warning Intelligence · Updated {timeStr}, {dateStr}
            </p>
          </div>
          {/* Context strip — single tenant chip, no duplication */}
          <div className="flex items-center gap-2.5 flex-wrap">
            {/* Unified tenant chip */}
            <div className="flex items-center gap-2 bg-white border border-[#E5E7EB] rounded-[8px] px-2.5 py-1.5 min-w-0">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-[#1F2937] leading-tight truncate max-w-[160px]">
                  {tenantCtx?.organization_id
                    ? getOrganization(tenantCtx.organization_id)?.name ?? orgName
                    : tenantId === 'BIL' ? 'BIL Insurance Platform' : 'ZorFino Bank Demo'}
                </p>
                <p className="text-[9px] text-[#9CA3AF] leading-tight">
                  {domainLabel} · {orgName}
                </p>
              </div>
            </div>
            <ExportButton
              module="executive_dashboard"
              reportType="executive"
              adapter={(config) =>
                buildDashboardReportData(
                  {
                    summary: {
                      customers_monitored: data?.customers_monitored ?? 0,
                      high_risk_customers: data?.high_risk_customers ?? 0,
                      active_alerts: data?.active_alerts ?? 0,
                      cases_open: data?.cases_open ?? 0,
                      alerts_by_severity: data?.alerts_by_severity ?? [],
                    },
                    meta: { tenant_id: tenantId, generated_by: user?.username ?? 'operator', role: user?.roles?.[0] ?? 'admin' },
                  },
                  config,
                )
              }
            />
            <Link to="/executive-cockpit" className="flex items-center gap-1.5 bg-[#4F46E5] text-white rounded-[8px] px-3 py-1.5 text-[11px] font-medium hover:bg-[#4338CA] transition-colors shrink-0">
              Executive Cockpit <ArrowUpRight size={11} />
            </Link>
          </div>
        </div>
      </div>

      {/* ─── SECTION 2: Business Context Panel ─────────────────────────── */}
      <BusinessContextPanel />

      {/* ─── SECTION 3: Hero Operational KPIs ──────────────────────────── */}
      <HeroKpiStrip data={data} sla={sla.data} tenantId={tenantId} />

      {/* ─── SECTION 4: Top Risks Right Now ─────────────────────────────── */}
      <TopRisksPanel tenantId={tenantId} />

      {/* ─── Operational charts (PD Trend + Alerts bar) — preserved ─────── */}
      <SectionDivider label="Operational Analytics" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <Panel
          title={`Portfolio PD trend · ${RANGE_LABEL[range]}`}
          className="lg:col-span-2"
          action={<TimeRangeSelector value={range} onChange={setRange} testId="pd-trend-range" />}
        >
          <p className="caption mb-1" data-testid="pd-trend-drill-hint">
            Click any point to drill into that week's severity mix, top firing rules, and most-affected customers.
          </p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendSlice}>
                <CartesianGrid stroke={color.divider} strokeDasharray="3 3" />
                <XAxis dataKey="week" stroke={color.muted} fontSize={11} />
                <YAxis stroke={color.muted} fontSize={11} tickFormatter={(v) => `${(v * 100).toFixed(1)}%`} />
                <Tooltip
                  contentStyle={{ background: color.surface, border: `1px solid ${color.divider}`, fontSize: 12 }}
                  formatter={(v) => `${(Number(v) * 100).toFixed(2)}%`}
                />
                <Line
                  type="monotone" dataKey="pd" stroke={color.blue} strokeWidth={2}
                  dot={{ r: 3, fill: color.blue, cursor: 'pointer' }}
                  activeDot={{ r: 5, fill: color.blue, cursor: 'pointer',
                    onClick: (_e, payload) => {
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
            Click a bar to drill into top rules, customers, age distribution, and assignment status.
          </p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data?.alerts_by_severity ?? []}
                onClick={(state) => {
                  const sev = (state as { activePayload?: { payload?: { severity?: Severity } }[] })
                    ?.activePayload?.[0]?.payload?.severity;
                  if (sev) onBarClick(sev);
                }}
              >
                <CartesianGrid stroke={color.divider} strokeDasharray="3 3" />
                <XAxis dataKey="severity" stroke={color.muted} fontSize={11} />
                <YAxis stroke={color.muted} fontSize={11} />
                <Tooltip contentStyle={{ background: color.surface, border: `1px solid ${color.divider}`, fontSize: 12 }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]} cursor="pointer">
                  {(data?.alerts_by_severity ?? []).map((row) => (
                    <Cell key={row.severity} fill={SEVERITY_FILL[row.severity] ?? color.blue} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
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

      {/* Drilldown panels — preserved */}
      {drillSeverity && (
        <div className="mb-4">
          <SeverityDrilldown severity={drillSeverity} onClose={closeDrill} />
        </div>
      )}
      {drillWeekIndex !== null && trendSlice[drillWeekIndex] && (
        <div className="mb-4">
          <TrendWeekDrilldown
            week={trendSlice[drillWeekIndex].week}
            pd={trendSlice[drillWeekIndex].pd}
            prevPd={drillWeekIndex > 0 ? trendSlice[drillWeekIndex - 1].pd : null}
            onClose={closeDrill}
          />
        </div>
      )}

      {/* Alert analytics workbench */}
      <AlertAnalyticsSection />

      {/* ─── SECTION 6: Executive Briefing ───────────────────────────────── */}
      <SectionDivider label="Executive Intelligence" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          <ExecutiveBriefingPanel tenantId={tenantId} userName={userName} />
        </div>
        <div>
          {/* Investigation Health sidebar */}
          <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden h-full">
            <div className="px-4 py-2.5 bg-[#F9FAFB] border-b border-[#E5E7EB] flex items-center gap-2">
              <Zap size={13} className="text-[#4F46E5]" strokeWidth={1.75} />
              <span className="text-[12px] font-semibold text-[#111827]">Quick Actions</span>
            </div>
            <div className="p-3 space-y-2">
              {[
                { label: 'Create Investigation', href: '/investigation-center', color: 'bg-red-500' },
                { label: 'Escalate Alert',       href: '/alerts',              color: 'bg-amber-500' },
                { label: 'Compliance Overview',  href: '/regulatory-compliance-center', color: 'bg-indigo-500' },
                { label: 'Generate Board Report', href: '/board-reporting-center',      color: 'bg-slate-600' },
                { label: 'Export Summary',        href: '/reports',              color: 'bg-gray-500' },
              ].map(({ label, href, color: bg }) => (
                <Link key={label} to={href}
                  className="flex items-center justify-between px-3 py-2 rounded-[8px] bg-[#F9FAFB] hover:bg-[#EEF2FF] border border-[#E5E7EB] hover:border-indigo-200 transition-colors group">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${bg}`} />
                    <span className="text-[12px] text-[#374151] font-medium">{label}</span>
                  </div>
                  <ChevronRight size={11} className="text-[#9CA3AF] group-hover:text-[#4F46E5] transition-colors" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ─── SECTION 7: Enterprise Risk Index ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <EnterpriseRiskIndexPanel tenantId={tenantId} />
        <ForecastStrip tenantId={tenantId} />
      </div>

      {/* ─── SECTION 9: Alerts & Cases side-by-side ─────────────────────── */}
      <SectionDivider label="Cases, Alerts & SLA Status" />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          <SLABreachMatrix />
        </div>
        <div>
          <LiveActivityFeed />
        </div>
      </div>

      {sla.data && <SlaPanel summary={sla.data} />}

      {/* ─── Recovery + Portfolio (existing, preserved) ─────────────────── */}
      <div className="mt-4">
        <RecoveryStatsCard />
      </div>

      <PortfolioInsightsRow />

      {/* ─── SECTION 10: Board View ───────────────────────────────────────── */}
      <SectionDivider label="Board View" />
      <BoardViewStrip tenantId={tenantId} />

    </div>
  );
}

// ─── SlaPanel (preserved exactly) ──────────────────────────────────────────

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
                <td className={`text-right tabular ${row.breached > 0 ? 'text-danger font-semibold' : 'text-sub'}`}>{row.breached}</td>
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
              <li key={c.case_id} className="flex items-start gap-2 rounded border border-danger/20 bg-danger-bg/40 p-2">
                <AlertTriangle size={14} className="text-danger mt-[2px]" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-ink">{c.case_id}</span>
                    <span className="text-[10px] uppercase tracking-wide text-danger font-semibold">{c.severity}</span>
                  </div>
                  <div className="text-[11px] text-sub">
                    {c.stage} stage ·{' '}
                    <span className="text-danger tabular">{Math.abs(c.minutes_remaining ?? 0).toFixed(0)} min overdue</span>
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
