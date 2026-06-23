// web/src/modules/dashboard/EnterpriseCommandCenter.tsx
//
// Enterprise Risk Command Center — additive overlay on top of the existing
// DashboardPage. All 10 sections rendered as self-contained components.
// No existing routes, APIs, or widgets are modified.

import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Minus, ChevronRight, AlertTriangle,
  Shield, Activity, Target, Globe, Zap, MessageSquare, Send,
  ArrowUpRight, ArrowDownRight, CheckCircle2, AlertCircle,
  BarChart3, Map, Users, Building2,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/store/auth';
import { useTenantContext } from '@/lib/useOnboardingContext';
import { getOrganization } from '@/lib/organizations';
import { useDomain } from '@/lib/useOnboardingContext';
import {
  getEnterpriseRiskIndex,
  getExecutiveBriefing,
  getEmergingRisks,
  getHeatMap,
  getForecastStrip,
  getAlertRadar,
  getInvestigationHealth,
  getRegulatoryReadiness,
  getTenantBenchmarks,
  getCopilotResponse,
  COPILOT_PROMPTS,
  type HeatDimension,
} from './commandCenterEngine';

// ─── shared helpers ───────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#DC2626', high: '#F59E0B', medium: '#6366F1', low: '#16A34A',
};

const BAND_COLOR: Record<string, string> = {
  low: '#16A34A', medium: '#4F46E5', elevated: '#F59E0B', high: '#DC2626', critical: '#991B1B',
};

function TrendIcon({ direction, size = 14 }: { direction: string; size?: number }) {
  if (direction === 'up' || direction === 'increasing' || direction === 'accelerating')
    return <TrendingUp size={size} className="text-red-500" />;
  if (direction === 'down' || direction === 'decreasing' || direction === 'decelerating')
    return <TrendingDown size={size} className="text-green-600" />;
  return <Minus size={size} className="text-gray-400" />;
}

