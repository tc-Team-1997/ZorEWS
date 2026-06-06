// web/src/modules/dashboard/roleEngine/RoleBasedDashboardPage.tsx
//
// Dynamic Dashboard Intelligence Layer — enhanced Role-Based Dashboard.
//
// Adds 10 new intelligence phases on top of the existing engine (additive):
//   Phase 1:  Context-aware (role × domain × risk)
//   Phase 2:  Workload-aware (my alerts, cases, investigations, approvals)
//   Phase 3:  Risk-aware (dynamic promotion on risk elevation)
//   Phase 4:  Domain-aware (banking / insurance widget sets)
//   Phase 5:  Executive Auto-Briefing (AI-generated daily card)
//   Phase 6:  Smart Widget Prioritization (6-axis scoring)
//   Phase 7:  Personalization (pin / hide / reorder / named views)
//   Phase 8:  Multi-Layout Support (8 layout presets)
//   Phase 9:  AI Recommendations (copilot suggestions in sidebar)
//   Phase 10: Executive Scorecard Strip (persistent top bar)
//
// The existing DashboardPage at "/" and the original RoleBasedDashboardPage
// logic (resolveRoleDefaultDashboard, KPI strip, AI insights, widget grid)
// are ALL preserved — new phases are additive layers on top.

import { useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Cog,
  Compass,
  ExternalLink,
  Pin,
  Sparkles,
  AlertTriangle,
  ChevronRight,
  Eye,
  EyeOff,
  RotateCcw,
  Zap,
  TrendingUp,
  Activity,
  LayoutDashboard,
  Shield,
  Target,
  Globe,
} from 'lucide-react';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import { useDomain } from '@/lib/useOnboardingContext';
import { resolveRoleDefaultDashboard } from './roleDashboardEngine';
import type { DashboardContext } from './roleDashboardEngine';
import type { WidgetDef, WidgetRole } from './widgetRegistry';
import { generateAiInsights } from './aiInsights';
import type { AiInsightSeverity } from './aiInsights';
import { cn } from '@/lib/cn';
// ── Phase 1: Context Resolver ──
import { resolveFullContext } from './dashboardContextResolver';
// ── Phase 6: Priority Engine ──
import { prioritizeWidgets } from './dashboardPriorityEngine';
import type { ScoredWidget } from './dashboardPriorityEngine';
// ── Phase 7: Personalization Engine ──
import {
  loadPersonalization,
  savePersonalization,
  applyPersonalization,
  togglePin,
  toggleHide,
  resetLayout,
  setActiveView,
  NAMED_VIEWS,
} from './dashboardPersonalizationEngine';
import type { NamedViewId } from './dashboardPersonalizationEngine';
// ── Phase 5: Executive Briefing Engine ──
import { generateExecutiveBriefing } from './executiveBriefingEngine';
import type { BriefingItem } from './executiveBriefingEngine';

const SEVERITY_TONE: Record<AiInsightSeverity, 'neutral' | 'blue' | 'warning' | 'danger'> = {
  info: 'blue',
  watch: 'neutral',
  warning: 'warning',
  critical: 'danger',
};

const ELEVATION_STYLE = {
  normal:   { bar: 'bg-green-500',  label: 'Normal',   text: 'text-green-700',  bg: 'bg-green-50'  },
  elevated: { bar: 'bg-amber-500',  label: 'Elevated', text: 'text-amber-700',  bg: 'bg-amber-50'  },
  high:     { bar: 'bg-orange-500', label: 'High',     text: 'text-orange-700', bg: 'bg-orange-50' },
  critical: { bar: 'bg-red-600',    label: 'Critical', text: 'text-red-700',    bg: 'bg-red-50'    },
} as const;

const URGENCY_STYLE = {
  immediate:   { dot: 'bg-red-500',   label: 'Immediate' },
  today:       { dot: 'bg-amber-500', label: 'Today'     },
  'this-week': { dot: 'bg-blue-500',  label: 'This week' },
} as const;

// ─── Phase 10: Executive Scorecard Strip ──────────────────────────────────

