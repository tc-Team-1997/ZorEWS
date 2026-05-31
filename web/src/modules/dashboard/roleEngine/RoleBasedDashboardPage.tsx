// web/src/modules/dashboard/roleEngine/RoleBasedDashboardPage.tsx
//
// Role-Based Dashboard Engine — landing.
//
// Consumes resolveRoleDefaultDashboard() per the (role × domain × country
// × tenant × branch) context derived from useAuth(). Renders:
//   1. Header + governance status banner
//   2. 8-tile Executive KPI strip (Section §EXECUTIVE KPI LAYER)
//   3. 5-card AI Insights panel (Section §AI INSIGHTS PANEL)
//   4. Resolved widget grid (Section §DASHBOARD ENGINE ARCHITECTURE)
//
// The existing DashboardPage at "/" is untouched — this lives at
// /dashboards/role-based as an additive overlay. Same proven pattern as
// the 7 overlay centers shipped earlier in the session.

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Cog,
  Compass,
  ExternalLink,
  Pin,
  Sparkles,
  Lock,
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

const SEVERITY_TONE: Record<AiInsightSeverity, 'neutral' | 'blue' | 'warning' | 'danger'> = {
  info: 'blue',
  watch: 'neutral',
  warning: 'warning',
  critical: 'danger',
};

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

  const context: DashboardContext = useMemo(() => ({
    role: resolveDashboardRole(user?.roles),
    domain: (domain === 'banking' || domain === 'insurance') ? domain : 'both',
    country: null,    // wired via TenantContext when country governance lands
    tenant_id: null,  // wired via TenantContext header
    branch_id: null,  // wired via BranchContext when branch governance lands
  }), [user?.roles, domain]);

  const resolved = useMemo(() => resolveRoleDefaultDashboard(context), [context]);
  const insights = useMemo(() => generateAiInsights(context.role, context.domain, new Date()), [context.role, context.domain]);

  // Partition the resolved widgets — KPIs render in the strip, everything
  // else renders in the body grid.
  const kpiWidgets = resolved.widgets.filter((w) => w.category === 'executive_kpi' && w.kind === 'kpi');
  const bodyWidgets = resolved.widgets.filter((w) => !(w.category === 'executive_kpi' && w.kind === 'kpi'));

  return (
    <div data-testid="role-based-dashboard-page">
      <PageHeader
        title="Role-Based Dashboard"
        subtitle={`Tailored for ${context.role.replace('_', ' ')} · ${context.domain} domain · ${resolved.widgets.length} widgets resolved (${resolved.excluded.length} hidden by governance)`}
      />

      <Panel className="mb-4" data-testid="role-dashboard-governance-banner">
        <div className="flex items-start gap-3 text-sm text-ink">
          <Compass size={18} className="text-action shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Dynamic widget composition — additive overlay (zero existing widgets touched).</div>
            <p className="text-muted text-xs mt-0.5">
              The existing dashboard at <code>/</code> is untouched. This view layers a
              5-axis governance resolver (role × domain × country × tenant × branch)
              over the new widget registry. Per-user pin / hide / sort prefs land in
              <code> app_iam.dashboard_widget_preferences </code> (migration 051).
              Every widget remains reachable via its drill-target route.
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

      {/* ── Widget grid (rest of resolved widgets) ─────────────────────── */}
      <Panel data-testid="role-dashboard-widget-grid" title="Your dashboard">
        {bodyWidgets.length === 0 && (
          <p className="text-sm text-muted" data-testid="role-dashboard-empty-state">
            No widgets resolved for your current (role × domain × governance) context.
            Try switching domain via the chrome selector or contact an admin to grant
            additional widget visibility.
          </p>
        )}
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {bodyWidgets.map((w: WidgetDef) => (
            <li key={w.id} data-testid={`role-widget-${w.id}`}>
              <Link to={w.drill_to ?? '#'} className="block group">
                <Panel className="hover:border-action transition-colors h-full">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 shrink-0 rounded-md bg-aurora-tint flex items-center justify-center text-[11px] text-aurora-indigo uppercase font-medium">
                      {w.kind.slice(0, 4)}
                    </div>
                    <div className="flex-1">
                      <h4 className="font-display text-[14px] font-semibold text-ink flex items-center gap-1.5">
                        {w.label}
                        {resolved.governance_locked[w.id] && (
                          <Lock size={11} className="text-muted" aria-label="Governance-controlled widget" />
                        )}
                      </h4>
                      <p className="text-[11.5px] text-muted mt-0.5 leading-snug">{w.description}</p>
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap text-[11px]">
                        <Badge tone="neutral">{w.category.replace('_', ' ')}</Badge>
                        <Badge tone="neutral">{w.kind}</Badge>
                        {w.default_domain !== 'both' && <Badge tone="blue">{w.default_domain}</Badge>}
                      </div>
                    </div>
                    <Pin size={12} className="text-muted opacity-0 group-hover:opacity-60 mt-0.5" />
                  </div>
                </Panel>
              </Link>
            </li>
          ))}
        </ul>
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
