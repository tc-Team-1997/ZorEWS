// web/src/modules/dataFabric/DataFabricCenterPage.tsx
//
// Enterprise Data Fabric Center — landing page.
//
// 14th IA addition this session. Additive overlay — every existing module
// untouched (Data Ingestion / Profiling / Validation / Standardization /
// Anomaly Detection / Reconciliation / Data Quality Score + every other
// IA center). Mounted at /data-fabric-center. Gated inside the page;
// sidebar entry visible to admin / supervisor / risk_analyst.
//
// Sections rendered:
//   1. Data Source Registry         — 36 sources × 28 source kinds (banking + insurance + common)
//   2. Integration Hub              — connections + throughput + latency + availability + recent executions
//   3. Pipeline Orchestration       — pipeline list + actions + recent runs
//   4. Data Quality Center          — 6-dimension scores + heatmap + failed records + trend
//   5. Metadata Catalog             — glossary + data dictionary
//   6. Data Lineage                 — node + edge graph table view (sources → transformations → models → dashboards → reports)
//   7. Data Governance              — policies (retention / access / classification / masking / anonymization)
//   8. Data Observability           — freshness / volume / schema / drift events + source health
//   9. AI Data Readiness            — training / inference / validation datasets
//  10. Executive Data Health        — overall health + 30-day trend + top incidents
//
// Production wire-up (BFF): replaces deterministic engine resolvers with the
// 11 routes documented in docs §9. Shape stays stable.

