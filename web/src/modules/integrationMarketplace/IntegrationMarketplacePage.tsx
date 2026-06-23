// web/src/modules/integrationMarketplace/IntegrationMarketplacePage.tsx
//
// Enterprise Integration Marketplace — Phase 20 IA overlay.
//
// 10 sections: Integration Catalog, API Marketplace, Data Exchange Hub,
//   Event Subscription Center, Partner Ecosystem, Governance,
//   Observability Dashboard, AI Insights, Executive View,
//   Integration Readiness Score.
//
// Additive — every existing module untouched.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, Award, BarChart3,
  Brain, ChevronRight, Database,
  Globe, LucideIcon, Package, Plug, Search,
  Shield, ShieldCheck, Sparkles, Target, Zap,
} from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  EVENT_DEFINITIONS,
  READINESS_DIMENSIONS,
  buildApiMarketplace,
  buildDataExchangeFlows,
  buildDataExchangeMetrics,
  buildEventSubscriptions,
  buildExecutiveKpis,
  buildGovernanceRecords,
  buildIntegrationCatalog,
  buildIntegrationInsights,
  buildObservabilityMetrics,
  buildPartnerEcosystem,
  buildReadinessScore,
  canAccessIntegrationMarketplace,
  type GovernanceState,
  type IntegrationCategory,
  type IntegrationStatus,
} from './integrationMarketplaceEngine';

const ACTIVE_TENANT = 'BANK_DEMO';
const AS_OF = new Date('2026-06-01T12:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtInt(n: number): string { return n.toLocaleString('en-IN'); }
function fmtPct(n: number): string { return (Math.round(n * 10) / 10) + '%'; }
function fmtMs(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`; }
function fmtCr(n: number): string { return `₹${(Math.round(n * 10) / 10)} Cr`; }

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

function StatusBadge({ status }: { status: IntegrationStatus }) {
  const cls: Record<IntegrationStatus, string> = {
    active:      'bg-green-50 text-green-700 border border-green-200',
    inactive:    'bg-slate-50 text-slate-600 border border-slate-200',
    degraded:    'bg-amber-50 text-amber-700 border border-amber-200',
    maintenance: 'bg-blue-50 text-blue-700 border border-blue-200',
    deprecated:  'bg-red-50 text-red-700 border border-red-200',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[status]}`}>{status}</span>;
}

function GovBadge({ state }: { state: GovernanceState }) {
  const cls: Record<GovernanceState, string> = {
    draft:    'bg-slate-100 text-slate-600',
    review:   'bg-amber-50 text-amber-700',
    approved: 'bg-green-50 text-green-700',
    rejected: 'bg-red-50 text-red-700',
    retired:  'bg-purple-50 text-purple-700',
  };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[state]}`}>{state}</span>;
}

function HealthBar({ score, height = 4 }: { score: number; height?: number }) {
  const color = score >= 90 ? '#10B981' : score >= 70 ? '#F59E0B' : '#EF4444';
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 rounded-full overflow-hidden bg-slate-100" style={{ height }}>
        <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: color }} />
      </div>
      <span className="text-xs font-semibold" style={{ color }}>{score}</span>
    </div>
  );
}

function RiskBadge({ level }: { level: 'low' | 'medium' | 'high' | 'critical' }) {
  const cls = { low: 'bg-green-50 text-green-700', medium: 'bg-amber-50 text-amber-700', high: 'bg-orange-50 text-orange-700', critical: 'bg-red-50 text-red-700' };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium uppercase ${cls[level]}`}>{level}</span>;
}