function SectionCard({ title, icon: Icon, href, children, className }: {
  title: string; icon?: React.ElementType; href?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('bg-white rounded-[12px] border border-[#E5E7EB] shadow-sm overflow-hidden', className)}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#E5E7EB] bg-[#F9FAFB]">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={15} className="text-[#4F46E5]" strokeWidth={1.75} />}
          <span className="text-[12.5px] font-semibold text-[#111827]">{title}</span>
        </div>
        {href && (
          <Link to={href} className="flex items-center gap-1 text-[11px] text-[#4F46E5] hover:underline">
            View full <ChevronRight size={11} />
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}

// ─── SECTION 1 — Enterprise Risk Index ────────────────────────────────────

function EnterpriseRiskIndexWidget({ tenant_id }: { tenant_id: string }) {
  const eri = useMemo(() => getEnterpriseRiskIndex(tenant_id), [tenant_id]);
  const radarData = eri.dimensions.map(d => ({ subject: d.name.replace(' Risk', ''), score: d.score }));

  return (
    <SectionCard title="Enterprise Risk Index" icon={Shield} href="/executive-cockpit">
      <div className="p-4">
        <div className="flex items-start gap-6 mb-4">
          {/* Score circle */}
          <div className="shrink-0">
            <div
              className="w-24 h-24 rounded-full flex flex-col items-center justify-center border-4"
              style={{ borderColor: BAND_COLOR[eri.band] }}
            >
              <span className="text-3xl font-bold" style={{ color: BAND_COLOR[eri.band] }}>{eri.score}</span>
              <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-500">{eri.band}</span>
            </div>
          </div>
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <TrendIcon direction={eri.direction} size={16} />
              <span className="text-[12px] text-gray-600">
                {eri.direction === 'increasing' ? '+' : eri.direction === 'decreasing' ? '−' : '±'}
                {Math.abs(eri.delta)} pts vs yesterday
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Target size={13} className="text-gray-400" />
              <span className="text-[12px] text-gray-600">Confidence: {eri.confidence}%</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 mt-3">
              {eri.dimensions.map(d => (
                <div key={d.name} className="flex items-center justify-between bg-gray-50 rounded-[6px] px-2 py-1">
                  <span className="text-[10px] text-gray-500 truncate mr-1">{d.name.replace(' Risk', '')}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] font-semibold text-gray-800">{d.score}</span>
                    <TrendIcon direction={d.trend} size={10} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="h-[120px]">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData}>
              <PolarGrid stroke="#E5E7EB" />
              <PolarAngleAxis dataKey="subject" tick={{ fontSize: 9, fill: '#6B7280' }} />
              <Radar name="Risk" dataKey="score" stroke="#4F46E5" fill="#4F46E5" fillOpacity={0.15} strokeWidth={1.5} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </SectionCard>
  );
}

// ─── SECTION 2 — Executive Morning Briefing ───────────────────────────────

function ExecutiveBriefingWidget({ tenant_id, userName }: { tenant_id: string; userName: string }) {
  const brief = useMemo(() => getExecutiveBriefing(tenant_id, userName), [tenant_id, userName]);
  const [expanded, setExpanded] = useState(false);

  return (
    <SectionCard title="Executive Briefing" icon={Activity} href="/executive-cockpit">
      <div className="p-4 space-y-3">
        <div>
          <p className="text-[13px] font-semibold text-[#111827]">{brief.greeting}, {brief.userName} 👋</p>
          <p className="text-[12px] text-[#6B7280] mt-0.5">{brief.headline}</p>
        </div>
        {/* KPI changes */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {brief.changes.map((c) => (
            <div key={c.label} className="bg-[#F9FAFB] rounded-[8px] px-2.5 py-2">
              <p className="text-[10px] text-gray-500 mb-0.5">{c.label}</p>
              <p className="text-[13px] font-bold text-gray-900">{c.value}</p>
              <p className={cn('text-[10px] font-medium', c.positive ? 'text-green-600' : 'text-red-500')}>{c.delta}</p>
            </div>
          ))}
        </div>
        {/* Priorities */}
        <div>
          <p className="text-[11px] font-semibold text-gray-700 mb-1.5">Top Priorities</p>
          <div className="space-y-1.5">
            {(expanded ? brief.priorities : brief.priorities.slice(0, 3)).map((p) => (
              <div key={p.rank} className="flex items-start gap-2 rounded-[8px] bg-gray-50 px-2.5 py-2">
                <span className={cn('shrink-0 text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center text-white',
                  p.urgency === 'immediate' ? 'bg-red-500' : p.urgency === 'today' ? 'bg-amber-500' : 'bg-indigo-500')}>
                  {p.rank}
                </span>
                <div className="min-w-0">
                  <p className="text-[11.5px] text-gray-800 leading-tight">{p.text}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5">{p.domain} · {p.urgency}</p>
                </div>
              </div>
            ))}
          </div>
          {brief.priorities.length > 3 && (
            <button onClick={() => setExpanded(e => !e)} className="text-[11px] text-indigo-600 mt-1.5 hover:underline">
              {expanded ? 'Show less' : `+${brief.priorities.length - 3} more`}
            </button>
          )}
        </div>
        {/* Actions */}
        <div>
          <p className="text-[11px] font-semibold text-gray-700 mb-1.5">Recommended Actions</p>
          {brief.actions.map((a, i) => (
            <div key={i} className="flex items-start gap-2 mb-1">
              <CheckCircle2 size={12} className="text-indigo-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-gray-700">{a}</p>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ─── SECTION 3 — Top Emerging Risks ──────────────────────────────────────

function EmergingRisksWidget({ tenant_id }: { tenant_id: string }) {
  const risks = useMemo(() => getEmergingRisks(tenant_id), [tenant_id]);
  const SEV_BADGE = { critical: 'bg-red-100 text-red-700', high: 'bg-amber-100 text-amber-700', medium: 'bg-indigo-100 text-indigo-700' };

  return (
    <SectionCard title="Top Emerging Risks" icon={AlertTriangle} href="/predictive-risk-center">
      <div className="divide-y divide-[#E5E7EB]">
        {risks.map((r, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors">
            <span className="text-[11px] font-bold text-gray-400 w-4 shrink-0">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-[12.5px] font-medium text-gray-900">{r.name}</p>
                <span className={cn('text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full', SEV_BADGE[r.severity])}>
                  {r.severity.toUpperCase()}
                </span>
              </div>
              <p className="text-[10.5px] text-gray-500 mt-0.5">{r.domain} · {r.impact} · {r.daysToMaterial}d to material</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[11px] font-semibold text-gray-700">{r.confidence}%</p>
              <div className="flex items-center gap-0.5 justify-end mt-0.5">
                <TrendIcon direction={r.trend} size={11} />
                <span className="text-[9.5px] text-gray-400">{r.trend}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── SECTION 4 — Enterprise Heat Map ─────────────────────────────────────

function EnterpriseHeatMap({ tenant_id }: { tenant_id: string; domain: 'banking' | 'insurance' | null }) {
  const [dim, setDim] = useState<HeatDimension>('Region');
  const cells = useMemo(() => getHeatMap(dim, tenant_id), [dim, tenant_id]);

  function heatColor(score: number): string {
    const pct = score / 100;
    if (pct < 0.35) return '#DCFCE7';
    if (pct < 0.55) return '#FEF3C7';
    if (pct < 0.70) return '#FED7AA';
    if (pct < 0.85) return '#FECACA';
    return '#FCA5A5';
  }

  const DIMS: HeatDimension[] = ['Region', 'Branch', 'Country', 'Tenant'];

  return (
    <SectionCard title="Enterprise Risk Heat Map" icon={Map} href="/branch-heatmap">
      <div className="p-4">
        <div className="flex gap-1.5 mb-3">
          {DIMS.map(d => (
            <button key={d} onClick={() => setDim(d)}
              className={cn('px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-colors',
                dim === d ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
              {d}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {cells.map((c) => (
            <div key={c.label}
              className="rounded-[8px] p-2.5 border border-[#E5E7EB] text-center"
              style={{ background: heatColor(c.riskScore) }}
            >
              <p className="text-[10px] font-semibold text-gray-700 truncate">{c.label}</p>
              <p className="text-[18px] font-bold text-gray-900 leading-tight">{c.riskScore}</p>
              <p className="text-[9px] text-gray-500">{c.alertDensity} alerts · {c.caseDensity} cases</p>
              {c.violations > 0 && <p className="text-[9px] text-red-600 font-medium mt-0.5">{c.violations} violations</p>}
            </div>
          ))}
        </div>
        {/* Legend */}
        <div className="flex items-center gap-2 mt-3 justify-center">
          {['Low', 'Medium', 'Elevated', 'High', 'Critical'].map((l, i) => (
            <div key={l} className="flex items-center gap-1">
              <div className="w-2.5 h-2.5 rounded-sm" style={{ background: ['#DCFCE7','#FEF3C7','#FED7AA','#FECACA','#FCA5A5'][i] }} />
              <span className="text-[9px] text-gray-500">{l}</span>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ─── SECTION 5 — Forecast Strip ───────────────────────────────────────────

function ForecastStrip({ tenant_id }: { tenant_id: string }) {
  const forecasts = useMemo(() => getForecastStrip(tenant_id), [tenant_id]);
  const HORIZONS = ['30d', '60d', '90d', '180d'] as const;
  const METRICS = ['NPA Forecast', 'Fraud Exposure', 'Claims Ratio', 'Compliance Score', 'Portfolio Risk'];

  return (
    <SectionCard title="Executive Forecast Strip" icon={BarChart3} href="/predictive-risk-center">
      <div className="p-4 overflow-x-auto">
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left text-[10px] font-semibold text-gray-500 pb-2 pr-3">Metric</th>
              {HORIZONS.map(h => <th key={h} className="text-center text-[10px] font-semibold text-gray-500 pb-2 px-2">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {METRICS.map(metric => (
              <tr key={metric} className="hover:bg-gray-50 transition-colors">
                <td className="py-2 pr-3 font-medium text-gray-700 whitespace-nowrap">{metric}</td>
                {HORIZONS.map(h => {
                  const item = forecasts.find(f => f.label === metric && f.horizon === h);
                  if (!item) return <td key={h} className="px-2 py-2 text-center text-gray-400">—</td>;
                  return (
                    <td key={h} className="px-2 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <span className="font-semibold" style={{ color: item.color }}>{item.value}</span>
                        <TrendIcon direction={item.direction} size={11} />
                      </div>
                      <p className="text-[9px] text-gray-400">{item.confidence}% conf</p>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── SECTION 6 — Alert Radar ──────────────────────────────────────────────

function AlertRadarWidget({ tenant_id }: { tenant_id: string }) {
  const radar = useMemo(() => getAlertRadar(tenant_id), [tenant_id]);
  const total = radar.reduce((s, r) => s + r.count, 0);

  return (
    <SectionCard title="Alert Radar" icon={Zap} href="/alerts">
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {radar.map(r => (
            <div key={r.severity} className="text-center rounded-[8px] p-2.5 bg-gray-50 border border-gray-100">
              <p className="text-[9px] font-semibold uppercase tracking-wide mb-1"
                style={{ color: SEVERITY_COLOR[r.severity] }}>{r.severity}</p>
              <p className="text-[22px] font-bold text-gray-900 leading-none">{r.count}</p>
              <div className="flex items-center justify-center gap-0.5 mt-1">
                {r.trend > 0 ? <ArrowUpRight size={10} className="text-red-500" /> :
                 r.trend < 0 ? <ArrowDownRight size={10} className="text-green-600" /> :
                 <Minus size={10} className="text-gray-400" />}
                <span className="text-[9px] text-gray-500">{r.trend > 0 ? '+' : ''}{r.trend}%</span>
              </div>
              {r.slaBreaches > 0 && (
                <p className="text-[9px] text-red-600 mt-0.5 font-medium">{r.slaBreaches} SLA ⚠</p>
              )}
            </div>
          ))}
        </div>
        <div className="h-[100px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={radar} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F3F4F6" />
              <XAxis dataKey="severity" tick={{ fontSize: 9 }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip contentStyle={{ fontSize: 11, border: '1px solid #E5E7EB', borderRadius: 8 }} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {radar.map((r) => <Cell key={r.severity} fill={SEVERITY_COLOR[r.severity]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[11px] text-gray-500 text-center">Total {total} active alerts</p>
      </div>
    </SectionCard>
  );
}

// ─── SECTION 7 — Investigation Health ────────────────────────────────────

function InvestigationHealthWidget({ tenant_id }: { tenant_id: string }) {
  const health = useMemo(() => getInvestigationHealth(tenant_id), [tenant_id]);
  const TREND_ICON = health.trend === 'improving' ? '↗' : health.trend === 'deteriorating' ? '↘' : '→';
  const TREND_CLR = health.trend === 'improving' ? 'text-green-600' : health.trend === 'deteriorating' ? 'text-red-500' : 'text-gray-400';

  const ITEMS = [
    { label: 'Open',             value: health.open,             alert: false },
    { label: 'Escalated',        value: health.escalated,        alert: health.escalated > 5 },
    { label: 'Pending Approval', value: health.pendingApproval,  alert: health.pendingApproval > 10 },
    { label: 'SLA Breaches',     value: health.slaBreaches,      alert: health.slaBreaches > 0 },
    { label: 'Closed Today',     value: health.closedToday,      alert: false },
    { label: 'Avg Resolution',   value: `${health.avgResolutionHours}h`, alert: health.avgResolutionHours > 48 },
  ];

  return (
    <SectionCard title="Investigation Health" icon={Shield} href="/investigation-center">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className={cn('text-[12px] font-semibold', TREND_CLR)}>{TREND_ICON} {health.trend}</span>
          <span className="text-[11px] text-gray-400">· {health.open} active investigations</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {ITEMS.map(({ label, value, alert }) => (
            <div key={label} className={cn('rounded-[8px] p-2.5 text-center border',
              alert ? 'bg-red-50 border-red-100' : 'bg-gray-50 border-gray-100')}>
              <p className={cn('text-[20px] font-bold leading-none', alert ? 'text-red-600' : 'text-gray-900')}>{value}</p>
              <p className={cn('text-[9.5px] mt-0.5', alert ? 'text-red-500 font-medium' : 'text-gray-500')}>{label}</p>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ─── SECTION 8 — Regulatory Readiness ────────────────────────────────────

function RegulatoryReadinessWidget({ tenant_id }: { tenant_id: string }) {
  const readiness = useMemo(() => getRegulatoryReadiness(tenant_id), [tenant_id]);
  const STATUS_ICON = { compliant: <CheckCircle2 size={13} className="text-green-600" />, 'at-risk': <AlertCircle size={13} className="text-amber-500" />, breach: <AlertTriangle size={13} className="text-red-500" /> };

  return (
    <SectionCard title="Regulatory Readiness" icon={Globe} href="/regulatory-compliance-center">
      <div className="p-4 space-y-2">
        {readiness.map(r => (
          <div key={r.regulator} className="flex items-center gap-3 rounded-[8px] p-2.5 bg-gray-50 hover:bg-gray-100 transition-colors">
            <div className="shrink-0">{STATUS_ICON[r.status]}</div>
            <div className="w-10 shrink-0">
              <p className="text-[11.5px] font-bold text-gray-800">{r.regulator}</p>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-1 mb-1">
                <div className="flex-1 h-1.5 rounded-full bg-gray-200">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${r.compliance}%`, background: r.compliance >= 85 ? '#16A34A' : r.compliance >= 72 ? '#F59E0B' : '#DC2626' }} />
                </div>
                <span className="text-[10px] font-semibold text-gray-700 w-8 text-right">{r.compliance}%</span>
              </div>
              <p className="text-[9.5px] text-gray-400">{r.nextDeadline}</p>
            </div>
            <TrendIcon direction={r.trend} size={12} />
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── SECTION 9 — Tenant Benchmarking ─────────────────────────────────────

function TenantBenchmarkWidget({ tenant_id, domain }: { tenant_id: string; domain: 'banking' | 'insurance' | null }) {
  const benchmarks = useMemo(
    () => getTenantBenchmarks(tenant_id, domain),
    [tenant_id, domain],
  );

  return (
    <SectionCard title="Tenant Benchmarking" icon={Users} href="/dashboards/role-based">
      <div className="p-4 overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left text-[10px] font-semibold text-gray-500 pb-2 pr-3">Tenant</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 pb-2 px-1.5">Risk</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 pb-2 px-1.5">Alerts/1k</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 pb-2 px-1.5">Fraud bps</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 pb-2 px-1.5">Recovery</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 pb-2 px-1.5">Compliance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {benchmarks.map(b => (
              <tr key={b.tenant} className={cn('hover:bg-gray-50 transition-colors', b.isSelf && 'bg-indigo-50/50')}>
                <td className={cn('py-2 pr-3 font-medium', b.isSelf ? 'text-indigo-700' : 'text-gray-700')}>
                  {b.isSelf && <span className="mr-1">★</span>}{b.tenant}
                </td>
                <td className="px-1.5 py-2 text-center font-semibold" style={{ color: b.riskScore > 65 ? '#DC2626' : b.riskScore > 45 ? '#F59E0B' : '#16A34A' }}>{b.riskScore}</td>
                <td className="px-1.5 py-2 text-center text-gray-700">{b.alertRate}</td>
                <td className="px-1.5 py-2 text-center text-gray-700">{b.fraudRate}</td>
                <td className="px-1.5 py-2 text-center text-gray-700">{b.recoveryRate}%</td>
                <td className="px-1.5 py-2 text-center font-semibold" style={{ color: b.complianceScore >= 85 ? '#16A34A' : '#F59E0B' }}>{b.complianceScore}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[9.5px] text-gray-400 mt-2 text-center">* Peer data anonymized — industry benchmark model</p>
      </div>
    </SectionCard>
  );
}

// ─── SECTION 10 — AI Executive Copilot ───────────────────────────────────

function AICopilotPanel({ tenant_id }: { tenant_id: string }) {
  const [selected, setSelected] = useState<string>(COPILOT_PROMPTS[0]);
  const [custom, setCustom] = useState('');
  const response = useMemo(() => getCopilotResponse(selected, tenant_id), [selected, tenant_id]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (custom.trim()) { setSelected(custom.trim()); setCustom(''); }
  };

  return (
    <div className="bg-white rounded-[12px] border border-[#E5E7EB] shadow-sm overflow-hidden h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#E5E7EB] bg-gradient-to-r from-indigo-600 to-violet-600">
        <MessageSquare size={15} className="text-white" />
        <span className="text-[12.5px] font-semibold text-white">AI Executive Copilot</span>
        <Link to="/ai/workbench" className="ml-auto text-[10px] text-indigo-200 hover:text-white flex items-center gap-0.5">
          Full Workbench <ChevronRight size={10} />
        </Link>
      </div>

      {/* Prompt suggestions */}
      <div className="p-3 border-b border-gray-100 space-y-1.5">
        {COPILOT_PROMPTS.map(p => (
          <button key={p} onClick={() => setSelected(p)}
            className={cn('w-full text-left text-[11px] px-3 py-2 rounded-[8px] transition-colors',
              selected === p ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>
            "{p}"
          </button>
        ))}
      </div>

      {/* Custom input */}
      <form onSubmit={handleSubmit} className="flex gap-1.5 p-3 border-b border-gray-100">
        <input
          value={custom}
          onChange={e => setCustom(e.target.value)}
          placeholder="Ask a risk question…"
          className="flex-1 text-[11.5px] px-3 py-1.5 rounded-[8px] border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400"
        />
        <button type="submit" className="p-1.5 rounded-[8px] bg-indigo-600 text-white hover:bg-indigo-700 transition-colors">
          <Send size={13} />
        </button>
      </form>

      {/* Response */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="bg-indigo-50 rounded-[8px] p-3">
          <p className="text-[11px] font-semibold text-indigo-700 mb-1.5">"{response.query}"</p>
          <p className="text-[12px] text-gray-800 leading-relaxed">{response.explanation}</p>
        </div>

        <div>
          <p className="text-[10.5px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Risk Drivers</p>
          {response.riskDrivers.map((d, i) => (
            <div key={i} className="flex items-start gap-1.5 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400 mt-1.5 shrink-0" />
              <p className="text-[11.5px] text-gray-700">{d}</p>
            </div>
          ))}
        </div>

        <div>
          <p className="text-[10.5px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Recommended Actions</p>
          {response.actions.map((a, i) => (
            <div key={i} className="flex items-start gap-1.5 mb-1">
              <CheckCircle2 size={11} className="text-green-500 shrink-0 mt-0.5" />
              <p className="text-[11.5px] text-gray-700">{a}</p>
            </div>
          ))}
        </div>

        <div className="flex gap-3 pt-1 border-t border-gray-100">
          <Link to="/investigation-center" className="flex items-center gap-1 text-[10.5px] text-indigo-600 hover:underline">
            <Building2 size={10} /> {response.relatedCases} related cases
          </Link>
          <Link to="/alerts" className="flex items-center gap-1 text-[10.5px] text-indigo-600 hover:underline">
            <Zap size={10} /> {response.relatedAlerts} related alerts
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────

export function EnterpriseCommandCenter() {
  const user = useAuth((s) => s.user);
  const [tenantCtx] = useTenantContext();
  const [domain] = useDomain();

  const tenant_id = tenantCtx?.tenant_id ?? 'BANK_DEMO';
  const orgName = (() => {
    if (tenantCtx?.organization_id) {
      const org = getOrganization(tenantCtx.organization_id);
      if (org) return org.short_name ?? org.name;
    }
    return tenant_id === 'BIL' ? 'BIL Insurance' : 'Banking Enterprise';
  })();

  const userName = user?.display_name ?? user?.username?.split('.')[0] ?? 'Executive';
  const domainCast = domain === 'insurance' ? 'insurance' : domain === 'banking' ? 'banking' : null;

  return (
    <div className="space-y-4">
      {/* Header strip */}
      <div className="flex items-center justify-between bg-gradient-to-r from-indigo-600 to-violet-700 rounded-[12px] px-5 py-3">
        <div>
          <p className="text-white text-[14px] font-semibold">Enterprise Risk Command Center</p>
          <p className="text-indigo-200 text-[11px]">{orgName} · Live dashboard · Updated just now</p>
        </div>
        <div className="flex gap-2">
          <Link to="/executive-cockpit" className="text-[11px] text-indigo-100 hover:text-white border border-indigo-400/50 hover:border-white px-3 py-1.5 rounded-[8px] transition-colors">
            Executive Cockpit ↗
          </Link>
          <Link to="/predictive-risk-center" className="text-[11px] text-indigo-100 hover:text-white border border-indigo-400/50 hover:border-white px-3 py-1.5 rounded-[8px] transition-colors">
            Predictive Center ↗
          </Link>
        </div>
      </div>

      {/* Layout: main 3-col + right copilot */}
      <div className="flex gap-4">
        {/* Main area */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* Row 1 — Risk Index + Briefing */}
          <div className="grid grid-cols-2 gap-4">
            <EnterpriseRiskIndexWidget tenant_id={tenant_id} />
            <ExecutiveBriefingWidget tenant_id={tenant_id} userName={userName} />
          </div>

          {/* Row 2 — Emerging Risks + Forecast */}
          <div className="grid grid-cols-2 gap-4">
            <EmergingRisksWidget tenant_id={tenant_id} />
            <ForecastStrip tenant_id={tenant_id} />
          </div>

          {/* Row 3 — Heat Map full width */}
          <EnterpriseHeatMap tenant_id={tenant_id} domain={domainCast} />

          {/* Row 4 — Alert Radar + Investigation Health */}
          <div className="grid grid-cols-2 gap-4">
            <AlertRadarWidget tenant_id={tenant_id} />
            <InvestigationHealthWidget tenant_id={tenant_id} />
          </div>

          {/* Row 5 — Regulatory + Benchmarking */}
          <div className="grid grid-cols-2 gap-4">
            <RegulatoryReadinessWidget tenant_id={tenant_id} />
            <TenantBenchmarkWidget tenant_id={tenant_id} domain={domainCast} />
          </div>
        </div>

        {/* Right: AI Copilot sticky */}
        <div className="w-[300px] shrink-0 sticky top-0 self-start" style={{ maxHeight: 'calc(100vh - 80px)' }}>
          <AICopilotPanel tenant_id={tenant_id} />
        </div>
      </div>
    </div>
  );
}