import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3, Boxes, Calendar,
  CheckCircle2, ChevronRight, Crown, Database, FileText, Filter, Gauge,
  GitBranch, Layers, Library, Lightbulb, ListChecks, LucideIcon,
  Network, Plug, Radio, ShieldAlert, ShieldCheck, Sparkles, Target,
  Timer, TrendingDown, TrendingUp, Workflow, XCircle, Zap,
} from 'lucide-react';
import {
  AreaChart, Area, Bar, BarChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge, MetricCard, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { useAuth } from '@/store/auth';
import {
  BANKING_SOURCE_KINDS,
  COMMON_SOURCE_KINDS,
  INSURANCE_SOURCE_KINDS,
  INTEGRATION_STATUSES,
  INTEGRATION_TYPES,
  OBSERVABILITY_EVENT_KINDS,
  PIPELINE_ACTIONS,
  PIPELINE_STATUSES,
  QUALITY_BANDS,
  QUALITY_DIMENSIONS,
  buildIntegrationHubSummary,
  canAccessDataFabricCenter,
  listDataSources,
  listIntegrationConnections,
  listIntegrationExecutions,
  type DataDomain,
  type IntegrationStatus,
  type IntegrationType,
  type ObservabilityEventKind,
  type ObservabilitySeverity,
  type PipelineStatus,
  type QualityBand,
} from './dataFabricEngine';
import {
  buildPipelineOrchestratorSummary,
  listPipelineRuns,
  listPipelines,
} from './pipelineOrchestrator';
import {
  buildDataQualityCenterSummary,
  buildQualityHeatmap,
  buildQualityTrend,
  listFailedRecords,
  listSourceQuality,
} from './dataQualityCenter';
import {
  buildDataGovernanceSummary,
  buildLineageGraph,
  buildMetadataCatalogSummary,
  listDataDictionary,
  listDataPolicies,
  listGlossaryTerms,
} from './dataCatalogLineage';
import {
  buildAIDataReadinessSummary,
  buildDataObservabilitySummary,
  buildExecutiveDataHealthDashboard,
  buildSourceHealth,
  listAIDatasetReadiness,
  listObservabilityEvents,
} from './dataObservabilityReadiness';

const ACTIVE_TENANT = 'BANK_DEMO';

const INTEGRATION_STATUS_TONE: Record<IntegrationStatus, 'success' | 'warning' | 'danger' | 'blue' | 'neutral'> = {
  active: 'success',
  paused: 'neutral',
  failed: 'danger',
  retrying: 'warning',
  degraded: 'warning',
};

const PIPELINE_STATUS_TONE: Record<PipelineStatus, 'success' | 'warning' | 'danger' | 'blue' | 'purple' | 'neutral'> = {
  idle: 'neutral',
  scheduled: 'blue',
  running: 'warning',
  paused: 'neutral',
  failed: 'danger',
  success: 'success',
};

const QUALITY_BAND_TONE: Record<QualityBand, 'success' | 'warning' | 'danger'> = {
  excellent: 'success',
  good: 'success',
  fair: 'warning',
  poor: 'danger',
  critical: 'danger',
};

const OBS_SEVERITY_TONE: Record<ObservabilitySeverity, 'success' | 'warning' | 'danger'> = {
  info: 'success',
  warning: 'warning',
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

function fmtPct(v: number): string {
  return `${Math.round(v)}%`;
}

function fmtPct01(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function fmtNumber(n: number): string {
  return n.toLocaleString('en-IN');
}

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

export function DataFabricCenterPage() {
  const user = useAuth((s) => s.user);
  if (user && !canAccessDataFabricCenter(user.roles)) {
    return <Navigate to="/" replace />;
  }

  const asOf = useMemo(() => new Date(), []);

  const [sourceDomain, setSourceDomain] = useState<DataDomain | 'all'>('all');
  const [sourceStatus, setSourceStatus] = useState<IntegrationStatus | 'all'>('all');
  const [sourceType, setSourceType] = useState<IntegrationType | 'all'>('all');
  const [obsKindFilter, setObsKindFilter] = useState<ObservabilityEventKind | 'all'>('all');

  const allSources = useMemo(() => listDataSources(ACTIVE_TENANT, asOf), [asOf]);
  const filteredSources = useMemo(
    () => allSources.filter((s) => {
      if (sourceDomain !== 'all' && s.domain !== sourceDomain) return false;
      if (sourceStatus !== 'all' && s.status !== sourceStatus) return false;
      if (sourceType !== 'all' && s.integration_type !== sourceType) return false;
      return true;
    }),
    [allSources, sourceDomain, sourceStatus, sourceType],
  );

  const hubSummary = useMemo(() => buildIntegrationHubSummary(ACTIVE_TENANT, asOf), [asOf]);
  const connections = useMemo(() => listIntegrationConnections(ACTIVE_TENANT, asOf), [asOf]);
  const recentExecutions = useMemo(() => listIntegrationExecutions(ACTIVE_TENANT, asOf, undefined, 12), [asOf]);

  const pipelines = useMemo(() => listPipelines(ACTIVE_TENANT, asOf), [asOf]);
  const pipelineRuns = useMemo(() => listPipelineRuns(ACTIVE_TENANT, asOf, undefined, 12), [asOf]);
  const pipelineSummary = useMemo(() => buildPipelineOrchestratorSummary(ACTIVE_TENANT, asOf), [asOf]);

  const sourceQuality = useMemo(() => listSourceQuality(ACTIVE_TENANT, asOf), [asOf]);
  const failedRecords = useMemo(() => listFailedRecords(ACTIVE_TENANT, asOf, undefined, 10), [asOf]);
  const qualitySummary = useMemo(() => buildDataQualityCenterSummary(ACTIVE_TENANT, asOf), [asOf]);
  const qualityTrend = useMemo(() => buildQualityTrend(ACTIVE_TENANT, asOf), [asOf]);
  const qualityHeatmap = useMemo(() => buildQualityHeatmap(ACTIVE_TENANT, asOf), [asOf]);

  const glossary = useMemo(() => listGlossaryTerms(ACTIVE_TENANT, asOf), [asOf]);
  const dictionary = useMemo(() => listDataDictionary(ACTIVE_TENANT, asOf, undefined, 12), [asOf]);
  const catalogSummary = useMemo(() => buildMetadataCatalogSummary(ACTIVE_TENANT, asOf), [asOf]);

  const lineage = useMemo(() => buildLineageGraph(ACTIVE_TENANT, asOf), [asOf]);

  const policies = useMemo(() => listDataPolicies(ACTIVE_TENANT, asOf), [asOf]);
  const governanceSummary = useMemo(() => buildDataGovernanceSummary(ACTIVE_TENANT, asOf), [asOf]);

  const obsEvents = useMemo(
    () => listObservabilityEvents(
      ACTIVE_TENANT,
      asOf,
      obsKindFilter === 'all' ? undefined : { kind: obsKindFilter },
      12,
    ),
    [asOf, obsKindFilter],
  );
  const sourceHealth = useMemo(() => buildSourceHealth(ACTIVE_TENANT, asOf), [asOf]);
  const obsSummary = useMemo(() => buildDataObservabilitySummary(ACTIVE_TENANT, asOf), [asOf]);

  const aiDatasets = useMemo(() => listAIDatasetReadiness(ACTIVE_TENANT, asOf), [asOf]);
  const aiSummary = useMemo(() => buildAIDataReadinessSummary(ACTIVE_TENANT, asOf), [asOf]);

  const execDash = useMemo(() => buildExecutiveDataHealthDashboard(ACTIVE_TENANT, asOf), [asOf]);

  // Source-kind chart data for the Source Registry overview
  const sourceKindBars = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const s of allSources) {
      byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
    }
    return Array.from(byKind.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([kind, count]) => ({ kind, count }));
  }, [allSources]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Enterprise Data Fabric Center"
        subtitle="Single control tower for data sources + integrations + pipelines + quality + lineage + governance + observability + AI readiness — banking + insurance."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="warning"><Network className="size-3 mr-1 inline" />Data Fabric</Badge>
            <Badge tone="neutral">Tenant: {ACTIVE_TENANT}</Badge>
            <Badge tone={execDash.overall_data_health_score >= 80 ? 'success' : execDash.overall_data_health_score >= 50 ? 'warning' : 'danger'}>
              Health: {fmtPct(execDash.overall_data_health_score)}
            </Badge>
          </div>
        }
      />

      {/* 1. Source Registry */}
      <Panel
        title={titleWithIcon('Data source registry', Database, `${filteredSources.length} of ${allSources.length} sources`)}
        action={
          <div className="flex gap-1.5 flex-wrap">
            {(['all', 'banking', 'insurance', 'common'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setSourceDomain(d)}
                data-testid={`source-domain-${d}`}
                className={`px-2.5 py-0.5 rounded text-xs font-medium transition border ${
                  d === sourceDomain ? 'bg-orange-500/15 text-orange-300 border-orange-500' : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        }
        data-testid="df-section-sources"
      >
        <div className="flex gap-1.5 flex-wrap mb-3 text-xs">
          <span className="text-slate-500 mr-1">Status:</span>
          {(['all', ...INTEGRATION_STATUSES] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSourceStatus(s)}
              data-testid={`source-status-${s}`}
              className={`px-2 py-0.5 rounded font-medium transition border ${
                s === sourceStatus ? 'bg-orange-500/15 text-orange-300 border-orange-500' : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
              }`}
            >
              {s}
            </button>
          ))}
          <span className="text-slate-500 ml-3 mr-1">Type:</span>
          {(['all', ...INTEGRATION_TYPES] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSourceType(t)}
              data-testid={`source-type-${t}`}
              className={`px-2 py-0.5 rounded font-medium transition border ${
                t === sourceType ? 'bg-orange-500/15 text-orange-300 border-orange-500' : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
              }`}
            >
              {t.replace('_', ' ')}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className="xl:col-span-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                <tr>
                  <th className="text-left py-2 px-3">ID</th>
                  <th className="text-left py-2 px-3">Name</th>
                  <th className="text-left py-2 px-3">Domain</th>
                  <th className="text-left py-2 px-3">Kind</th>
                  <th className="text-left py-2 px-3">Type</th>
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Owner</th>
                  <th className="text-left py-2 px-3">Refresh</th>
                </tr>
              </thead>
              <tbody>
                {filteredSources.slice(0, 14).map((s) => (
                  <tr key={s.source_id} data-testid={`source-row-${s.source_id}`} className="border-b border-slate-900/50">
                    <td className="py-1.5 px-3 font-mono text-xs text-slate-300">{s.source_id}</td>
                    <td className="py-1.5 px-3 text-slate-200">{s.name}</td>
                    <td className="py-1.5 px-3 text-slate-400 capitalize text-xs">{s.domain}</td>
                    <td className="py-1.5 px-3 text-slate-400 font-mono text-xs">{s.kind}</td>
                    <td className="py-1.5 px-3 text-slate-400 text-xs">{s.integration_type.replace('_', ' ')}</td>
                    <td className="py-1.5 px-3"><Badge tone={INTEGRATION_STATUS_TONE[s.status]}>{s.status}</Badge></td>
                    <td className="py-1.5 px-3 text-slate-300 font-mono text-xs">{s.owner}</td>
                    <td className="py-1.5 px-3 text-slate-400 text-xs">{s.refresh_frequency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-[10px] text-slate-500">
              Banking kinds ({BANKING_SOURCE_KINDS.length}) · Insurance ({INSURANCE_SOURCE_KINDS.length}) · Common ({COMMON_SOURCE_KINDS.length})
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Top source kinds</div>
            <div className="h-44 w-full">
              <ResponsiveContainer>
                <BarChart data={sourceKindBars} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="kind" stroke="rgba(255,255,255,0.45)" fontSize={9} angle={-30} height={50} textAnchor="end" />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={28} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Bar dataKey="count" fill="#F97316" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </Panel>

      {/* 2. Integration Hub */}
      <Panel
        title={titleWithIcon('Integration hub', Plug, `${hubSummary.active_integrations} active · ${hubSummary.failed_integrations} failed · ${hubSummary.retrying_count} retrying`)}
        data-testid="df-section-integration"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3 mb-3">
          <MetricCard label="Total connections" value={String(hubSummary.total_connections)} testId="kpi-connections" />
          <MetricCard label="Active" value={String(hubSummary.active_integrations)} tone="success" testId="kpi-active" />
          <MetricCard label="Failed" value={String(hubSummary.failed_integrations)} tone={hubSummary.failed_integrations > 0 ? 'danger' : 'success'} testId="kpi-failed" />
          <MetricCard label="Retry queue" value={String(hubSummary.retry_queue_depth)} tone={hubSummary.retry_queue_depth > 0 ? 'warning' : 'success'} testId="kpi-retry" />
          <MetricCard label="Throughput/min" value={fmtNumber(Math.round(hubSummary.total_throughput_per_min))} testId="kpi-throughput" />
          <MetricCard label="Avg latency" value={`${Math.round(hubSummary.avg_latency_ms)}ms`} tone={hubSummary.avg_latency_ms > 300 ? 'warning' : 'success'} testId="kpi-latency" />
          <MetricCard label="Success rate" value={fmtPct01(hubSummary.success_rate)} tone={hubSummary.success_rate >= 0.95 ? 'success' : 'warning'} testId="kpi-success-rate" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3">Execution</th>
                <th className="text-left py-2 px-3">Connection</th>
                <th className="text-left py-2 px-3">Status</th>
                <th className="text-left py-2 px-3">Started</th>
                <th className="text-right py-2 px-3">Duration</th>
                <th className="text-right py-2 px-3">Records</th>
                <th className="text-right py-2 px-3">Failed</th>
              </tr>
            </thead>
            <tbody>
              {recentExecutions.map((e) => (
                <tr key={e.execution_id} data-testid={`exec-row-${e.execution_id}`} className="border-b border-slate-900/50">
                  <td className="py-1.5 px-3 font-mono text-xs text-slate-300">{e.execution_id}</td>
                  <td className="py-1.5 px-3 font-mono text-xs text-slate-400">{e.connection_id}</td>
                  <td className="py-1.5 px-3"><Badge tone={e.status === 'success' ? 'success' : e.status === 'failure' ? 'danger' : e.status === 'partial' ? 'warning' : 'blue'}>{e.status}</Badge></td>
                  <td className="py-1.5 px-3 text-slate-400 text-xs">{e.started_at.slice(0, 19).replace('T', ' ')}</td>
                  <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">{Math.round(e.duration_ms / 1000)}s</td>
                  <td className="py-1.5 px-3 text-right text-slate-300 tabular-nums">{fmtNumber(e.records_processed)}</td>
                  <td className="py-1.5 px-3 text-right text-orange-300 tabular-nums">{fmtNumber(e.records_failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-xs text-slate-500 font-mono">
          Connections live: {connections.length} · Availability: {fmtPct(hubSummary.availability_pct)}
        </div>
      </Panel>

      {/* 3. Pipeline Orchestration */}
      <Panel
        title={titleWithIcon('Pipeline orchestration', Workflow, `${pipelineSummary.total_pipelines} pipelines · ${pipelineSummary.scheduled_count} scheduled · ${pipelineSummary.running_count} running`)}
        data-testid="df-section-pipelines"
      >
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3 text-xs">
          {PIPELINE_STATUSES.map((s) => {
            const count = pipelineSummary.by_status[s] ?? 0;
            return (
              <div key={s} data-testid={`pipeline-bucket-${s}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
                <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{s}</div>
                <div className="text-xl font-bold text-white tabular-nums">{count}</div>
              </div>
            );
          })}
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900/30 p-3 mb-3" data-testid="pipeline-actions">
          <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Pipeline actions</div>
          <div className="flex flex-wrap gap-1.5">
            {PIPELINE_ACTIONS.map((a) => (
              <button
                key={a}
                type="button"
                data-testid={`pipeline-action-${a}`}
                className="px-2.5 py-1 rounded bg-slate-900/40 text-slate-300 hover:bg-orange-500/15 hover:text-orange-300 border border-slate-700 hover:border-orange-500 text-xs font-medium transition flex items-center gap-1"
              >
                {a} <ChevronRight className="size-3" />
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Pipelines (top 10)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Name</th>
                    <th className="text-left py-1.5 px-2">Status</th>
                    <th className="text-left py-1.5 px-2">Domain</th>
                    <th className="text-right py-1.5 px-2">Success 30d</th>
                  </tr>
                </thead>
                <tbody>
                  {pipelines.slice(0, 10).map((p) => (
                    <tr key={p.pipeline_id} data-testid={`pipeline-row-${p.pipeline_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 text-slate-200 text-xs">{p.name}</td>
                      <td className="py-1 px-2"><Badge tone={PIPELINE_STATUS_TONE[p.status]}>{p.status}</Badge></td>
                      <td className="py-1 px-2 text-slate-400 capitalize text-xs">{p.domain}</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{fmtPct01(p.success_rate_30d)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Recent runs</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Run</th>
                    <th className="text-left py-1.5 px-2">Status</th>
                    <th className="text-right py-1.5 px-2">Duration</th>
                    <th className="text-right py-1.5 px-2">Records out</th>
                    <th className="text-left py-1.5 px-2">SLA</th>
                  </tr>
                </thead>
                <tbody>
                  {pipelineRuns.map((r) => (
                    <tr key={r.run_id} data-testid={`pipeline-run-${r.run_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 font-mono text-[11px] text-slate-300">{r.run_id}</td>
                      <td className="py-1 px-2"><Badge tone={r.status === 'success' ? 'success' : r.status === 'failure' ? 'danger' : 'warning'}>{r.status}</Badge></td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{Math.round(r.duration_ms / 1000)}s</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{fmtNumber(r.records_out)}</td>
                      <td className="py-1 px-2"><Badge tone={r.sla_met ? 'success' : 'danger'}>{r.sla_met ? 'met' : 'breached'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Panel>

      {/* 4. Data Quality Center */}
      <Panel
        title={titleWithIcon('Data quality center', Target, `overall ${fmtPct(qualitySummary.overall_data_quality_score)} · SLA ${fmtPct01(qualitySummary.sla_compliance_rate)} · ${fmtNumber(qualitySummary.total_failed_records_24h)} failed records 24h`)}
        data-testid="df-section-quality"
      >
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-2 mb-3 text-xs">
          {QUALITY_DIMENSIONS.map((dim) => {
            const stats = qualitySummary.by_dimension[dim];
            const mean = stats?.mean_score ?? 0;
            return (
              <div key={dim} data-testid={`quality-dim-${dim}`} className="rounded border border-slate-700 bg-slate-900/30 p-2">
                <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{dim}</div>
                <div className={`text-lg font-bold tabular-nums ${mean >= 75 ? 'text-emerald-300' : mean >= 60 ? 'text-orange-300' : 'text-red-400'}`}>{fmtPct(mean)}</div>
                <div className="text-[9px] text-slate-500">SLA: {stats?.sla_met_count ?? 0}/{stats?.sla_total_count ?? 0}</div>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className="xl:col-span-2 rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Quality trend (30 days)</div>
            <div className="h-40 w-full">
              <ResponsiveContainer>
                <AreaChart data={qualityTrend} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="day_offset" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={28} domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Area type="monotone" dataKey="overall_score" stroke="#10B981" fill="rgba(16,185,129,0.2)" name="Score" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Worst sources (bottom 5)</div>
            <ul className="text-xs space-y-1.5">
              {qualitySummary.worst_sources.map((w) => (
                <li key={w.source_id} data-testid={`worst-source-${w.source_id}`} className="flex justify-between items-center border-b border-slate-900/50 py-1">
                  <span className="text-slate-200 truncate">{w.source_name}</span>
                  <span className="text-red-400 font-bold tabular-nums">{fmtPct(w.overall_score)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Per-source quality (top 10 — worst first)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Source</th>
                    <th className="text-left py-1.5 px-2">Domain</th>
                    <th className="text-right py-1.5 px-2">Score</th>
                    <th className="text-left py-1.5 px-2">Band</th>
                    <th className="text-right py-1.5 px-2">Failed 24h</th>
                    <th className="text-left py-1.5 px-2">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceQuality.slice(0, 10).map((q) => (
                    <tr key={q.source_id} data-testid={`quality-row-${q.source_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 text-slate-200 text-xs">{q.source_name}</td>
                      <td className="py-1 px-2 text-slate-400 capitalize text-xs">{q.domain}</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums">{fmtPct(q.overall_score)}</td>
                      <td className="py-1 px-2"><Badge tone={QUALITY_BAND_TONE[q.overall_band]}>{q.overall_band}</Badge></td>
                      <td className="py-1 px-2 text-right text-orange-300 tabular-nums text-xs">{fmtNumber(q.failed_records_24h)}</td>
                      <td className="py-1 px-2 text-slate-400 text-xs">{q.trend_7d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Recent failed records (10)</div>
            <ul className="text-xs space-y-1">
              {failedRecords.map((f) => (
                <li key={f.record_id} data-testid={`failed-record-${f.record_id}`} className="border-b border-slate-900/50 py-1">
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-mono text-[11px] text-slate-300">{f.record_id}</span>
                    <Badge tone={f.severity === 'high' ? 'danger' : f.severity === 'moderate' ? 'warning' : 'success'}>{f.severity}</Badge>
                  </div>
                  <div className="text-slate-500 text-[10px]">{f.field_name} · {f.error_kind} · "{f.value_observed}"</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-500">
          Heatmap cells: <span className="font-mono text-slate-300">{qualityHeatmap.length}</span> · By band:{' '}
          {QUALITY_BANDS.map((b) => (
            <span key={b} className="ml-2 font-mono"><Badge tone={QUALITY_BAND_TONE[b]}>{b}</Badge> {qualitySummary.by_band[b] ?? 0}</span>
          ))}
        </div>
      </Panel>

      {/* 5. Metadata Catalog */}
      <Panel
        title={titleWithIcon('Metadata catalog', Library, `${catalogSummary.total_glossary_terms} terms · ${catalogSummary.total_dictionary_entries} fields · ${catalogSummary.sensitive_data_count} PII · ${catalogSummary.regulatory_data_count} regulatory`)}
        data-testid="df-section-catalog"
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Business glossary (top 10)</div>
            <ul className="text-xs space-y-1.5">
              {glossary.slice(0, 10).map((g) => (
                <li key={g.term_id} data-testid={`glossary-row-${g.term_id}`} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-slate-200 font-medium">{g.term}</span>
                    <span className="text-slate-500 capitalize text-[10px]">{g.domain}</span>
                  </div>
                  <div className="text-slate-500 text-[11px]">{g.definition}</div>
                  <div className="text-slate-500 font-mono text-[10px]">Owner: {g.owner} · Steward: {g.steward}</div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Data dictionary (12 sample)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Field</th>
                    <th className="text-left py-1.5 px-2">Type</th>
                    <th className="text-left py-1.5 px-2">Class</th>
                    <th className="text-left py-1.5 px-2">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {dictionary.slice(0, 12).map((d) => (
                    <tr key={d.entry_id} data-testid={`dictionary-row-${d.entry_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 font-mono text-xs text-slate-200">{d.field_name}</td>
                      <td className="py-1 px-2 text-slate-400 text-xs">{d.data_type}</td>
                      <td className="py-1 px-2 text-slate-400 text-xs">{d.classification}</td>
                      <td className="py-1 px-2 text-xs">
                        {d.is_pii && <Badge tone="danger">PII</Badge>}
                        {d.is_regulatory && <Badge tone="warning">REG</Badge>}
                        {d.is_critical_data_element && <Badge tone="blue">CDE</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-500 font-mono">
          Owners: {catalogSummary.total_owners} · Stewards: {catalogSummary.total_stewards} · Sources documented: {catalogSummary.total_sources_documented} · CDE: {catalogSummary.critical_data_element_count}
        </div>
      </Panel>

      {/* 6. Data Lineage */}
      <Panel
        title={titleWithIcon('Data lineage', GitBranch, `${lineage.nodes.length} nodes · ${lineage.edges.length} edges (Source → Transformation → DQ → Risk → AI → Dashboard → Report)`)}
        data-testid="df-section-lineage"
      >
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Nodes by kind</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              {(['source', 'transformation', 'data_quality', 'risk_engine', 'ai_model', 'dashboard', 'report'] as const).map((kind) => {
                const count = lineage.nodes.filter((n) => n.kind === kind).length;
                return (
                  <div key={kind} data-testid={`lineage-kind-${kind}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
                    <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{kind.replace('_', ' ')}</div>
                    <div className="text-lg font-bold text-white tabular-nums">{count}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Edges (sample)</div>
            <div className="overflow-x-auto max-h-40 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-500 border-b border-slate-800">
                  <tr><th className="text-left py-1 px-2">From</th><th className="text-left py-1 px-2">→</th><th className="text-left py-1 px-2">To</th><th className="text-left py-1 px-2">Kind</th></tr>
                </thead>
                <tbody>
                  {lineage.edges.slice(0, 14).map((e, idx) => (
                    <tr key={idx} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 font-mono text-slate-300 text-[11px]">{e.from}</td>
                      <td className="py-1 px-2 text-slate-500">→</td>
                      <td className="py-1 px-2 font-mono text-slate-300 text-[11px]">{e.to}</td>
                      <td className="py-1 px-2"><Badge tone={e.kind === 'realtime' ? 'success' : e.kind === 'batch' ? 'blue' : 'neutral'}>{e.kind}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Panel>

      {/* 7. Data Governance */}
      <Panel
        title={titleWithIcon('Data governance', ShieldCheck, `${governanceSummary.total_policies} policies · ${governanceSummary.active_policies} active · compliance ${fmtPct(governanceSummary.compliance_score)}`)}
        data-testid="df-section-governance"
      >
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3 text-xs">
          {(['retention', 'access', 'classification', 'masking', 'anonymization'] as const).map((k) => (
            <div key={k} data-testid={`governance-kind-${k}`} className="rounded border border-slate-700 bg-slate-900/30 p-2 text-center">
              <div className="text-slate-500 uppercase tracking-wider font-mono text-[10px]">{k}</div>
              <div className="text-lg font-bold text-white tabular-nums">{governanceSummary.by_kind[k] ?? 0}</div>
            </div>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-1.5 px-2">ID</th>
                <th className="text-left py-1.5 px-2">Name</th>
                <th className="text-left py-1.5 px-2">Kind</th>
                <th className="text-left py-1.5 px-2">Applies to</th>
                <th className="text-right py-1.5 px-2">Retention</th>
                <th className="text-left py-1.5 px-2">Status</th>
                <th className="text-left py-1.5 px-2">Approver</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.policy_id} data-testid={`policy-row-${p.policy_id}`} className="border-b border-slate-900/50">
                  <td className="py-1 px-2 font-mono text-[11px] text-slate-300">{p.policy_id}</td>
                  <td className="py-1 px-2 text-slate-200 text-xs">{p.name}</td>
                  <td className="py-1 px-2 text-slate-400 capitalize text-xs">{p.policy_kind}</td>
                  <td className="py-1 px-2 text-slate-400 text-[11px] font-mono">{p.applies_to_classification.slice(0, 3).join(', ')}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{p.retention_days ?? '—'}d</td>
                  <td className="py-1 px-2"><Badge tone={p.status === 'active' ? 'success' : p.status === 'draft' ? 'warning' : 'neutral'}>{p.status}</Badge></td>
                  <td className="py-1 px-2 text-slate-300 font-mono text-xs">{p.approver}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 8. Data Observability */}
      <Panel
        title={titleWithIcon('Data observability', Activity, `${obsSummary.open_events} open · ${obsSummary.critical_events} critical · ${obsSummary.healthy_sources} healthy / ${obsSummary.degraded_sources} degraded / ${obsSummary.incident_sources} incidents`)}
        action={
          <div className="flex gap-1.5 flex-wrap">
            <span className="text-xs text-slate-500 self-center mr-1">Kind:</span>
            {(['all', ...OBSERVABILITY_EVENT_KINDS] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setObsKindFilter(k)}
                data-testid={`obs-filter-${k}`}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition border ${
                  k === obsKindFilter ? 'bg-orange-500/15 text-orange-300 border-orange-500' : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:border-orange-500/60'
                }`}
              >
                {k.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
        }
        data-testid="df-section-observability"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Events 24h" value={String(obsSummary.total_events_24h)} testId="obs-kpi-24h" />
          <MetricCard label="Critical" value={String(obsSummary.critical_events)} tone={obsSummary.critical_events > 0 ? 'danger' : 'success'} testId="obs-kpi-critical" />
          <MetricCard label="Avg freshness lag" value={`${Math.round(obsSummary.avg_freshness_lag_minutes)}min`} tone={obsSummary.avg_freshness_lag_minutes > 60 ? 'warning' : 'success'} testId="obs-kpi-freshness" />
          <MetricCard label="Schema changes 7d" value={String(obsSummary.schema_changes_7d_total)} testId="obs-kpi-schema" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Recent events ({obsEvents.length})</div>
            <ul className="text-xs space-y-1.5">
              {obsEvents.map((e) => (
                <li key={e.event_id} data-testid={`obs-event-${e.event_id}`} className="border-b border-slate-900/50 py-1.5">
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-slate-200 font-medium">{e.title}</span>
                    <Badge tone={OBS_SEVERITY_TONE[e.severity]}>{e.severity}</Badge>
                  </div>
                  <div className="text-slate-500 text-[11px]">{e.description}</div>
                  <div className="text-slate-500 font-mono text-[10px]">{e.kind.replace(/_/g, ' ')} · source: {e.source_id}</div>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Source health (top 10 worst)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
                  <tr>
                    <th className="text-left py-1.5 px-2">Source</th>
                    <th className="text-right py-1.5 px-2">Lag</th>
                    <th className="text-right py-1.5 px-2">Drift</th>
                    <th className="text-left py-1.5 px-2">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceHealth.slice(0, 10).map((h) => (
                    <tr key={h.source_id} data-testid={`source-health-${h.source_id}`} className="border-b border-slate-900/50">
                      <td className="py-1 px-2 text-slate-200 text-xs">{h.source_name}</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{Math.round(h.freshness_lag_minutes)}m</td>
                      <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{(h.drift_score * 100).toFixed(0)}%</td>
                      <td className="py-1 px-2"><Badge tone={h.overall_health === 'healthy' ? 'success' : h.overall_health === 'degraded' ? 'warning' : 'danger'}>{h.overall_health}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Panel>

      {/* 9. AI Data Readiness */}
      <Panel
        title={titleWithIcon('AI data readiness', Lightbulb, `${aiSummary.total_datasets} datasets · ${aiSummary.ready_count} ready · ${aiSummary.degraded_count} degraded · ${aiSummary.unavailable_count} unavailable`)}
        data-testid="df-section-ai-readiness"
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MetricCard label="Avg availability" value={fmtPct(aiSummary.avg_feature_availability_pct)} tone={aiSummary.avg_feature_availability_pct >= 80 ? 'success' : 'warning'} testId="ai-kpi-availability" />
          <MetricCard label="Avg freshness" value={fmtPct(aiSummary.avg_feature_freshness_pct)} tone={aiSummary.avg_feature_freshness_pct >= 80 ? 'success' : 'warning'} testId="ai-kpi-freshness" />
          <MetricCard label="Avg quality" value={fmtPct(aiSummary.avg_quality_score)} tone={aiSummary.avg_quality_score >= 80 ? 'success' : 'warning'} testId="ai-kpi-quality" />
          <MetricCard label="Validation pass" value={fmtPct01(aiSummary.avg_validation_pass_rate)} tone={aiSummary.avg_validation_pass_rate >= 0.95 ? 'success' : 'warning'} testId="ai-kpi-validation" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
              <tr>
                <th className="text-left py-1.5 px-2">Dataset</th>
                <th className="text-left py-1.5 px-2">Purpose</th>
                <th className="text-left py-1.5 px-2">Model</th>
                <th className="text-right py-1.5 px-2">Avail</th>
                <th className="text-right py-1.5 px-2">Fresh</th>
                <th className="text-right py-1.5 px-2">Quality</th>
                <th className="text-right py-1.5 px-2">Val pass</th>
                <th className="text-left py-1.5 px-2">State</th>
              </tr>
            </thead>
            <tbody>
              {aiDatasets.map((d) => (
                <tr key={d.dataset_id} data-testid={`ai-dataset-${d.dataset_id}`} className="border-b border-slate-900/50">
                  <td className="py-1 px-2 text-slate-200 text-xs">{d.dataset_name}</td>
                  <td className="py-1 px-2 text-slate-400 capitalize text-xs">{d.purpose}</td>
                  <td className="py-1 px-2 text-slate-400 font-mono text-[11px]">{d.model_label}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{fmtPct(d.feature_availability_pct)}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{fmtPct(d.feature_freshness_pct)}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{fmtPct(d.quality_score)}</td>
                  <td className="py-1 px-2 text-right text-slate-300 tabular-nums text-xs">{fmtPct01(d.input_validation_pass_rate)}</td>
                  <td className="py-1 px-2"><Badge tone={d.readiness_state === 'ready' ? 'success' : d.readiness_state === 'degraded' ? 'warning' : 'danger'}>{d.readiness_state}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* 10. Executive Data Health */}
      <Panel
        title={titleWithIcon('Executive data health', Crown, `overall ${fmtPct(execDash.overall_data_health_score)} · integration ${fmtPct01(execDash.integration_success_rate)} · pipeline ${fmtPct(execDash.pipeline_availability_pct)} · quality ${fmtPct(execDash.data_quality_score)}`)}
        data-testid="df-section-exec"
      >
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-3">
          <MetricCard label="Health" value={fmtPct(execDash.overall_data_health_score)} tone={execDash.overall_data_health_score >= 80 ? 'success' : 'warning'} testId="exec-kpi-health" />
          <MetricCard label="Integration" value={fmtPct01(execDash.integration_success_rate)} testId="exec-kpi-integration" />
          <MetricCard label="Pipeline" value={fmtPct(execDash.pipeline_availability_pct)} testId="exec-kpi-pipeline" />
          <MetricCard label="Quality" value={fmtPct(execDash.data_quality_score)} testId="exec-kpi-quality" />
          <MetricCard label="Freshness" value={fmtPct(execDash.freshness_score)} testId="exec-kpi-freshness" />
          <MetricCard label="Governance" value={fmtPct(execDash.governance_compliance_score)} testId="exec-kpi-governance" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <div className="xl:col-span-2 rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Data health trend (30 days)</div>
            <div className="h-44 w-full">
              <ResponsiveContainer>
                <AreaChart data={execDash.trend_30d} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="day_offset" stroke="rgba(255,255,255,0.45)" fontSize={10} />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={11} width={28} domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.95)', border: '1px solid rgba(249,115,22,0.5)', color: '#fff', borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="health_score" stroke="#10B981" fill="rgba(16,185,129,0.2)" name="Health" />
                  <Area type="monotone" dataKey="quality_score" stroke="#F97316" fill="rgba(249,115,22,0.15)" name="Quality" />
                  <Area type="monotone" dataKey="freshness_score" stroke="#3B82F6" fill="rgba(59,130,246,0.15)" name="Freshness" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/30 p-3">
            <div className="text-xs uppercase tracking-wider text-slate-400 font-mono mb-2">Top incidents</div>
            <ul className="text-xs space-y-1.5">
              {execDash.top_incidents.map((i) => (
                <li key={i.event_id} data-testid={`exec-incident-${i.event_id}`} className="border-b border-slate-900/50 py-1">
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-[11px] text-slate-300">{i.event_id}</span>
                    <Badge tone={OBS_SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                  </div>
                  <div className="text-slate-500 text-[10px]">{i.kind.replace(/_/g, ' ')} · {i.source_id}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-500 font-mono">
          AI readiness: <Badge tone={execDash.ai_readiness_score >= 80 ? 'success' : 'warning'}>{fmtPct(execDash.ai_readiness_score)}</Badge>
        </div>
      </Panel>

      {/* Cross-IA footer */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400 pt-1">
        <span>Cross-IA:</span>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/admin/governance">Governance</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/audit-center">Audit Center</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/regulatory-compliance-center">Regulatory</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/investigation-center">Investigations</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/predictive-risk-center">Predictive Risk</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/executive-cockpit">Executive Cockpit</Link>
        <Link className="hover:text-orange-300 underline decoration-dotted" to="/dashboards/role-based">Role Dashboard</Link>
      </div>
    </div>
  );
}

// silence unused-import warnings for icons reserved for future expansion
void AlertTriangle; void ArrowRight; void BarChart3; void Boxes; void Calendar;
void CheckCircle2; void FileText; void Filter; void Gauge; void Layers;
void ListChecks; void Radio; void ShieldAlert; void Sparkles; void Timer;
void TrendingDown; void TrendingUp; void XCircle; void Zap;