function CategoryBadge({ cat }: { cat: IntegrationCategory }) {
  const cls: Record<IntegrationCategory, string> = { banking: 'bg-blue-100 text-blue-700', insurance: 'bg-teal-100 text-teal-700', enterprise: 'bg-violet-100 text-violet-700' };
  return <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${cls[cat]}`}>{cat}</span>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export function IntegrationMarketplacePage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessIntegrationMarketplace(user.roles)) return <Navigate to="/" replace />;

  const asOf = useMemo(() => AS_OF, []);

  const catalog      = useMemo(() => buildIntegrationCatalog(ACTIVE_TENANT, asOf), [asOf]);
  const apis         = useMemo(() => buildApiMarketplace(ACTIVE_TENANT, asOf), [asOf]);
  const flows        = useMemo(() => buildDataExchangeFlows(ACTIVE_TENANT, asOf), [asOf]);
  const metrics      = useMemo(() => buildDataExchangeMetrics(ACTIVE_TENANT, asOf), [asOf]);
  const subscriptions= useMemo(() => buildEventSubscriptions(ACTIVE_TENANT, asOf), [asOf]);
  const partners     = useMemo(() => buildPartnerEcosystem(ACTIVE_TENANT, asOf), [asOf]);
  const governance   = useMemo(() => buildGovernanceRecords(ACTIVE_TENANT, asOf), [asOf]);
  const observability= useMemo(() => buildObservabilityMetrics(ACTIVE_TENANT, asOf), [asOf]);
  const insights     = useMemo(() => buildIntegrationInsights(ACTIVE_TENANT, asOf), [asOf]);
  const execKpis     = useMemo(() => buildExecutiveKpis(ACTIVE_TENANT, asOf), [asOf]);
  const readiness    = useMemo(() => buildReadinessScore(ACTIVE_TENANT, asOf), [asOf]);

  const [activeSection, setActiveSection] = useState('catalog');
  const [catFilter, setCatFilter] = useState<IntegrationCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredCatalog = catalog.filter(i =>
    (catFilter === 'all' || i.category === catFilter) &&
    (!searchQuery || i.name.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const SECTIONS = [
    { id: 'catalog',     label: 'Catalog',         icon: Package },
    { id: 'apis',        label: 'API Marketplace',  icon: Plug },
    { id: 'exchange',    label: 'Data Exchange',    icon: Database },
    { id: 'events',      label: 'Event Center',     icon: Zap },
    { id: 'partners',    label: 'Partners',         icon: Globe },
    { id: 'governance',  label: 'Governance',       icon: Shield },
    { id: 'observability', label: 'Observability',  icon: Activity },
    { id: 'insights',    label: 'AI Insights',      icon: Brain },
    { id: 'executive',   label: 'Executive View',   icon: Award },
    { id: 'readiness',   label: 'Readiness Score',  icon: Target },
  ];

  const scoreRadarData = READINESS_DIMENSIONS.map(d => ({
    dim: d.charAt(0).toUpperCase() + d.slice(1),
    score: readiness.dimensions[d].score,
  }));

  return (
    <div className="space-y-4" data-testid="integration-marketplace">

      <PageHeader
        title="Enterprise Integration Marketplace"
        subtitle="Single platform for all integrations · APIs · Data Exchanges · Events · Partners · Governance"
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="neutral" className="text-xs">Phase 20</Badge>
            <Badge tone="success" className="text-xs">{execKpis.active_integrations} Active</Badge>
            <Badge tone={execKpis.integration_maturity_score >= 75 ? 'neutral' : 'warning'} className="text-xs">Maturity: {execKpis.integration_maturity_score}</Badge>
            <Badge tone="neutral" className="text-xs">{apis.length} APIs · {partners.length} Partners</Badge>
          </div>
        }
      />

      {/* Section nav */}
      <div className="flex gap-1.5 flex-wrap">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
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

      {/* ─── Section 1: Integration Catalog ─────────────────────────────── */}
      {activeSection === 'catalog' && (
        <Panel title={titleWithIcon('Integration Catalog', Package, `${catalog.length} integrations`)} data-testid="im-section-catalog">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <div className="flex items-center gap-1.5 flex-1 min-w-48 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5">
              <Search className="size-3.5 text-slate-400" aria-hidden />
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search integrations..."
                className="flex-1 bg-transparent text-xs outline-none text-slate-700 placeholder:text-slate-400"
              />
            </div>
            {(['all', 'banking', 'insurance', 'enterprise'] as const).map(c => (
              <button key={c} onClick={() => setCatFilter(c)} className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${catFilter === c ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}>
                {c === 'all' ? `All (${catalog.length})` : `${c.charAt(0).toUpperCase() + c.slice(1)} (${catalog.filter(i => i.category === c).length})`}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
            {filteredCatalog.map(int => (
              <div key={int.integration_id} className="p-3 rounded-lg border border-slate-100 hover:border-indigo-200 hover:shadow-sm transition-all" data-testid={`im-int-${int.integration_id}`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-800 truncate">{int.name}</p>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{int.description}</p>
                  </div>
                  <StatusBadge status={int.status} />
                </div>
                <HealthBar score={int.health_score} />
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <CategoryBadge cat={int.category} />
                  <GovBadge state={int.governance_state} />
                  <RiskBadge level={int.risk_level} />
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                  <span>v{int.version}</span>
                  <span>·</span>
                  <span>{int.owner}</span>
                  <span>·</span>
                  <span>{fmtInt(int.records_per_day)}/day</span>
                </div>
              </div>
            ))}
          </div>
          {filteredCatalog.length === 0 && (
            <div className="text-center py-8 text-slate-400">
              <Package className="size-8 mx-auto mb-2 opacity-40" aria-hidden />
              <p className="text-sm">No integrations match your filter</p>
            </div>
          )}
        </Panel>
      )}

      {/* ─── Section 2: API Marketplace ──────────────────────────────────── */}
      {activeSection === 'apis' && (
        <Panel title={titleWithIcon('API Marketplace', Plug, `${apis.length} registered APIs`)} data-testid="im-section-apis">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Total APIs"         value={String(apis.length)}                                    tone="neutral" testId="im-kpi-apis" />
            <MetricCard label="Active"             value={String(apis.filter(a => a.status === 'active').length)} tone="success" testId="im-kpi-active-apis" />
            <MetricCard label="Avg Availability"   value={fmtPct(apis.reduce((s,a) => s + a.availability_pct, 0) / apis.length)} tone="success" testId="im-kpi-avail" />
            <MetricCard label="Avg Error Rate"     value={fmtPct(apis.reduce((s,a) => s + a.error_rate_pct, 0) / apis.length)}   tone="neutral" testId="im-kpi-error-rate" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['API Name', 'Type', 'Version', 'Owner', 'Auth', 'SLA', 'Availability', 'Calls/day', 'Error %', 'Status'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {apis.map(api => (
                  <tr key={api.api_id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-1.5 pr-3 font-medium text-slate-800 max-w-36 truncate">{api.name}</td>
                    <td className="py-1.5 pr-3"><span className="px-1.5 py-0.5 rounded text-xs bg-indigo-50 text-indigo-700">{api.api_type}</span></td>
                    <td className="py-1.5 pr-3 text-slate-500">{api.version}</td>
                    <td className="py-1.5 pr-3 text-slate-500 max-w-28 truncate">{api.owner}</td>
                    <td className="py-1.5 pr-3"><span className="px-1.5 py-0.5 rounded text-xs bg-slate-50 text-slate-700">{api.auth_type}</span></td>
                    <td className="py-1.5 pr-3 text-slate-600">{fmtMs(api.sla_ms)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`font-medium ${api.availability_pct >= 99.5 ? 'text-green-600' : 'text-amber-600'}`}>{fmtPct(api.availability_pct)}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-500">{fmtInt(api.calls_per_day)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={api.error_rate_pct > 1 ? 'text-red-600 font-medium' : 'text-green-600'}>{fmtPct(api.error_rate_pct)}</span>
                    </td>
                    <td className="py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${api.status === 'active' ? 'bg-green-50 text-green-700' : api.status === 'beta' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>{api.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 3: Data Exchange Hub ────────────────────────────────── */}
      {activeSection === 'exchange' && (
        <Panel title={titleWithIcon('Data Exchange Hub', Database, `${flows.length} active flows`)} data-testid="im-section-exchange">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {metrics.map(m => (
              <div key={m.period} className="p-3 rounded-lg border border-slate-100 bg-slate-50/50">
                <p className="text-xs font-medium text-slate-500 capitalize mb-2">{m.period} metrics</p>
                <p className="text-sm font-bold text-slate-800">{fmtInt(m.total_records)} records</p>
                <p className="text-xs text-slate-500">{fmtInt(m.total_failures)} failures · {fmtPct(m.success_rate_pct)} success</p>
                <p className="text-xs text-slate-500 mt-0.5">Avg latency: {fmtMs(m.avg_latency_ms)}</p>
              </div>
            ))}
            <div className="p-3 rounded-lg border border-green-100 bg-green-50/40">
              <p className="text-xs font-medium text-green-700 mb-2">Running flows</p>
              <p className="text-2xl font-bold text-green-700">{flows.filter(f => f.status === 'running').length}</p>
              <p className="text-xs text-slate-500">of {flows.length} total</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Source', 'Target', 'Records Today', 'Failures', 'Latency', 'Throughput/min', 'Success %', 'Status'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {flows.map(f => (
                  <tr key={f.flow_id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-1.5 pr-3 font-medium text-slate-700">{f.source}</td>
                    <td className="py-1.5 pr-3 text-slate-600">{f.target}</td>
                    <td className="py-1.5 pr-3 text-slate-700">{fmtInt(f.records_processed_today)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={f.failures_today > 0 ? 'text-red-600 font-medium' : 'text-slate-400'}>{f.failures_today}</span>
                    </td>
                    <td className="py-1.5 pr-3">{fmtMs(f.avg_latency_ms)}</td>
                    <td className="py-1.5 pr-3">{fmtInt(f.throughput_per_min)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={f.success_rate_pct >= 99 ? 'text-green-600 font-medium' : f.success_rate_pct >= 95 ? 'text-amber-600' : 'text-red-600'}>
                        {f.records_processed_today > 0 ? fmtPct(f.success_rate_pct) : '—'}
                      </span>
                    </td>
                    <td className="py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${f.status === 'running' ? 'bg-green-50 text-green-700' : f.status === 'paused' ? 'bg-amber-50 text-amber-700' : f.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-slate-50 text-slate-600'}`}>{f.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 4: Event Subscription Center ────────────────────────── */}
      {activeSection === 'events' && (
        <Panel title={titleWithIcon('Event Subscription Center', Zap, `${EVENT_DEFINITIONS.length} event types`)} data-testid="im-section-events">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Registered Event Types</p>
              <div className="space-y-1.5">
                {EVENT_DEFINITIONS.map(evt => (
                  <div key={evt.event_type} className="flex items-center justify-between p-2 rounded-lg border border-slate-100 hover:bg-slate-50">
                    <div>
                      <p className="text-xs font-medium text-slate-800 font-mono">{evt.event_type}</p>
                      <p className="text-xs text-slate-500">{evt.description}</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
                      <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 rounded">{evt.category}</span>
                      <span>{fmtInt(evt.avg_daily_volume)}/day</span>
                      <span>{evt.subscribers_count} subs</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Active Subscriptions</p>
              <div className="space-y-1.5 overflow-y-auto max-h-96">
                {subscriptions.map(sub => (
                  <div key={sub.subscription_id} className="p-2 rounded-lg border border-slate-100 hover:bg-slate-50">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-800">{sub.subscriber}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${sub.delivery_status === 'healthy' ? 'bg-green-50 text-green-700' : sub.delivery_status === 'degraded' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{sub.delivery_status}</span>
                    </div>
                    <p className="text-xs text-slate-500 font-mono">{sub.event_type}</p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-slate-400">
                      <span>Success: <strong className="text-slate-600">{fmtPct(sub.success_rate_pct)}</strong></span>
                      <span>Retries: {sub.retry_count}</span>
                      <span>24h: {fmtInt(sub.events_24h)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 5: Partner Ecosystem ────────────────────────────────── */}
      {activeSection === 'partners' && (
        <Panel title={titleWithIcon('Partner Ecosystem', Globe, `${partners.length} active partners`)} data-testid="im-section-partners">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Total Partners"       value={String(partners.length)}                                               tone="neutral" testId="im-kpi-partners" />
            <MetricCard label="Active Contracts"     value={String(partners.filter(p => p.contract_status === 'active').length)}   tone="success" testId="im-kpi-active-partners" />
            <MetricCard label="Renewal Due"          value={String(partners.filter(p => p.contract_status === 'renewal_due').length)} tone="warning" testId="im-kpi-renewal" />
            <MetricCard label="Avg SLA Compliance"   value={fmtPct(partners.reduce((s, p) => s + p.sla_met_pct, 0) / partners.length)} tone="success" testId="im-kpi-partner-sla" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {partners.map(p => {
              const expiryDays = Math.floor((new Date(p.contract_expiry).getTime() - AS_OF.getTime()) / 86400000);
              return (
                <div key={p.partner_id} className={`p-3 rounded-lg border ${p.contract_status === 'renewal_due' ? 'border-amber-200 bg-amber-50/30' : 'border-slate-100 hover:border-indigo-200'} transition-colors`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <p className="text-xs font-semibold text-slate-800">{p.name}</p>
                      <p className="text-xs text-slate-500">{p.type.replace(/_/g, ' ')} · {p.region}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${p.contract_status === 'active' ? 'bg-green-50 text-green-700' : p.contract_status === 'renewal_due' ? 'bg-amber-50 text-amber-700' : 'bg-slate-50 text-slate-600'}`}>{p.contract_status.replace(/_/g, ' ')}</span>
                      <span className="text-xs font-bold text-indigo-700">{p.compliance_rating}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 text-xs text-center">
                    <div className="p-1 bg-slate-50 rounded"><p className="font-bold text-slate-800">{p.performance_score}</p><p className="text-slate-500">Score</p></div>
                    <div className="p-1 bg-slate-50 rounded"><p className="font-bold text-slate-800">{fmtPct(p.sla_met_pct)}</p><p className="text-slate-500">SLA met</p></div>
                    <div className={`p-1 rounded ${expiryDays < 60 ? 'bg-amber-50' : 'bg-slate-50'}`}><p className={`font-bold ${expiryDays < 60 ? 'text-amber-700' : 'text-slate-800'}`}>{expiryDays}d</p><p className="text-slate-500">Expiry</p></div>
                  </div>
                  <p className="text-xs text-slate-400 mt-1.5">Contract: {fmtCr(p.contract_value_cr)} · SLA: {p.sla_response_hours}h response</p>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ─── Section 6: Governance ────────────────────────────────────────── */}
      {activeSection === 'governance' && (
        <Panel title={titleWithIcon('Integration Governance', Shield, 'Approval · Security · Compliance')} data-testid="im-section-governance">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
            {(['draft', 'review', 'approved', 'rejected', 'retired'] as const).map(state => {
              const count = governance.filter(g => g.state === state).length;
              const colors: Record<typeof state, string> = { draft: 'bg-slate-50', review: 'bg-amber-50', approved: 'bg-green-50', rejected: 'bg-red-50', retired: 'bg-purple-50' };
              const textColors: Record<typeof state, string> = { draft: 'text-slate-700', review: 'text-amber-700', approved: 'text-green-700', rejected: 'text-red-700', retired: 'text-purple-700' };
              return (
                <div key={state} className={`p-2 rounded-lg border ${colors[state]} text-center`}>
                  <p className={`text-xl font-bold ${textColors[state]}`}>{count}</p>
                  <p className="text-xs text-slate-500 capitalize">{state}</p>
                </div>
              );
            })}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-100">
                  {['Integration', 'Category', 'State', 'Security', 'Risk', 'Data Class', 'Compliance', 'Approver'].map(h => (
                    <th key={h} className="py-2 pr-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {governance.map(g => (
                  <tr key={g.record_id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-1.5 pr-3 font-medium text-slate-700 max-w-32 truncate">{g.integration_name}</td>
                    <td className="py-1.5 pr-3"><CategoryBadge cat={g.category} /></td>
                    <td className="py-1.5 pr-3"><GovBadge state={g.state} /></td>
                    <td className="py-1.5 pr-3">
                      <span className={`text-xs ${g.security_review === 'passed' ? 'text-green-600' : g.security_review === 'pending' ? 'text-amber-600' : 'text-red-600'}`}>{g.security_review}</span>
                    </td>
                    <td className="py-1.5 pr-3"><RiskBadge level={g.risk_level} /></td>
                    <td className="py-1.5 pr-3"><span className="text-xs text-slate-600 capitalize">{g.data_classification}</span></td>
                    <td className="py-1.5 pr-3">
                      <span className={`text-xs ${g.compliance_review === 'passed' ? 'text-green-600' : 'text-amber-600'}`}>{g.compliance_review}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-500">{g.approver}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ─── Section 7: Observability ─────────────────────────────────────── */}
      {activeSection === 'observability' && (
        <Panel title={titleWithIcon('Observability Dashboard', Activity, 'Real-time integration health')} data-testid="im-section-observability">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Healthy"         value={String(observability.healthy_count)}  tone="success"  sub="integrations" testId="im-kpi-healthy" />
            <MetricCard label="Degraded"        value={String(observability.degraded_count)} tone="warning"  sub="integrations" testId="im-kpi-degraded" />
            <MetricCard label="Availability"    value={fmtPct(observability.overall_availability_pct)} tone="success" testId="im-kpi-avail2" />
            <MetricCard label="Avg Response"    value={fmtMs(observability.avg_response_ms)} tone={observability.avg_response_ms < 300 ? 'success' : 'warning'} testId="im-kpi-response" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="API Calls 24h"   value={fmtInt(observability.total_api_calls_24h)} tone="neutral" testId="im-kpi-calls" />
            <MetricCard label="Error Rate"      value={fmtPct(observability.error_rate_pct)}      tone={observability.error_rate_pct < 0.5 ? 'success' : 'warning'} testId="im-kpi-errors" />
            <MetricCard label="P95 Latency"     value={fmtMs(observability.p95_latency_ms)}       tone="neutral" testId="im-kpi-p95" />
            <MetricCard label="Throughput/min"  value={fmtInt(observability.throughput_per_min)}  tone="neutral" testId="im-kpi-throughput" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Error Trend (last 24 hours)</p>
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={observability.error_trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="hour" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="errors" stroke="#EF4444" fill="#EF4444" fillOpacity={0.15} strokeWidth={2} name="Errors" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Request Volume vs Errors</p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={observability.error_trend.slice(-6)} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="hour" tick={{ fontSize: 9 }} />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="requests" fill="#6366F1" fillOpacity={0.6} name="Requests" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="errors" fill="#EF4444" name="Errors" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 8: AI Insights ────────────────────────────────────────── */}
      {activeSection === 'insights' && (
        <Panel title={titleWithIcon('AI Integration Insights', Brain, `${insights.length} active insights`)} data-testid="im-section-insights">
          <div className="space-y-3">
            {insights.map(ins => {
              const sevColors = { critical: 'border-l-red-400 bg-red-50/20', warning: 'border-l-amber-400 bg-amber-50/20', info: 'border-l-blue-400 bg-blue-50/20' };
              const typeIcons: Record<typeof ins.type, LucideIcon> = { risk: AlertTriangle, bottleneck: Activity, sla_breach: ShieldCheck, capacity: BarChart3, optimization: Sparkles };
              const TypeIcon = typeIcons[ins.type];
              return (
                <div key={ins.insight_id} className={`rounded-lg border border-l-4 p-3 ${sevColors[ins.severity]}`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2">
                      <TypeIcon className="size-4 text-slate-500 shrink-0" aria-hidden />
                      <span className="text-sm font-semibold text-slate-800">{ins.title}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium uppercase ${ins.severity === 'critical' ? 'bg-red-100 text-red-700' : ins.severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{ins.severity}</span>
                    </div>
                    <span className="text-xs text-indigo-600 font-semibold shrink-0">{Math.round(ins.confidence_score * 100)}%</span>
                  </div>
                  <p className="text-xs text-slate-600 mb-2">{ins.description}</p>
                  <div className="flex items-start gap-2">
                    <ChevronRight className="size-3 text-green-500 shrink-0 mt-0.5" aria-hidden />
                    <p className="text-xs text-slate-700"><span className="font-medium">Recommendation:</span> {ins.recommendation}</p>
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                    <span>Affected: <strong className="text-slate-600">{ins.affected_integration}</strong></span>
                    <span>·</span>
                    <span>Impact: <strong className="text-green-600">{ins.estimated_impact}</strong></span>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ─── Section 9: Executive View ────────────────────────────────────── */}
      {activeSection === 'executive' && (
        <Panel title={titleWithIcon('Executive View', Award, 'C-suite integration intelligence')} data-testid="im-section-executive">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Total Integrations"  value={String(execKpis.total_integrations)}    tone="neutral" testId="im-exec-total" />
            <MetricCard label="Active"              value={String(execKpis.active_integrations)}   tone="success" testId="im-exec-active" />
            <MetricCard label="Vendor Risk Score"   value={String(execKpis.vendor_risk_score)}     tone={execKpis.vendor_risk_score >= 75 ? 'success' : 'warning'} testId="im-exec-vendor-risk" />
            <MetricCard label="Maturity Score"      value={String(execKpis.integration_maturity_score)} tone={execKpis.integration_maturity_score >= 75 ? 'success' : 'warning'} testId="im-exec-maturity" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <MetricCard label="Critical Dependencies" value={String(execKpis.critical_dependencies)}     tone="warning" testId="im-exec-deps" />
            <MetricCard label="Partner SLA Compliance" value={fmtPct(execKpis.partner_sla_compliance_pct)} tone="success" testId="im-exec-partner" />
            <MetricCard label="Data Quality Score"    value={String(execKpis.data_quality_score)}        tone="success" testId="im-exec-dq" />
            <MetricCard label="Est. Integration Value" value={fmtCr(execKpis.estimated_integration_value_cr)} tone="neutral" testId="im-exec-value" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Integrations by Category</p>
              <div className="space-y-2">
                {Object.entries(execKpis.integrations_by_category).map(([cat, count]) => {
                  const pct = Math.round((count / execKpis.total_integrations) * 100);
                  const colors: Record<string, string> = { banking: '#3B82F6', insurance: '#14B8A6', enterprise: '#8B5CF6' };
                  return (
                    <div key={cat} className="flex items-center gap-2">
                      <CategoryBadge cat={cat as IntegrationCategory} />
                      <div className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: colors[cat] }} />
                      </div>
                      <span className="text-xs font-semibold text-slate-700 w-8 text-right">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Top Executive Risks</p>
              <div className="space-y-2">
                {execKpis.top_risks.map((risk, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-amber-100 bg-amber-50/30">
                    <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" aria-hidden />
                    <p className="text-xs text-slate-700">{risk}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Section 10: Readiness Score ──────────────────────────────────── */}
      {activeSection === 'readiness' && (
        <Panel title={titleWithIcon('Integration Readiness Score', Target, `Overall: ${readiness.overall_score}/100 · Grade ${readiness.grade}`)} data-testid="im-section-readiness">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <div className="flex items-center gap-4 mb-4">
                <div className="text-center p-4 rounded-full border-4 border-indigo-200 bg-indigo-50" style={{ width: 88, height: 88 }}>
                  <p className="text-2xl font-bold text-indigo-700">{readiness.overall_score}</p>
                  <p className="text-xs text-indigo-500">Grade {readiness.grade}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Industry Benchmark</p>
                  <div className="space-y-1">
                    {[
                      { label: 'Our Score', value: readiness.benchmark_comparison.our_score, color: '#6366F1' },
                      { label: 'Industry Avg', value: readiness.benchmark_comparison.industry_avg, color: '#94A3B8' },
                      { label: 'Top Quartile', value: readiness.benchmark_comparison.top_quartile, color: '#10B981' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="flex items-center gap-2">
                        <span className="text-xs text-slate-500 w-24">{label}</span>
                        <div className="w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${value}%`, backgroundColor: color }} />
                        </div>
                        <span className="text-xs font-semibold" style={{ color }}>{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <p className="text-xs font-semibold text-slate-700 mb-2">Dimension Scores</p>
              {READINESS_DIMENSIONS.map(dim => {
                const { score, status, gap } = readiness.dimensions[dim];
                return (
                  <div key={dim} className="mb-2">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-xs capitalize text-slate-600">{dim}</span>
                      <span className={`text-xs font-semibold ${status === 'good' ? 'text-green-600' : status === 'fair' ? 'text-amber-600' : 'text-red-600'}`}>{score}</span>
                    </div>
                    <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${score}%`, backgroundColor: status === 'good' ? '#10B981' : status === 'fair' ? '#F59E0B' : '#EF4444' }} />
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{gap}</p>
                  </div>
                );
              })}
            </div>

            <div>
              <p className="text-xs font-semibold text-slate-700 mb-2">Radar View</p>
              <ResponsiveContainer width="100%" height={240}>
                <RadarChart cx="50%" cy="50%" outerRadius="80%" data={scoreRadarData}>
                  <PolarGrid stroke="#e2e8f0" />
                  <PolarAngleAxis dataKey="dim" tick={{ fontSize: 9 }} />
                  <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fontSize: 8 }} />
                  <Radar name="Score" dataKey="score" stroke="#6366F1" fill="#6366F1" fillOpacity={0.35} />
                  <Tooltip contentStyle={{ fontSize: 11 }} />
                </RadarChart>
              </ResponsiveContainer>

              <div className="mt-3 grid grid-cols-1 gap-2">
                <div>
                  <p className="text-xs font-semibold text-green-700 mb-1">✓ Strengths</p>
                  {readiness.strengths.map((s, i) => <p key={i} className="text-xs text-slate-600 flex items-start gap-1"><ArrowRight className="size-3 text-green-400 shrink-0 mt-0.5" aria-hidden />{s}</p>)}
                </div>
                <div className="mt-2">
                  <p className="text-xs font-semibold text-amber-700 mb-1">⚡ Improvement Areas</p>
                  {readiness.improvement_areas.map((s, i) => <p key={i} className="text-xs text-slate-600 flex items-start gap-1"><ChevronRight className="size-3 text-amber-400 shrink-0 mt-0.5" aria-hidden />{s}</p>)}
                </div>
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* ─── Cross-IA footer ────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1 border-t border-slate-100">
        <span className="font-medium text-slate-500">Integration Marketplace · Phase 20</span>
        <span>·</span>
        {[
          ['/ai-decisioning-center', 'AI Decisioning (P19)'],
          ['/autonomous-risk-center', 'AI Agents (P18)'],
          ['/digital-twin-center', 'Digital Twin (P17)'],
          ['/data-fabric-center', 'Data Fabric (P14)'],
          ['/regulatory-compliance-center', 'Compliance'],
          ['/audit-center', 'Audit Center'],
        ].map(([path, label]) => (
          <Link key={path} to={path} className="hover:text-indigo-600 transition-colors">{label}</Link>
        ))}
        <span className="ml-auto text-slate-300">All 20 IA overlays active</span>
      </div>

    </div>
  );
}