function ExecutiveScorecardStrip({ scores }: {
  scores: Array<{ label: string; score: number; icon: React.ElementType; color: string; href: string }>;
}) {
  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[10px] overflow-hidden mb-4">
      <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-[#F3F4F6]">
        {scores.map(({ label, score, icon: Icon, color, href }) => (
          <Link key={label} to={href}
            className="flex flex-col items-center justify-center py-2.5 px-1 hover:bg-[#F9FAFB] transition-colors group">
            <div className="w-8 h-8 rounded-full border-2 flex items-center justify-center mb-1" style={{ borderColor: color }}>
              <span className="text-[11px] font-bold" style={{ color }}>{score}</span>
            </div>
            <Icon size={10} className="mb-0.5" style={{ color }} />
            <p className="text-[8.5px] text-center text-[#9CA3AF] leading-tight">{label}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Phase 5: Executive Briefing Card ────────────────────────────────────

function ExecutiveBriefingCard({ briefing }: { briefing: ReturnType<typeof generateExecutiveBriefing> }) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = expanded ? briefing.items : briefing.items.slice(0, 3);

  return (
    <div className="bg-white border border-[#E5E7EB] rounded-[12px] overflow-hidden mb-4">
      <div className="flex items-center justify-between px-4 py-2.5 bg-gradient-to-r from-[#4F46E5] to-[#7C3AED]">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-white" strokeWidth={1.75} />
          <span className="text-[12px] font-semibold text-white">{briefing.greeting} · AI Briefing</span>
          {briefing.immediateCount > 0 && (
            <span className="text-[9px] font-bold bg-red-500 text-white px-1.5 py-0.5 rounded-full">
              {briefing.immediateCount} immediate
            </span>
          )}
        </div>
        <span className="text-[10px] text-indigo-200">{briefing.subheadline}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-[12px] text-[#374151] mb-3 leading-relaxed">{briefing.headline}</p>
        <div className="space-y-2">
          {visibleItems.map((item: BriefingItem, i: number) => {
            const urg = URGENCY_STYLE[item.urgency];
            return (
              <div key={i} className="flex items-start gap-2.5 rounded-[8px] bg-[#F9FAFB] px-3 py-2 hover:bg-[#EEF2FF] transition-colors">
                <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${urg.dot}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-[#111827] leading-tight">{item.title}</p>
                  <p className="text-[10.5px] text-[#6B7280] mt-0.5 leading-snug">{item.detail}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[9px] text-[#9CA3AF]">{urg.label}</span>
                  {item.href && (
                    <Link to={item.href} className="text-[10px] text-[#4F46E5] hover:underline flex items-center gap-0.5">
                      View <ChevronRight size={9} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {briefing.items.length > 3 && (
          <button onClick={() => setExpanded(e => !e)} className="text-[11px] text-[#4F46E5] mt-2 hover:underline">
            {expanded ? 'Show less' : `+${briefing.items.length - 3} more items`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Phase 7: Personalization Toolbar ────────────────────────────────────

function PersonalizationToolbar({
  activeView, onViewChange, onReset,
}: {
  activeView: NamedViewId;
  onViewChange: (v: NamedViewId) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap mb-3">
      <span className="text-[10px] font-semibold text-[#9CA3AF] uppercase tracking-widest shrink-0">Layout:</span>
      {NAMED_VIEWS.map(v => (
        <button
          key={v.id}
          title={v.description}
          onClick={() => onViewChange(v.id as NamedViewId)}
          className={cn(
            'text-[11px] px-2.5 py-1 rounded-[6px] border font-medium transition-colors',
            activeView === v.id
              ? 'bg-[#4F46E5] text-white border-[#4F46E5]'
              : 'bg-white text-[#374151] border-[#E5E7EB] hover:border-[#4F46E5]/40 hover:text-[#4F46E5]',
          )}
        >
          {v.label}
        </button>
      ))}
      <button
        onClick={onReset}
        className="ml-auto flex items-center gap-1 text-[10.5px] text-[#9CA3AF] hover:text-[#4F46E5] transition-colors"
        title="Reset to default layout"
      >
        <RotateCcw size={11} /> Reset
      </button>
    </div>
  );
}

// ─── Phase 3: Risk Elevation Banner ──────────────────────────────────────

function RiskElevationBanner({ elevation, criticalAlerts, fraudClusters }: {
  elevation: keyof typeof ELEVATION_STYLE;
  criticalAlerts: number;
  fraudClusters: number;
}) {
  if (elevation === 'normal') return null;
  const style = ELEVATION_STYLE[elevation];
  return (
    <div className={cn('flex items-center gap-3 rounded-[10px] px-4 py-2.5 mb-4 border', style.bg,
      elevation === 'critical' ? 'border-red-200' : elevation === 'high' ? 'border-orange-200' : 'border-amber-200')}>
      <AlertTriangle size={15} className={style.text} strokeWidth={1.75} />
      <div className="flex-1 min-w-0">
        <span className={cn('text-[12px] font-bold', style.text)}>Risk Elevation: {style.label}</span>
        <span className="text-[11px] text-[#374151] ml-2">
          {criticalAlerts} critical alerts · {fraudClusters} fraud cluster{fraudClusters !== 1 ? 's' : ''} · Dashboard auto-promoted high-priority widgets
        </span>
      </div>
      <Link to="/alerts" className={cn('text-[11px] hover:underline shrink-0', style.text)}>
        View Alerts <ChevronRight size={10} className="inline" />
      </Link>
    </div>
  );
}

// ─── Phase 2: Workload Strip ──────────────────────────────────────────────

function WorkloadStrip({ workload }: { workload: ReturnType<typeof resolveFullContext>['workload'] }) {
  const ITEMS = [
    { label: 'My Alerts',     value: workload.myAlerts,          href: '/alerts',                              alert: workload.myAlerts >= 5 },
    { label: 'My Cases',      value: workload.myCases,           href: '/cms/cases',                           alert: workload.myCases >= 8 },
    { label: 'Investigations',value: workload.myInvestigations,  href: '/investigation-center',                 alert: workload.myInvestigations >= 3 },
    { label: 'Escalations',   value: workload.myEscalations,     href: '/cms/cases?status=ESCALATED',          alert: workload.myEscalations >= 2 },
    { label: 'Recoveries',    value: workload.myRecoveries,      href: '/recovery-center',                     alert: false },
    { label: 'Approvals',     value: workload.myApprovals,       href: '/cms/cases?status=PENDING_APPROVAL',   alert: workload.myApprovals >= 3 },
    { label: 'Reg Tasks',     value: workload.myRegulatoryTasks, href: '/regulatory-compliance-center',        alert: workload.myRegulatoryTasks >= 4 },
    { label: 'SLA Breaches',  value: workload.mySlaBreaches,     href: '/cms/cases?breached=true',             alert: workload.mySlaBreaches >= 1 },
  ];
  return (
    <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 mb-4">
      {ITEMS.map(({ label, value, href, alert }) => (
        <Link key={label} to={href}
          className={cn('flex flex-col items-center rounded-[10px] py-2.5 px-2 border hover:border-indigo-300 transition-colors text-center',
            alert ? 'bg-red-50 border-red-200' : 'bg-white border-[#E5E7EB]')}>
          <span className={cn('text-[20px] font-bold leading-none', alert ? 'text-red-600' : 'text-[#111827]')}>{value}</span>
          <span className={cn('text-[9.5px] mt-0.5', alert ? 'text-red-500 font-medium' : 'text-[#9CA3AF]')}>{label}</span>
        </Link>
      ))}
    </div>
  );
}

// ─── Phase 6: Scored Widget Card ──────────────────────────────────────────

function ScoredWidgetCard({ widget, onPin, onHide, isPinned, isHidden }: {
  widget: ScoredWidget | WidgetDef;
  onPin: (id: string) => void;
  onHide: (id: string) => void;
  isPinned: boolean;
  isHidden: boolean;
}) {
  const scored = 'priorityScore' in widget ? widget as ScoredWidget : null;
  const urgency = scored?.urgencyBadge;
  const URGENCY_COLOR = { critical: 'text-red-600 bg-red-50 border-red-200', high: 'text-amber-600 bg-amber-50 border-amber-200', elevated: 'text-orange-600 bg-orange-50 border-orange-200' } as const;

  return (
    <div className={cn('bg-white border rounded-[10px] p-3 hover:border-indigo-300 transition-all group relative',
      isPinned ? 'border-indigo-300 shadow-sm' : 'border-[#E5E7EB]',
      scored?.isPromoted ? 'ring-1 ring-amber-300' : '',
    )}>
      {isPinned && <Pin size={10} className="absolute top-2 right-2 text-indigo-400" />}
      {urgency && (
        <span className={cn('absolute top-2 left-2 text-[8.5px] font-bold px-1.5 py-0.5 rounded-full border', URGENCY_COLOR[urgency])}>
          {urgency.toUpperCase()}
        </span>
      )}
      <div className={cn('mt-1', isPinned || urgency ? 'mt-4' : '')}>
        <p className="text-[12.5px] font-semibold text-[#111827] leading-tight mb-1">{widget.label}</p>
        <p className="text-[10.5px] text-[#6B7280] leading-snug mb-2">{'description' in widget ? widget.description : ''}</p>
        {scored && (
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1">
              <div className="h-1 w-16 rounded-full bg-[#E5E7EB]">
                <div className="h-full rounded-full bg-indigo-500" style={{ width: `${scored.priorityScore}%` }} />
              </div>
              <span className="text-[9px] text-[#9CA3AF]">{scored.priorityScore}</span>
            </div>
            {scored.isPromoted && <TrendingUp size={10} className="text-amber-500" />}
          </div>
        )}
        <div className="flex items-center gap-2">
          {'drill_to' in widget && widget.drill_to && (
            <Link to={widget.drill_to} className="flex items-center gap-0.5 text-[10.5px] text-[#4F46E5] hover:underline">
              Open <ExternalLink size={9} />
            </Link>
          )}
          <div className="ml-auto flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => onPin(widget.id)} title={isPinned ? 'Unpin' : 'Pin'} className="text-[#9CA3AF] hover:text-indigo-500 transition-colors">
              <Pin size={11} className={isPinned ? 'fill-indigo-400 text-indigo-400' : ''} />
            </button>
            <button onClick={() => onHide(widget.id)} title="Hide widget" className="text-[#9CA3AF] hover:text-red-500 transition-colors">
              {isHidden ? <Eye size={11} /> : <EyeOff size={11} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Map backend role + enterprise role overlay to a WidgetRole ───────────

// Map backend role + enterprise role overlay to a WidgetRole.
function resolveDashboardRole(roles: readonly string[] | null | undefined): WidgetRole {
  if (!roles || roles.length === 0) return 'field_officer';
  // Priority: enterprise roles win when present, else fall through to backend.
  if (roles.includes('super_admin')) return 'super_admin';
  if (roles.includes('country_admin')) return 'country_admin';
  if (roles.includes('bank_admin')) return 'bank_admin';
  if (roles.includes('insurance_admin')) return 'insurance_admin';
  if (roles.includes('executive')) return 'executive';
  if (roles.includes('auditor')) return 'auditor';
  if (roles.includes('fraud_analyst')) return 'fraud_analyst';
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('supervisor')) return 'supervisor';
  if (roles.includes('risk_analyst')) return 'risk_analyst';
  if (roles.includes('collection_officer')) return 'collection_officer';
  return 'field_officer';
}

export function RoleBasedDashboardPage() {
  const user = useAuth((s) => s.user);
  const [domain] = useDomain();

  // ── Existing engine: unchanged ──────────────────────────────────────────
  const context: DashboardContext = useMemo(() => ({
    role: resolveDashboardRole(user?.roles),
    domain: (domain === 'banking' || domain === 'insurance') ? domain : 'both',
    country: null,
    tenant_id: null,
    branch_id: null,
  }), [user?.roles, domain]);

  const resolved = useMemo(() => resolveRoleDefaultDashboard(context), [context]);
  const insights = useMemo(() => generateAiInsights(context.role, context.domain, new Date()), [context.role, context.domain]);

  const kpiWidgets = resolved.widgets.filter((w) => w.category === 'executive_kpi' && w.kind === 'kpi');
  const bodyWidgets = resolved.widgets.filter((w) => !(w.category === 'executive_kpi' && w.kind === 'kpi'));

  // ── Phase 1: Full context (workload + risk + behaviour) ─────────────────
  const fullCtx = useMemo(() => resolveFullContext(context), [context]);

  // ── Phase 5: Executive briefing ─────────────────────────────────────────
  const briefing = useMemo(() => generateExecutiveBriefing(fullCtx), [fullCtx]);

  // ── Phase 6: Priority scoring on body widgets ───────────────────────────
  const scoredWidgets = useMemo(() => prioritizeWidgets(bodyWidgets, fullCtx), [bodyWidgets, fullCtx]);

  // ── Phase 7: Personalization state ─────────────────────────────────────
  const [personalization, setPersonalization] = useState(() => loadPersonalization());
  const finalWidgets = useMemo(
    () => applyPersonalization(scoredWidgets, personalization),
    [scoredWidgets, personalization],
  );

  const persist = useCallback((next: typeof personalization) => {
    setPersonalization(next);
    savePersonalization(next);
  }, []);
  const handlePin  = useCallback((id: string) => persist(togglePin(personalization, id)),  [personalization, persist]);
  const handleHide = useCallback((id: string) => persist(toggleHide(personalization, id)), [personalization, persist]);
  const handleReset = useCallback(() => persist(resetLayout(personalization)),              [personalization, persist]);
  const handleViewChange = useCallback((v: NamedViewId) => persist(setActiveView(personalization, v)), [personalization, persist]);

  const prefMap = new Map(personalization.preferences.map(p => [p.widgetId, p]));

  // ── Phase 10: Scorecard data (lightweight computed from context) ─────────
  const scorecardData = useMemo(() => [
    { label: 'Enterprise Risk',   score: 100 - fullCtx.risk.criticalAlerts * 5,           color: '#4F46E5', icon: Shield,          href: '/executive-cockpit' },
    { label: 'Compliance Health', score: Math.max(60, 95 - fullCtx.risk.complianceBreaches * 8), color: '#16A34A', icon: Target, href: '/regulatory-compliance-center' },
    { label: 'Recovery Eff.',     score: Math.round(65 + fullCtx.workload.myRecoveries * 2), color: '#F59E0B', icon: Activity,       href: '/recovery-center' },
    { label: 'Investigation',     score: Math.max(40, 90 - fullCtx.workload.myInvestigations * 3), color: '#6366F1', icon: Globe, href: '/investigation-center' },
    { label: 'Data Quality',      score: 88, color: '#0EA5E9',                              icon: TrendingUp,     href: '/data-fabric-center' },
    { label: 'AI Confidence',     score: 85, color: '#7C3AED',                              icon: Sparkles,       href: '/ai/governance' },
    { label: 'Operational',       score: 91, color: '#059669',                              icon: Zap,            href: '/operations-center' },
    { label: 'Board Readiness',   score: Math.round(75 + fullCtx.risk.complianceBreaches < 2 ? 10 : 0), color: '#374151', icon: LayoutDashboard, href: '/board-reporting-center' },
  ], [fullCtx]);

  return (
    <div data-testid="role-based-dashboard-page">
      <PageHeader
        title={`Dynamic Dashboard — ${context.role.replace(/_/g, ' ')} · ${context.domain}`}
        subtitle={`Role + Context + Workload + Risk aware · ${resolved.widgets.length} widgets · Priority engine active · ${fullCtx.risk.elevation} risk`}
      />

      {/* ── Phase 10: Executive Scorecard Strip ──────────────────────────── */}
      <ExecutiveScorecardStrip scores={scorecardData} />

      {/* ── Phase 3: Risk Elevation Banner ───────────────────────────────── */}
      <RiskElevationBanner
        elevation={fullCtx.risk.elevation}
        criticalAlerts={fullCtx.risk.criticalAlerts}
        fraudClusters={fullCtx.risk.fraudClusters}
      />

      {/* ── Phase 5: Executive Auto-Briefing ─────────────────────────────── */}
      <ExecutiveBriefingCard briefing={briefing} />

      {/* ── Phase 2: Workload Strip ───────────────────────────────────────── */}
      <WorkloadStrip workload={fullCtx.workload} />

      {/* ── Phase 7+8: Personalization Toolbar ───────────────────────────── */}
      <PersonalizationToolbar
        activeView={personalization.activeView}
        onViewChange={handleViewChange}
        onReset={handleReset}
      />

      {/* ── Governance banner (existing, preserved) ───────────────────────── */}
      <Panel className="mb-4" data-testid="role-dashboard-governance-banner">
        <div className="flex items-start gap-3 text-sm text-ink">
          <Compass size={18} className="text-action shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Dynamic Intelligence Layer active — additive overlay (zero existing widgets touched).</div>
            <p className="text-muted text-xs mt-0.5">
              6-axis priority scoring (role · risk · activity · workload · domain · trend) reorders widgets per context.
              Phase 7 personalization: pin / hide / reorder / named views. Production: <code>app_iam.dashboard_widget_preferences</code>.
            </p>
          </div>
        </div>
      </Panel>

      {/* ── 8-tile Executive KPI strip ──────────────────────────────────── */}
      {kpiWidgets.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" data-testid="role-dashboard-kpi-strip">
          {kpiWidgets.map((w) => (
            <Link
              key={w.id}
              to={w.drill_to ?? '#'}
              className="block"
              data-testid={`role-kpi-${w.id}`}
            >
              <MetricCard label={w.label} value="—" sub={w.description.slice(0, 60)} />
            </Link>
          ))}
        </div>
      )}

      {/* ── AI Insights panel ──────────────────────────────────────────── */}
      <Panel className="mb-4" data-testid="role-dashboard-ai-insights">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={16} className="text-aurora-indigo" />
          <h3 className="font-display text-[14px] font-semibold text-ink">AI Insights</h3>
          <Badge tone="blue">{insights.length}</Badge>
        </div>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {insights.map((card) => (
            <li
              key={card.id}
              className="p-3 rounded-md border border-aurora-line bg-white hover:border-action transition-colors"
              data-testid={`role-insight-${card.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-[13px] font-semibold text-aurora-ink">{card.title}</h4>
                <Badge tone={SEVERITY_TONE[card.severity]}>{card.severity}</Badge>
              </div>
              <p className="mt-1 text-[12px] text-aurora-ink-sub leading-snug">{card.body}</p>
              {card.drill_to && (
                <Link
                  to={card.drill_to}
                  className="mt-2 inline-flex items-center gap-1 text-[12px] text-action hover:underline"
                  data-testid={`role-insight-drill-${card.id}`}
                >
                  Investigate <ExternalLink size={11} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── Phase 6+7: Prioritized + Personalized Widget Grid ─────────── */}
      <Panel data-testid="role-dashboard-widget-grid"
        title={`Your Dashboard · ${personalization.activeView !== 'default' ? `${personalization.activeView} view · ` : ''}${finalWidgets.length} widgets`}>
        {finalWidgets.length === 0 && (
          <p className="text-sm text-muted" data-testid="role-dashboard-empty-state">
            No widgets resolved for your current context. Try switching to "My Dashboard" view or contact an admin.
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {finalWidgets.map((w) => (
            <ScoredWidgetCard
              key={w.id}
              widget={w}
              onPin={handlePin}
              onHide={handleHide}
              isPinned={prefMap.get(w.id)?.pinned ?? false}
              isHidden={prefMap.get(w.id)?.hidden ?? false}
            />
          ))}
        </div>
        {/* Show hidden widgets count */}
        {personalization.preferences.filter(p => p.hidden).length > 0 && (
          <p className="text-[11px] text-[#9CA3AF] mt-3">
            {personalization.preferences.filter(p => p.hidden).length} widget(s) hidden by you ·{' '}
            <button onClick={handleReset} className="text-[#4F46E5] hover:underline">Restore all</button>
          </p>
        )}
      </Panel>

      {/* ── Hidden widgets transparency (governance) ────────────────────── */}
      {resolved.excluded.length > 0 && (
        <Panel className="mt-4" data-testid="role-dashboard-excluded">
          <div className="flex items-center gap-2 mb-2">
            <Cog size={14} className="text-muted" />
            <h3 className="text-[13px] font-semibold text-aurora-ink-sub">
              Widgets hidden for your context ({resolved.excluded.length})
            </h3>
          </div>
          <p className="text-xs text-muted mb-2">
            For transparency: every widget the engine knows about that isn't shown to
            you, with the governance reason. Admins can override via the per-role
            widget config at <Link to="/admin/dashboard-widgets" className="text-action underline-offset-2 hover:underline">Dashboard widgets</Link>.
          </p>
          <ul className="text-[12px] space-y-1">
            {resolved.excluded.slice(0, 8).map((w) => (
              <li key={w.id} className="flex items-center gap-2">
                <code className="text-[11px] text-aurora-ink-sub">{w.id}</code>
                <span className="text-muted">·</span>
                <span className="text-aurora-ink-sub">{resolved.exclusion_reasons[w.id]}</span>
              </li>
            ))}
            {resolved.excluded.length > 8 && (
              <li className="text-muted italic">… and {resolved.excluded.length - 8} more</li>
            )}
          </ul>
        </Panel>
      )}
    </div>
  );
}
