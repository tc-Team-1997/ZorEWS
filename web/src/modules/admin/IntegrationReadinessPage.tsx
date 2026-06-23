// IntegrationReadinessPage.tsx
//
// ZorEWS — Integration Readiness Dashboard
// Source availability, data freshness, health monitoring, readiness score,
// mode switching (Demo ↔ Hybrid ↔ Live Enterprise), and data lineage.
//
// Route: /admin/integration-readiness  (additive, no existing routes changed)

import { useState, useEffect, useCallback } from 'react';
import {
  Activity, CheckCircle2, AlertTriangle, XCircle, RefreshCw,
  Database, Shield, Clock, GitBranch,
  ChevronDown, ChevronRight, Lock,
  AlertOctagon, Info,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/layout/PageHeader';

// Engine imports
import {
  getGlobalMode, setGlobalMode, setSourceMode, getEffectiveMode,
  probeAllSources, getModeSummary, resetToDemo,
  type DataMode, type DataSourceId,
} from '@/lib/integration/liveDataAdapter';
import {
  startHealthMonitoring, stopHealthMonitoring, getAllSourceMetrics,
  getFleetHealthSummary, SOURCE_METADATA,
  type SourceHealthMetrics, type HealthStatus,
} from '@/lib/integration/dataSourceHealthEngine';
import {
  getAllFreshnessRecords, getFreshnessFleetSummary, formatAge,
  FRESHNESS_COLORS, type FreshnessRecord,
  recordRefresh,
} from '@/lib/integration/dataFreshnessEngine';
import {
  generateReadinessReport, getLineageCatalog, TIER_LABELS,
  type EnterpriseReadinessReport, type ReadinessTier,
} from '@/lib/integration/integrationReadinessEngine';

// ─── Status helpers ───────────────────────────────────────────────────────

const STATUS_STYLE: Record<HealthStatus, { icon: React.ElementType; color: string; bg: string; label: string }> = {
  healthy:   { icon: CheckCircle2, color: 'text-green-600',  bg: 'bg-green-50',  label: 'Healthy' },
  degraded:  { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50',  label: 'Degraded' },
  failing:   { icon: XCircle,       color: 'text-red-600',   bg: 'bg-red-50',    label: 'Failing' },
  unknown:   { icon: Info,          color: 'text-[#9CA3AF]', bg: 'bg-[#F3F4F6]', label: 'Unknown' },
  demo_only: { icon: Database,      color: 'text-[#4F46E5]', bg: 'bg-[#EEF2FF]', label: 'Demo' },
};

const MODE_COLORS: Record<DataMode, string> = {
  demo:   'bg-[#EEF2FF] text-[#4F46E5]',
  hybrid: 'bg-amber-50 text-amber-700',
  live:   'bg-green-50 text-green-700',
};

// ─── Source row ───────────────────────────────────────────────────────────

function SourceRow({
  metrics, freshness,
}: {
  metrics:   SourceHealthMetrics;
  freshness: FreshnessRecord | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourceMode  = getEffectiveMode(metrics.sourceId as DataSourceId);
  const statusStyle = STATUS_STYLE[metrics.status];
  const StatusIcon  = statusStyle.icon;
  const fColors     = freshness ? FRESHNESS_COLORS[freshness.status] : FRESHNESS_COLORS.unknown;

  return (
    <div className="border-b border-[#F3F4F6] last:border-0">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#F9FAFB] transition-colors text-left"
      >
        <StatusIcon size={13} className={statusStyle.color} strokeWidth={2} />
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-semibold text-[#111827] truncate">{metrics.displayName}</p>
          <p className="text-[10px] text-[#9CA3AF]">{SOURCE_METADATA[metrics.sourceId as DataSourceId]?.category?.replace('_', ' ')}</p>
        </div>
        {/* Mode badge */}
        <span className={cn('text-[9px] font-bold px-2 py-0.5 rounded-full', MODE_COLORS[sourceMode])}>
          {sourceMode.toUpperCase()}
        </span>
        {/* Latency */}
        <div className="text-right w-16">
          <p className="text-[11px] font-mono text-[#374151]">
            {metrics.p95LatencyMs !== null ? `${metrics.p95LatencyMs}ms` : '—'}
          </p>
          <p className="text-[9px] text-[#9CA3AF]">p95</p>
        </div>
        {/* Uptime */}
        <div className="text-right w-12">
          <p className="text-[11px] font-mono text-[#374151]">{Math.round(metrics.uptime * 100)}%</p>
          <p className="text-[9px] text-[#9CA3AF]">uptime</p>
        </div>
        {/* Freshness */}
        <div className={cn('text-[9px] font-medium px-1.5 py-0.5 rounded-full w-16 text-center', fColors.bg, fColors.text)}>
          {freshness ? formatAge(freshness.ageMs) : '—'}
        </div>
        {/* SLA */}
        <div className={cn('w-5 h-5 rounded-full flex items-center justify-center shrink-0',
          metrics.slaCompliant ? 'bg-green-100' : 'bg-red-100')}>
          {metrics.slaCompliant
            ? <CheckCircle2 size={10} className="text-green-600" />
            : <XCircle size={10} className="text-red-600" />}
        </div>
        {expanded ? <ChevronDown size={12} className="text-[#9CA3AF]" /> : <ChevronRight size={12} className="text-[#9CA3AF]" />}
      </button>

      {expanded && (
        <div className="px-4 pb-3 bg-[#FAFAFA] border-t border-[#F3F4F6]">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
            <div>
              <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Metrics</p>
              <p className="text-[10.5px] text-[#374151]">p50: {metrics.p50LatencyMs ?? '—'}ms</p>
              <p className="text-[10.5px] text-[#374151]">Error rate: {Math.round(metrics.errorRate * 100)}%</p>
              <p className="text-[10.5px] text-[#374151]">Fails: {metrics.consecutiveFails} consecutive</p>
            </div>
            <div>
              <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Freshness</p>
              <p className="text-[10.5px] text-[#374151]">Expected: {freshness?.expectedInterval ?? '—'}</p>
              <p className="text-[10.5px] text-[#374151]">Refreshed: {freshness?.refreshCount ?? 0}×</p>
              <p className="text-[10.5px] text-[#374151]">Source: {freshness?.source ?? '—'}</p>
            </div>
            <div>
              <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">SLA Target</p>
              <p className="text-[10.5px] text-[#374151]">p95 ≤ {metrics.slaTarget.p95LatencyMs}ms</p>
              <p className="text-[10.5px] text-[#374151]">Uptime ≥ {Math.round(metrics.slaTarget.uptimeTarget * 100)}%</p>
              <p className="text-[10.5px] text-[#374151]">Error ≤ {Math.round(metrics.slaTarget.maxErrorRate * 100)}%</p>
            </div>
          </div>
          {/* Mode switcher */}
          <div className="flex items-center gap-2 mt-3">
            <p className="text-[9.5px] text-[#9CA3AF]">Source mode:</p>
            {(['demo', 'hybrid', 'live'] as DataMode[]).map(m => (
              <button key={m}
                onClick={() => { setSourceMode(metrics.sourceId as DataSourceId, m); recordRefresh(metrics.sourceId as DataSourceId, m === 'demo' ? 'demo' : 'live'); }}
                className={cn('px-2 py-0.5 rounded text-[9px] font-semibold transition-colors',
                  sourceMode === m ? MODE_COLORS[m] : 'bg-[#F3F4F6] text-[#6B7280] hover:bg-[#E5E7EB]')}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────

export function IntegrationReadinessPage() {
  const [report, setReport]           = useState<EnterpriseReadinessReport | null>(null);
  const [metrics, setMetrics]         = useState<SourceHealthMetrics[]>([]);
  const [freshnessRecs, setFreshness] = useState<FreshnessRecord[]>([]);
  const [probing, setProbing]         = useState(false);
  const [activeTab, setActiveTab]     = useState<'overview' | 'sources' | 'freshness' | 'lineage' | 'checklist'>('overview');
  const [expandLineage, setExpandLineage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setMetrics(getAllSourceMetrics());
    setFreshness(getAllFreshnessRecords());
    setReport(generateReadinessReport());
  }, []);

  useEffect(() => {
    startHealthMonitoring();
    refresh();
    const onUpdate = () => refresh();
    window.addEventListener('zorews:health-update', onUpdate);
    window.addEventListener('zorews:freshness-update', onUpdate);
    window.addEventListener('zorews:mode-change', onUpdate);
    return () => {
      stopHealthMonitoring();
      window.removeEventListener('zorews:health-update', onUpdate);
      window.removeEventListener('zorews:freshness-update', onUpdate);
      window.removeEventListener('zorews:mode-change', onUpdate);
    };
  }, [refresh]);

  const handleProbeAll = async () => {
    setProbing(true);
    await probeAllSources();
    refresh();
    setProbing(false);
  };

  const globalMode   = getGlobalMode();
  const modeSummary  = getModeSummary();
  const healthFleet  = getFleetHealthSummary();
  const freshFleet   = getFreshnessFleetSummary();
  const tier         = (report?.tier ?? 'demo_ready') as ReadinessTier;
  const tierStyle    = TIER_LABELS[tier];

  const freshnessMap = new Map(freshnessRecs.map(r => [r.sourceId, r]));

  return (
    <div className="min-h-screen bg-[#F5F7FA] p-4 space-y-4">
      <PageHeader
        title="Integration Readiness"
        subtitle="Dual-mode architecture status · Source health · Data freshness · Enterprise readiness"
        actions={
          <div className="flex items-center gap-2">
            <button onClick={handleProbeAll} disabled={probing}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[11px] font-semibold transition-colors',
                probing ? 'bg-[#F3F4F6] text-[#9CA3AF]' : 'bg-[#4F46E5] text-white hover:bg-[#4338CA]')}>
              <RefreshCw size={12} className={probing ? 'animate-spin' : ''} />
              {probing ? 'Probing…' : 'Probe All Sources'}
            </button>
          </div>
        }
      />

      {/* ── Mode switcher banner ────────────────────────────────────────── */}
      <div className="bg-white rounded-[12px] border border-[#E5E7EB] p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-[11px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Platform Mode</p>
            <div className="flex items-center gap-3">
              {(['demo', 'hybrid', 'live'] as DataMode[]).map(m => (
                <button key={m}
                  onClick={() => { setGlobalMode(m); refresh(); }}
                  className={cn(
                    'flex flex-col items-center px-4 py-2.5 rounded-[10px] border-2 transition-all text-center min-w-[120px]',
                    globalMode === m ? 'border-[#4F46E5] bg-[#EEF2FF]' : 'border-[#E5E7EB] hover:border-[#4F46E5]/40',
                  )}>
                  <div className={cn('w-3 h-3 rounded-full mb-1', globalMode === m ? 'bg-[#4F46E5]' : 'bg-[#D1D5DB]')} />
                  <p className={cn('text-[12px] font-bold', globalMode === m ? 'text-[#4F46E5]' : 'text-[#374151]')}>
                    {m === 'demo' ? 'Demo Mode' : m === 'hybrid' ? 'Hybrid Mode' : 'Live Enterprise'}
                  </p>
                  <p className="text-[9px] text-[#9CA3AF] mt-0.5">
                    {m === 'demo' ? 'Synth data always' : m === 'hybrid' ? 'Mix of live + demo' : 'All real APIs'}
                  </p>
                </button>
              ))}
              {globalMode !== 'demo' && (
                <button onClick={() => { resetToDemo(); refresh(); }}
                  className="text-[10px] text-red-500 hover:underline flex items-center gap-1">
                  <Lock size={10} /> Reset to Demo
                </button>
              )}
            </div>
          </div>
          {/* Quick stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Readiness Score', value: `${report?.overallScore ?? 0}/100`, color: (report?.overallScore ?? 0) >= 80 ? 'text-green-600' : 'text-amber-600' },
              { label: 'Sources Live', value: `${modeSummary.sourcesLive}/${modeSummary.totalSources}`, color: 'text-[#4F46E5]' },
              { label: 'SLA Compliant', value: `${healthFleet.slaCompliant}/${healthFleet.totalSources}`, color: 'text-green-600' },
              { label: 'Data Fresh', value: `${freshFleet.fresh}/${freshFleet.total}`, color: freshFleet.critical > 0 ? 'text-red-600' : 'text-green-600' },
            ].map(({ label, value, color }) => (
              <div key={label} className="text-center">
                <p className={cn('text-[18px] font-bold', color)}>{value}</p>
                <p className="text-[9px] text-[#9CA3AF]">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Readiness score card ────────────────────────────────────────── */}
      <div className={cn('rounded-[12px] border p-4 flex items-center gap-4', tierStyle.bg, 'border-current/20')}>
        <div className="text-center shrink-0">
          <p className={cn('text-[40px] font-black leading-none', tierStyle.color)}>{report?.overallScore ?? 0}</p>
          <p className="text-[10px] text-[#6B7280] mt-0.5">/ 100</p>
        </div>
        <div className="flex-1">
          <p className={cn('text-[14px] font-bold', tierStyle.color)}>{tierStyle.label}</p>
          <p className="text-[11px] text-[#6B7280]">{tierStyle.description}</p>
          {report && report.recommendations.length > 0 && (
            <p className="text-[10px] text-[#374151] mt-1 font-medium">
              Top recommendation: {report.recommendations[0]}
            </p>
          )}
        </div>
        {/* Dimension bars */}
        <div className="hidden xl:flex flex-col gap-1 min-w-[200px]">
          {report?.dimensions.map(d => (
            <div key={d.name} className="flex items-center gap-2">
              <p className="text-[9px] text-[#9CA3AF] w-[90px] text-right shrink-0">{d.name}</p>
              <div className="flex-1 bg-[#E5E7EB] rounded-full h-1.5">
                <div className={cn('h-1.5 rounded-full transition-all', d.score >= 80 ? 'bg-green-500' : d.score >= 50 ? 'bg-amber-500' : 'bg-red-500')}
                  style={{ width: `${d.score}%` }} />
              </div>
              <p className="text-[9px] font-bold text-[#374151] w-6">{d.score}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-[12px] border border-[#E5E7EB] overflow-hidden">
        <div className="flex border-b border-[#F3F4F6]">
          {([
            ['overview',  'Overview',  Activity],
            ['sources',   'Sources',   Database],
            ['freshness', 'Freshness', Clock],
            ['lineage',   'Lineage',   GitBranch],
            ['checklist', 'Checklist', CheckCircle2],
          ] as const).map(([tab, label, Icon]) => (
            <button key={tab} onClick={() => setActiveTab(tab as typeof activeTab)}
              className={cn('flex items-center gap-1.5 px-4 py-2.5 text-[11px] font-semibold transition-colors border-b-2',
                activeTab === tab
                  ? 'text-[#4F46E5] border-[#4F46E5]'
                  : 'text-[#9CA3AF] border-transparent hover:text-[#374151]')}>
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>

        {/* ── OVERVIEW tab ── */}
        {activeTab === 'overview' && report && (
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {report.dimensions.map(d => (
                <div key={d.name} className={cn('rounded-[10px] p-3 border', d.status === 'pass' ? 'border-green-100 bg-green-50' : d.status === 'warn' ? 'border-amber-100 bg-amber-50' : 'border-red-100 bg-red-50')}>
                  <p className={cn('text-[22px] font-black leading-none', d.status === 'pass' ? 'text-green-700' : d.status === 'warn' ? 'text-amber-700' : 'text-red-700')}>{d.score}</p>
                  <p className="text-[10.5px] font-semibold text-[#374151] mt-0.5">{d.name}</p>
                  <p className="text-[9px] text-[#9CA3AF] mt-0.5 leading-snug">{d.description}</p>
                  <ul className="mt-2 space-y-0.5">
                    {d.details.map((det, i) => (
                      <li key={i} className="text-[9px] text-[#6B7280]">• {det}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {/* Recommendations */}
            {report.recommendations.length > 0 && (
              <div className="rounded-[10px] border border-[#E5E7EB] p-3">
                <p className="text-[11px] font-bold text-[#111827] mb-2">Recommendations</p>
                <ol className="space-y-1">
                  {report.recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-[9px] font-bold text-[#4F46E5] bg-[#EEF2FF] rounded-full w-4 h-4 flex items-center justify-center shrink-0 mt-0.5">{i + 1}</span>
                      <p className="text-[10.5px] text-[#374151]">{r}</p>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {/* ── SOURCES tab ── */}
        {activeTab === 'sources' && (
          <div>
            <div className="flex items-center justify-between px-4 py-2 border-b border-[#F3F4F6] bg-[#F9FAFB]">
              <div className="flex items-center gap-4 text-[9px] text-[#9CA3AF] font-semibold uppercase tracking-wide">
                <span className="w-[200px]">Source</span>
                <span className="w-16">Mode</span>
                <span className="w-16 text-right">p95</span>
                <span className="w-12 text-right">Uptime</span>
                <span className="w-16 text-center">Freshness</span>
                <span className="w-5 text-center">SLA</span>
              </div>
            </div>
            {metrics.map(m => (
              <SourceRow key={m.sourceId} metrics={m} freshness={freshnessMap.get(m.sourceId as DataSourceId)} />
            ))}
          </div>
        )}

        {/* ── FRESHNESS tab ── */}
        {activeTab === 'freshness' && (
          <div className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
              {(['fresh','aging','stale','critical','unknown'] as const).map(s => {
                const count = freshnessRecs.filter(r => r.status === s).length;
                const colors = FRESHNESS_COLORS[s];
                return (
                  <div key={s} className={cn('rounded-[8px] p-2.5 text-center', colors.bg)}>
                    <p className={cn('text-[18px] font-bold', colors.text)}>{count}</p>
                    <p className={cn('text-[9px] font-semibold capitalize', colors.text)}>{s}</p>
                  </div>
                );
              })}
            </div>
            <div className="space-y-2">
              {freshnessRecs.map(r => {
                const fColors = FRESHNESS_COLORS[r.status];
                return (
                  <div key={r.sourceId} className="flex items-center gap-3 p-2.5 rounded-[8px] border border-[#F3F4F6] bg-white">
                    <div className={cn('w-2 h-2 rounded-full shrink-0', fColors.dot)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-semibold text-[#111827]">{r.displayName}</p>
                      <p className="text-[9px] text-[#9CA3AF]">Expected: {r.expectedInterval} · Source: {r.source}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] font-mono text-[#374151]">{formatAge(r.ageMs)}</p>
                      <p className="text-[9px] text-[#9CA3AF]">{r.lastRefreshedAt ? new Date(r.lastRefreshedAt).toLocaleTimeString() : 'Never'}</p>
                    </div>
                    <span className={cn('text-[9px] font-semibold px-2 py-0.5 rounded-full capitalize', fColors.bg, fColors.text)}>
                      {r.status}
                    </span>
                    <p className="text-[9px] text-[#9CA3AF] w-12 text-right">{r.refreshCount}× refreshed</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── LINEAGE tab ── */}
        {activeTab === 'lineage' && (
          <div className="p-4 space-y-2">
            {getLineageCatalog().map(entry => (
              <div key={entry.sourceId} className="rounded-[10px] border border-[#E5E7EB] bg-white overflow-hidden">
                <button
                  onClick={() => setExpandLineage(expandLineage === entry.sourceId ? null : entry.sourceId)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#F9FAFB] transition-colors text-left"
                >
                  <Database size={13} className="text-[#4F46E5] shrink-0" />
                  <div className="flex-1">
                    <p className="text-[12px] font-semibold text-[#111827]">{entry.displayName}</p>
                    <p className="text-[10px] text-[#9CA3AF]">{entry.sourceSystem} · {entry.protocol}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {entry.piiFlag && <span className="text-[8px] bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded-full font-semibold">PII</span>}
                    {entry.encryptedInTransit && <span title="Encrypted in transit"><Shield size={10} className="text-green-600" /></span>}
                    <span className="text-[9px] text-[#9CA3AF]">{entry.refreshCadence}</span>
                  </div>
                  {expandLineage === entry.sourceId ? <ChevronDown size={12} className="text-[#9CA3AF]" /> : <ChevronRight size={12} className="text-[#9CA3AF]" />}
                </button>
                {expandLineage === entry.sourceId && (
                  <div className="px-4 pb-4 border-t border-[#F3F4F6] grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3">
                    <div>
                      <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Upstream Systems</p>
                      {entry.upstreamSystems.map((s, i) => <p key={i} className="text-[10.5px] text-[#374151]">← {s}</p>)}
                    </div>
                    <div>
                      <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Downstream Consumers</p>
                      {entry.downstreamConsumers.map((s, i) => <p key={i} className="text-[10.5px] text-[#374151]">→ {s}</p>)}
                    </div>
                    <div>
                      <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Security & Compliance</p>
                      <p className="text-[10px] text-[#374151]">🔒 In transit: {entry.encryptedInTransit ? 'Encrypted' : 'Plaintext'}</p>
                      <p className="text-[10px] text-[#374151]">🗄 At rest: {entry.encryptedAtRest ? 'Encrypted' : 'Not encrypted'}</p>
                      <p className="text-[10px] text-[#374151]">📅 Retention: {entry.retentionDays} days</p>
                      <p className="text-[10px] text-[#374151]">🛡 GDPR: {entry.gdprRelevant ? 'Relevant' : 'Not applicable'}</p>
                    </div>
                    <div>
                      <p className="text-[9px] font-bold text-[#9CA3AF] uppercase tracking-wide mb-1">Ownership</p>
                      <p className="text-[10px] text-[#374151]">👤 Owner: {entry.dataOwner}</p>
                      <p className="text-[10px] text-[#374151]">🔄 Cadence: {entry.refreshCadence}</p>
                      <p className="text-[10px] text-[#374151]">📡 Protocol: {entry.protocol}</p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── CHECKLIST tab ── */}
        {activeTab === 'checklist' && report && (
          <div className="p-4">
            {['Infrastructure', 'Data Sources', 'AI/ML', 'Compliance', 'Security', 'Operations'].map(cat => {
              const items = report.checklist.filter(c => c.category === cat);
              return (
                <div key={cat} className="mb-4">
                  <p className="text-[10px] font-bold text-[#9CA3AF] uppercase tracking-widest mb-2">{cat}</p>
                  <div className="space-y-1">
                    {items.map(item => (
                      <div key={item.id} className={cn('flex items-start gap-3 p-2.5 rounded-[8px] border',
                        item.status === 'complete' ? 'border-green-100 bg-green-50' :
                        item.status === 'partial'  ? 'border-amber-100 bg-amber-50' :
                        item.status === 'pending'  ? 'border-[#E5E7EB] bg-white'   : 'border-[#F3F4F6] bg-[#F9FAFB]')}>
                        <div className="mt-0.5 shrink-0">
                          {item.status === 'complete' ? <CheckCircle2 size={13} className="text-green-600" /> :
                           item.status === 'partial'  ? <AlertTriangle size={13} className="text-amber-600" /> :
                           item.status === 'pending'  ? <AlertOctagon size={13} className="text-[#9CA3AF]" /> :
                           <Info size={13} className="text-[#D1D5DB]" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-semibold text-[#111827]">{item.title}</p>
                          <p className="text-[9.5px] text-[#6B7280]">{item.description}</p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={cn('text-[8px] font-bold px-1.5 py-0.5 rounded-full',
                            item.priority === 'critical' ? 'bg-red-50 text-red-700' :
                            item.priority === 'high'     ? 'bg-orange-50 text-orange-700' :
                            item.priority === 'medium'   ? 'bg-amber-50 text-amber-700' : 'bg-[#F3F4F6] text-[#6B7280]')}>
                            {item.priority}
                          </span>
                          <span className={cn('text-[8px] font-semibold px-1.5 py-0.5 rounded-full capitalize',
                            item.status === 'complete' ? 'bg-green-100 text-green-700' :
                            item.status === 'partial'  ? 'bg-amber-100 text-amber-700' :
                            item.status === 'pending'  ? 'bg-[#F3F4F6] text-[#9CA3AF]' : 'bg-[#F3F4F6] text-[#D1D5DB]')}>
                            {item.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
