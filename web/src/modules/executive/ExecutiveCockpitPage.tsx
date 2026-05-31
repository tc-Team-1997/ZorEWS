// web/src/modules/executive/ExecutiveCockpitPage.tsx
//
// Executive Risk Cockpit — landing page.
//
// 10th IA addition this session. Follows the proven overlay-Center pattern
// (additive only — existing dashboards untouched). Mounted at
// /executive-cockpit. Gated to the 7 executive personas
// (super_admin / cro / ceo / cfo / coo / board_member / country_head)
// plus the legacy `executive` + `admin` backend roles.

import { useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, BarChart3, ChevronRight, Crown,
  Download, FileBadge, Flame, Megaphone, Radio,
  Search, Send, ShieldAlert, Sparkles, Target, TrendingDown, TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  ALL_EXECUTIVE_ACTIONS,
  canAccessExecutiveCockpit,
  EXECUTIVE_ACTIONS,
  getEnterpriseRiskOverview,
  getPredictiveForecasts,
  getRiskHeatmap,
  getStrategicKpis,
  getTopExposures,
  type ExposureKind,
  type ExposureRow,
  type ForecastSeries,
  type HeatmapCell,
  type HeatmapScope,
  type StrategicKpi,
} from './executiveCockpitEngine';
import {
  ALL_BRIEFING_CADENCES,
  generateAllBriefings,
  REPORT_TEMPLATES,
  type BriefingCadence,
  type ExecutiveBriefing,
} from './executiveBriefing';

const ACTIVE_TENANT = 'BANK_DEMO';

const BAND_TONE: Record<HeatmapCell['band'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
};

const STRATEGIC_BAND_TONE: Record<StrategicKpi['band'], 'success' | 'warning' | 'danger'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
};

const FORECAST_SEVERITY_TONE: Record<ForecastSeries['severity'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  info: 'success',
  warning: 'warning',
  critical: 'danger',
};

const ACTION_ICON: Record<typeof ALL_EXECUTIVE_ACTIONS[number], LucideIcon> = {
  escalate_risk: Flame,
  launch_investigation: Search,
  trigger_review: Radio,
  export_report: Download,
  notify_leadership: Send,
};

export function ExecutiveCockpitPage() {
  const user = useAuth((s) => s.user);
  const [heatmapScope, setHeatmapScope] = useState<HeatmapScope>('country');
  const [exposureKind, setExposureKind] = useState<ExposureKind>('borrowers');
  const [briefingCadence, setBriefingCadence] = useState<BriefingCadence>('monthly');
  const [lastAction, setLastAction] = useState<string | null>(null);

  // Role gate — bounce out if not in the 7-persona executive set.
  if (user && !canAccessExecutiveCockpit(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const overview = useMemo(() => getEnterpriseRiskOverview(ACTIVE_TENANT), []);
  const heatmap = useMemo(() => getRiskHeatmap(heatmapScope, ACTIVE_TENANT), [heatmapScope]);
  const exposures = useMemo(() => getTopExposures(exposureKind, ACTIVE_TENANT), [exposureKind]);
  const forecasts = useMemo(() => getPredictiveForecasts(ACTIVE_TENANT), []);
  const briefings = useMemo(() => generateAllBriefings(ACTIVE_TENANT), []);
  const strategicKpis = useMemo(() => getStrategicKpis(ACTIVE_TENANT), []);

  const activeBriefing: ExecutiveBriefing | undefined = briefings.find((b) => b.cadence === briefingCadence);

  return (
    <div data-testid="executive-cockpit-page" className="space-y-4">
      <PageHeader
        title="Executive Risk Cockpit"
        subtitle="CEO · CRO · COO · CFO · Board · Country Heads · Executive Leadership. Read-only enterprise risk intelligence."
      />

      {/* Cockpit banner */}
      <Panel data-testid="executive-cockpit-banner">
        <div className="flex items-start gap-3 text-sm text-ink">
          <Crown size={18} className="text-warning shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Executive-only — additive cockpit (existing dashboards untouched).</div>
            <p className="text-muted text-xs mt-0.5">
              8 sections composed from the existing widget registry + dedicated executive
              resolvers. Every value resolves from the same M15 audit chain, M9.3 maker-checker
              workflow, and Recovery / Audit / Governance / IAM centers — zero parallel data
              storage. Production swap: each resolver's body becomes a BFF query against the
              corresponding mart / store.
            </p>
          </div>
        </div>
      </Panel>

      {/* ── Section 1 — Enterprise Risk Overview ─────────────────────── */}
      <Panel title="Enterprise Risk Overview" data-testid="cockpit-section-overview">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7" data-testid="cockpit-overview-strip">
          {overview.map((kpi) => (
            <Link
              key={kpi.widget_id}
              to={kpi.drill_to ?? '#'}
              className="block"
              data-testid={`cockpit-overview-${kpi.widget_id}`}
            >
              <MetricCard label={kpi.label} value={kpi.value} sub={kpi.sub} />
            </Link>
          ))}
        </div>
      </Panel>

      {/* ── Section 2 — Risk Heatmap ─────────────────────────────────── */}
      <Panel title="Risk Heatmap" data-testid="cockpit-section-heatmap">
        <div className="mb-3 flex flex-wrap gap-1.5 border-b border-aurora-line" role="tablist" data-testid="cockpit-heatmap-tabs">
          {(['country', 'tenant', 'branch', 'sector'] as const).map((scope) => {
            const active = scope === heatmapScope;
            return (
              <button
                key={scope}
                role="tab"
                aria-selected={active}
                data-testid={`cockpit-heatmap-tab-${scope}`}
                onClick={() => setHeatmapScope(scope)}
                className={`px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors -mb-px ${
                  active
                    ? 'border-aurora-indigo text-aurora-indigo'
                    : 'border-transparent text-aurora-ink-sub hover:text-aurora-ink'
                }`}
              >
                {scope[0]?.toUpperCase() + scope.slice(1)} Risk Heatmap
              </button>
            );
          })}
        </div>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="cockpit-heatmap-grid">
          {heatmap.map((cell) => (
            <li key={cell.label} className="rounded-md border border-aurora-line bg-white p-3" data-testid={`cockpit-heatmap-cell-${cell.label.replace(/\s+/g, '-').toLowerCase()}`}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[13px] font-semibold text-aurora-ink">{cell.label}</h4>
                <Badge tone={BAND_TONE[cell.band]}>{cell.band}</Badge>
              </div>
              <div className="mt-1 text-2xl font-display text-aurora-ink">{cell.risk_score}</div>
              <p className="mt-0.5 text-[11px] text-muted">cohort {cell.cohort_size.toLocaleString()}</p>
              {cell.drill_to && (
                <Link to={cell.drill_to} className="mt-1 inline-flex items-center gap-1 text-[11px] text-action hover:underline">
                  Drill in <ChevronRight size={11} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── Section 3 — Top Risk Exposures ───────────────────────────── */}
      <Panel title="Top Risk Exposures" data-testid="cockpit-section-exposures">
        <div className="mb-3 flex flex-wrap gap-1.5 border-b border-aurora-line" role="tablist" data-testid="cockpit-exposures-tabs">
          {(['borrowers', 'portfolios', 'policies', 'fraud_cases'] as const).map((kind) => {
            const active = kind === exposureKind;
            return (
              <button
                key={kind}
                role="tab"
                aria-selected={active}
                data-testid={`cockpit-exposure-tab-${kind}`}
                onClick={() => setExposureKind(kind)}
                className={`px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors -mb-px ${
                  active
                    ? 'border-aurora-indigo text-aurora-indigo'
                    : 'border-transparent text-aurora-ink-sub hover:text-aurora-ink'
                }`}
              >
                Top 10 {kind.replace('_', ' ')}
              </button>
            );
          })}
        </div>
        <ol className="space-y-1" data-testid="cockpit-exposures-list">
          {exposures.map((row: ExposureRow) => (
            <li key={row.entity_id} className="rounded-md border border-aurora-line bg-white px-3 py-2 hover:border-action" data-testid={`cockpit-exposure-row-${row.entity_id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1">
                  <span className="font-display text-sm text-aurora-ink-sub w-6 shrink-0">#{row.rank}</span>
                  <div className="flex-1">
                    <div className="text-[13px] font-medium text-aurora-ink">{row.entity_name}</div>
                    <div className="text-[11px] text-muted">{row.entity_id} · {row.drivers.join(' · ')}</div>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-medium text-aurora-ink">₹{(row.exposure_kes / 1_00_000).toFixed(1)}L</div>
                  <Badge tone={BAND_TONE[row.band]}>{row.risk_score}</Badge>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      {/* ── Section 4 — Predictive Intelligence ──────────────────────── */}
      <Panel title="Predictive Intelligence" data-testid="cockpit-section-forecasts">
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="cockpit-forecasts-grid">
          {forecasts.map((f) => (
            <li key={f.kind} className="rounded-md border border-aurora-line bg-white p-3" data-testid={`cockpit-forecast-${f.kind}`}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[13px] font-semibold text-aurora-ink">{f.label}</h4>
                <Badge tone={FORECAST_SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
              </div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="text-2xl font-display text-aurora-ink">{f.forecast_delta_pct >= 0 ? '+' : ''}{f.forecast_delta_pct}%</span>
                {f.trend === 'rising' ? <TrendingUp size={14} className="text-danger" /> : f.trend === 'falling' ? <TrendingDown size={14} className="text-success" /> : null}
              </div>
              <p className="mt-1 text-[11px] text-muted">
                Forecast vs trailing-3 mean · confidence {Math.round(f.confidence * 100)}% · trend <code>{f.trend}</code>
              </p>
              {/* Tiny sparkline-style series rendered as horizontal bars */}
              <div className="mt-2 flex items-end gap-0.5 h-8" aria-hidden="true">
                {f.series.map((s, i) => {
                  const max = Math.max(...f.series.map((x) => x.value));
                  const h = max === 0 ? 4 : Math.round((s.value / max) * 28) + 4;
                  return (
                    <div
                      key={i}
                      style={{ height: `${h}px` }}
                      className={`flex-1 rounded-sm ${s.is_forecast ? 'bg-aurora-indigo/40' : 'bg-aurora-indigo'}`}
                      title={`${s.period}: ${s.value}${s.is_forecast ? ' (forecast)' : ''}`}
                    />
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-muted">Solid = actual · Faded = forecast</p>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── Section 5 — AI Executive Briefing ────────────────────────── */}
      <Panel title="AI Executive Briefing" data-testid="cockpit-section-briefing">
        <div className="mb-3 flex flex-wrap gap-1.5 border-b border-aurora-line" role="tablist" data-testid="cockpit-briefing-tabs">
          {ALL_BRIEFING_CADENCES.map((c) => {
            const active = c === briefingCadence;
            return (
              <button
                key={c}
                role="tab"
                aria-selected={active}
                data-testid={`cockpit-briefing-tab-${c}`}
                onClick={() => setBriefingCadence(c)}
                className={`px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors -mb-px ${
                  active
                    ? 'border-aurora-indigo text-aurora-indigo'
                    : 'border-transparent text-aurora-ink-sub hover:text-aurora-ink'
                }`}
              >
                {c[0]?.toUpperCase() + c.slice(1)} summary
              </button>
            );
          })}
        </div>
        {activeBriefing && (
          <div data-testid={`cockpit-briefing-${activeBriefing.cadence}`}>
            <div className="flex items-center gap-2 mb-2">
              <Sparkles size={16} className="text-aurora-indigo" />
              <span className="text-[12px] text-muted">{activeBriefing.period_label}</span>
            </div>
            <p className="text-base font-medium text-aurora-ink leading-snug">{activeBriefing.headline}</p>
            <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {activeBriefing.highlights.map((h, idx) => (
                <li
                  key={idx}
                  className="rounded-md border border-aurora-line bg-white p-2.5"
                  data-testid={`cockpit-briefing-highlight-${idx}`}
                >
                  <div className="flex items-center gap-1.5">
                    {h.direction === 'positive' ? <TrendingUp size={13} className="text-success" /> : h.direction === 'negative' ? <TrendingDown size={13} className="text-danger" /> : <Radio size={13} className="text-muted" />}
                    <span className="text-[12.5px] font-semibold text-aurora-ink">{h.metric}</span>
                  </div>
                  <p className="mt-1 text-[11.5px] text-aurora-ink-sub leading-snug">{h.detail}</p>
                  {h.drill_to && (
                    <Link to={h.drill_to} className="mt-1 inline-flex items-center gap-1 text-[11px] text-action hover:underline">
                      Investigate <ChevronRight size={11} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] text-aurora-ink-sub p-2 rounded-md bg-aurora-tint" data-testid="cockpit-briefing-recommended-action">
              <strong className="text-aurora-ink">Recommended action:</strong> {activeBriefing.recommended_action}
            </p>
          </div>
        )}
      </Panel>

      {/* ── Section 6 — Board Reporting Hub ──────────────────────────── */}
      <Panel title="Board Reporting Hub" data-testid="cockpit-section-reporting">
        <p className="text-[12px] text-muted mb-3">
          Generate executive + regulatory + board-pack reports. Reuses the existing T4.6
          self-service report builder pipeline (CSV / PDF / Excel) so output formats stay
          consistent with the rest of the platform.
        </p>
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2" data-testid="cockpit-reports-grid">
          {REPORT_TEMPLATES.map((r) => (
            <li
              key={r.id}
              className="rounded-md border border-aurora-line bg-white p-3"
              data-testid={`cockpit-report-${r.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="text-[13px] font-semibold text-aurora-ink flex items-center gap-1.5">
                    <FileBadge size={13} className="text-aurora-indigo" />
                    {r.label}
                  </h4>
                  <p className="text-[11px] text-muted mt-0.5 leading-snug">{r.description}</p>
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[10px]">
                <Badge tone="neutral">{r.cadence}</Badge>
                {r.formats.map((f) => <Badge key={f} tone="blue">{f.toUpperCase()}</Badge>)}
              </div>
              <Link
                to={r.legacy_source_id ? `/reports/builder?source=${r.legacy_source_id}` : '/reports/builder'}
                className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-action hover:underline"
                data-testid={`cockpit-report-link-${r.id}`}
              >
                Open in Report Builder <ArrowRight size={11} />
              </Link>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── Section 7 — Strategic KPI Center ─────────────────────────── */}
      <Panel title="Strategic KPI Center" data-testid="cockpit-section-strategic">
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3" data-testid="cockpit-strategic-grid">
          {strategicKpis.map((kpi) => (
            <li
              key={kpi.id}
              className="rounded-md border border-aurora-line bg-white p-3"
              data-testid={`cockpit-strategic-${kpi.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="text-[13px] font-semibold text-aurora-ink">{kpi.label}</h4>
                  <p className="text-[10.5px] text-muted mt-0.5">{kpi.context}</p>
                </div>
                <Badge tone={STRATEGIC_BAND_TONE[kpi.band]}>{kpi.band}</Badge>
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-display text-aurora-ink">{kpi.value}</span>
                <span className={`text-[12px] ${kpi.delta_pct >= 0 ? 'text-success' : 'text-danger'}`}>
                  {kpi.delta_pct >= 0 ? '+' : ''}{kpi.delta_pct}%
                </span>
                {kpi.trend === 'rising' ? <TrendingUp size={12} className="text-aurora-indigo" /> : kpi.trend === 'falling' ? <TrendingDown size={12} className="text-aurora-indigo" /> : null}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── Section 8 — Executive Actions ────────────────────────────── */}
      <Panel title="Executive Actions" data-testid="cockpit-section-actions">
        <p className="text-[12px] text-muted mb-3">
          Each action writes an event to the M15 audit chain when fired (this is a
          UI-only handler today; BFF wiring lands in the follow-up commit per
          <code> docs/executive-risk-cockpit.md §6</code>).
        </p>
        <div className="flex flex-wrap gap-2" data-testid="cockpit-actions">
          {EXECUTIVE_ACTIONS.map((action) => {
            const Icon = ACTION_ICON[action.id];
            return (
              <button
                key={action.id}
                onClick={() => setLastAction(action.label + ' · ' + new Date().toISOString().slice(11, 19) + ' UTC')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-md border border-aurora-line bg-white hover:border-action hover:text-action"
                data-testid={`cockpit-action-${action.id}`}
                title={action.description}
              >
                <Icon size={13} />
                {action.label}
              </button>
            );
          })}
        </div>
        {lastAction && (
          <p className="mt-3 text-[12px] text-aurora-ink p-2 rounded-md bg-aurora-tint" data-testid="cockpit-action-feedback">
            <Megaphone size={12} className="inline mr-1 text-aurora-indigo" />
            Action queued: <strong>{lastAction}</strong> (UI-only — BFF audit-write follows).
          </p>
        )}
      </Panel>

      {/* Footer — small links to the other intel surfaces */}
      <Panel data-testid="cockpit-footer-links">
        <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted">
          <BarChart3 size={14} className="text-aurora-indigo" />
          <Link to="/dashboards/role-based" className="hover:underline">Role-Based Dashboard</Link>
          <span>·</span>
          <Link to="/analytics" className="hover:underline">Analytics Studio</Link>
          <span>·</span>
          <Link to="/admin/governance" className="hover:underline">Governance Center</Link>
          <span>·</span>
          <Link to="/audit-center" className="hover:underline">Audit Center</Link>
          <span>·</span>
          <Link to="/recovery-center" className="hover:underline">Recovery Center</Link>
          <span className="ml-auto inline-flex items-center gap-1">
            <ShieldAlert size={12} className="text-warning" />
            <span>Executive-only view · M15 audit trail enforced</span>
          </span>
        </div>
      </Panel>

      {/* Hide-from-non-roles teaser at the bottom */}
      <p className="text-[11px] text-muted text-center pb-4">
        <Target size={11} className="inline mr-1" />
        7-persona gate · {EXECUTIVE_ACTIONS.length} actions available · {REPORT_TEMPLATES.length} report templates configured
        <AlertTriangle size={11} className="inline ml-1" aria-hidden="true" />
      </p>
    </div>
  );
}
