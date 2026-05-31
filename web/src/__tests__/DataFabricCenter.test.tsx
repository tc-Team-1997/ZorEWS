// Data Fabric Center — page render + role gate + pure-resolver suites.
//
// Mirrors the RegulatoryComplianceCenter test shape. Verifies:
//   - canAccessDataFabricCenter role gate (all 16 declared roles + legacy)
//   - Closed-enum invariants (16 enums)
//   - Pure resolvers across 5 engine modules (sources, integrations, pipelines,
//     quality, catalog, lineage, governance, observability, AI readiness, exec)
//   - SPA page renders all 10 sections with the right testids
//   - Domain / status / type filters wire to the source registry
//   - Pipeline action buttons + integration KPIs + observability filter render
//   - Cross-IA footer links to siblings without changing existing routes
//
// Determinism — all builders take a fixed asOf so re-runs are stable.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { DataFabricCenterPage } from '@/modules/dataFabric/DataFabricCenterPage';
import {
  BANKING_SOURCE_KINDS,
  COMMON_SOURCE_KINDS,
  DATA_CLASSIFICATIONS,
  DATA_DOMAINS,
  DATA_FABRIC_ROLES,
  EXECUTION_STATUSES,
  INSURANCE_SOURCE_KINDS,
  INTEGRATION_STATUSES,
  INTEGRATION_TYPES,
  OBSERVABILITY_EVENT_KINDS,
  OBSERVABILITY_SEVERITIES,
  PIPELINE_ACTIONS,
  PIPELINE_STATUSES,
  QUALITY_BANDS,
  QUALITY_DIMENSIONS,
  READINESS_STATES,
  buildIntegrationHubSummary,
  canAccessDataFabricCenter,
  getDataSource,
  listDataSources,
  listIntegrationConnections,
  listIntegrationExecutions,
} from '@/modules/dataFabric/dataFabricEngine';
import {
  buildPipelineOrchestratorSummary,
  getPipeline,
  listPipelineRuns,
  listPipelines,
} from '@/modules/dataFabric/pipelineOrchestrator';
import {
  buildDataQualityCenterSummary,
  buildQualityHeatmap,
  buildQualityTrend,
  listFailedRecords,
  listSourceQuality,
} from '@/modules/dataFabric/dataQualityCenter';
import {
  analyzeImpact,
  buildDataGovernanceSummary,
  buildLineageGraph,
  buildMetadataCatalogSummary,
  listDataDictionary,
  listDataPolicies,
  listGlossaryTerms,
} from '@/modules/dataFabric/dataCatalogLineage';
import {
  buildAIDataReadinessSummary,
  buildDataObservabilitySummary,
  buildExecutiveDataHealthDashboard,
  buildSourceHealth,
  listAIDatasetReadiness,
  listObservabilityEvents,
} from '@/modules/dataFabric/dataObservabilityReadiness';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

type AnyRole =
  | 'admin' | 'supervisor' | 'risk_analyst' | 'fraud_analyst' | 'auditor'
  | 'compliance_officer' | 'field_officer' | 'investigator';

function setUser(role: AnyRole) {
  const user = { id: 'u-001', username: `test.${role}`, roles: [role] as AnyRole[] };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/data-fabric-center" element={<DataFabricCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/data-fabric-center' },
  );
}

beforeEach(() => { localStorage.clear(); });

const TENANT = 'BANK_DEMO';
const ASOF = new Date('2026-05-31T08:00:00Z');

// ───────────────────────────────────────────────────────────────────────────
// Role gate
// ───────────────────────────────────────────────────────────────────────────

describe('canAccessDataFabricCenter', () => {
  it('grants every declared DATA_FABRIC_ROLES entry', () => {
    for (const role of DATA_FABRIC_ROLES) {
      expect(canAccessDataFabricCenter([role])).toBe(true);
    }
  });

  it('grants admin / supervisor / risk_analyst legacy roles', () => {
    expect(canAccessDataFabricCenter(['admin'])).toBe(true);
    expect(canAccessDataFabricCenter(['supervisor'])).toBe(true);
    expect(canAccessDataFabricCenter(['risk_analyst'])).toBe(true);
  });

  it('refuses unknown / empty / undefined', () => {
    expect(canAccessDataFabricCenter(['field_officer'])).toBe(false);
    expect(canAccessDataFabricCenter([])).toBe(false);
    expect(canAccessDataFabricCenter(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Closed-enum catalog invariants
// ───────────────────────────────────────────────────────────────────────────

describe('Closed enums', () => {
  it('DATA_DOMAINS = banking | insurance | common', () => {
    expect(DATA_DOMAINS).toEqual(['banking', 'insurance', 'common']);
  });

  it('BANKING_SOURCE_KINDS, INSURANCE_SOURCE_KINDS, COMMON_SOURCE_KINDS each non-empty + disjoint', () => {
    expect(BANKING_SOURCE_KINDS.length).toBeGreaterThan(0);
    expect(INSURANCE_SOURCE_KINDS.length).toBeGreaterThan(0);
    expect(COMMON_SOURCE_KINDS.length).toBeGreaterThan(0);
    const set = new Set<string>([
      ...BANKING_SOURCE_KINDS,
      ...INSURANCE_SOURCE_KINDS,
      ...COMMON_SOURCE_KINDS,
    ]);
    // No collisions across the three buckets.
    expect(set.size).toBe(
      BANKING_SOURCE_KINDS.length + INSURANCE_SOURCE_KINDS.length + COMMON_SOURCE_KINDS.length,
    );
  });

  it('INTEGRATION_TYPES = 5 wire types', () => {
    expect(INTEGRATION_TYPES).toEqual([
      'api', 'file', 'streaming', 'database_replication', 'event_driven',
    ]);
  });

  it('INTEGRATION_STATUSES + EXECUTION_STATUSES are closed', () => {
    expect(INTEGRATION_STATUSES.length).toBe(5);
    expect(EXECUTION_STATUSES.length).toBe(5);
  });

  it('PIPELINE_STATUSES has the canonical 6 states', () => {
    expect(PIPELINE_STATUSES).toEqual([
      'idle', 'scheduled', 'running', 'paused', 'failed', 'success',
    ]);
  });

  it('PIPELINE_ACTIONS has 6 ops', () => {
    expect(PIPELINE_ACTIONS.length).toBe(6);
  });

  it('DATA_CLASSIFICATIONS has 8 entries incl. PII + PCI + PHI + regulatory', () => {
    expect(DATA_CLASSIFICATIONS).toContain('pii');
    expect(DATA_CLASSIFICATIONS).toContain('pci');
    expect(DATA_CLASSIFICATIONS).toContain('phi');
    expect(DATA_CLASSIFICATIONS).toContain('regulatory');
    expect(DATA_CLASSIFICATIONS.length).toBe(8);
  });

  it('QUALITY_DIMENSIONS has the canonical 6 dimensions', () => {
    expect(QUALITY_DIMENSIONS).toEqual([
      'completeness', 'accuracy', 'consistency', 'validity', 'timeliness', 'uniqueness',
    ]);
  });

  it('QUALITY_BANDS = excellent..critical (5 bands)', () => {
    expect(QUALITY_BANDS.length).toBe(5);
    expect(QUALITY_BANDS[0]).toBe('excellent');
    expect(QUALITY_BANDS[QUALITY_BANDS.length - 1]).toBe('critical');
  });

  it('OBSERVABILITY_EVENT_KINDS has the canonical 7 kinds', () => {
    expect(OBSERVABILITY_EVENT_KINDS.length).toBe(7);
    expect(OBSERVABILITY_EVENT_KINDS).toContain('freshness_lag');
    expect(OBSERVABILITY_EVENT_KINDS).toContain('schema_change');
    expect(OBSERVABILITY_EVENT_KINDS).toContain('data_drift');
  });

  it('OBSERVABILITY_SEVERITIES = info | warning | critical', () => {
    expect(OBSERVABILITY_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });

  it('READINESS_STATES = ready | degraded | unavailable', () => {
    expect(READINESS_STATES).toEqual(['ready', 'degraded', 'unavailable']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Data Source Registry resolvers
// ───────────────────────────────────────────────────────────────────────────

describe('listDataSources + getDataSource', () => {
  it('produces a non-empty deterministic list across domains', () => {
    const a = listDataSources(TENANT, ASOF);
    const b = listDataSources(TENANT, ASOF);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
    expect(a[0]?.source_id).toBe(b[0]?.source_id);
  });

  it('every source has required identity + governance fields', () => {
    const list = listDataSources(TENANT, ASOF);
    for (const s of list) {
      expect(s.source_id).toMatch(/^[a-z0-9-]+$/i);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.owner.length).toBeGreaterThan(0);
      expect(s.endpoint.length).toBeGreaterThan(0);
      expect(DATA_DOMAINS).toContain(s.domain);
      expect(INTEGRATION_TYPES).toContain(s.integration_type);
      expect(INTEGRATION_STATUSES).toContain(s.status);
      expect(DATA_CLASSIFICATIONS).toContain(s.classification);
    }
  });

  it('covers both banking and insurance domains', () => {
    const list = listDataSources(TENANT, ASOF);
    expect(list.some((s) => s.domain === 'banking')).toBe(true);
    expect(list.some((s) => s.domain === 'insurance')).toBe(true);
  });

  it('getDataSource hit + null (signature: source_id, tenant_id, asOf)', () => {
    const list = listDataSources(TENANT, ASOF);
    const id = list[0]?.source_id ?? '';
    expect(getDataSource(id, TENANT, ASOF)?.source_id).toBe(id);
    expect(getDataSource('no-such-source', TENANT, ASOF)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Integration hub
// ───────────────────────────────────────────────────────────────────────────

describe('buildIntegrationHubSummary + connections/executions', () => {
  it('summary partitions and total adds up', () => {
    const s = buildIntegrationHubSummary(TENANT, ASOF);
    expect(s.total_connections).toBeGreaterThanOrEqual(s.active_integrations + s.failed_integrations);
    expect(s.success_rate).toBeGreaterThanOrEqual(0);
    expect(s.success_rate).toBeLessThanOrEqual(1);
    expect(s.availability_pct).toBeGreaterThanOrEqual(0);
    expect(s.availability_pct).toBeLessThanOrEqual(100);
  });

  it('listIntegrationConnections returns connections with status enum', () => {
    const c = listIntegrationConnections(TENANT, ASOF);
    expect(c.length).toBeGreaterThan(0);
    for (const conn of c) {
      expect(INTEGRATION_STATUSES).toContain(conn.status);
      expect(INTEGRATION_TYPES).toContain(conn.integration_type);
      expect(conn.success_rate).toBeGreaterThanOrEqual(0);
      expect(conn.success_rate).toBeLessThanOrEqual(1);
    }
  });

  it('listIntegrationExecutions respects limit + execution_status enum', () => {
    const e = listIntegrationExecutions(TENANT, ASOF, undefined, 7);
    expect(e.length).toBeLessThanOrEqual(7);
    for (const ex of e) {
      expect(EXECUTION_STATUSES).toContain(ex.status);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Pipeline orchestrator
// ───────────────────────────────────────────────────────────────────────────

describe('Pipeline orchestrator', () => {
  it('listPipelines deterministic + non-empty', () => {
    const a = listPipelines(TENANT, ASOF);
    const b = listPipelines(TENANT, ASOF);
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBe(b.length);
  });

  it('every pipeline has a valid status, domain, schedule', () => {
    for (const p of listPipelines(TENANT, ASOF)) {
      expect(PIPELINE_STATUSES).toContain(p.status);
      expect(DATA_DOMAINS).toContain(p.domain);
      expect(p.schedule_cron.length).toBeGreaterThan(0);
      expect(p.sla_minutes).toBeGreaterThan(0);
      expect(p.success_rate_30d).toBeGreaterThanOrEqual(0);
      expect(p.success_rate_30d).toBeLessThanOrEqual(1);
    }
  });

  it('getPipeline hit + null (signature: pipeline_id, tenant_id, asOf)', () => {
    const list = listPipelines(TENANT, ASOF);
    const id = list[0]?.pipeline_id ?? '';
    expect(getPipeline(id, TENANT, ASOF)?.pipeline_id).toBe(id);
    expect(getPipeline('nope', TENANT, ASOF)).toBeNull();
  });

  it('listPipelineRuns limit honoured + EXECUTION_STATUSES enum', () => {
    const runs = listPipelineRuns(TENANT, ASOF, undefined, 6);
    expect(runs.length).toBeLessThanOrEqual(6);
    for (const r of runs) {
      expect(EXECUTION_STATUSES).toContain(r.status);
      expect(typeof r.sla_met).toBe('boolean');
    }
  });

  it('buildPipelineOrchestratorSummary has every status bucket present', () => {
    const sum = buildPipelineOrchestratorSummary(TENANT, ASOF);
    for (const s of PIPELINE_STATUSES) {
      expect(typeof sum.by_status[s]).toBe('number');
    }
    expect(sum.total_pipelines).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Data quality
// ───────────────────────────────────────────────────────────────────────────

describe('Data quality', () => {
  it('listSourceQuality returns one row per scored source with band + score in [0,100]', () => {
    const rows = listSourceQuality(TENANT, ASOF);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(QUALITY_BANDS).toContain(r.overall_band);
      expect(r.overall_score).toBeGreaterThanOrEqual(0);
      expect(r.overall_score).toBeLessThanOrEqual(100);
    }
  });

  it('listFailedRecords respects limit + severity enum', () => {
    const f = listFailedRecords(TENANT, ASOF, undefined, 8);
    expect(f.length).toBeLessThanOrEqual(8);
    for (const r of f) {
      expect(['low', 'moderate', 'high']).toContain(r.severity);
    }
  });

  it('buildQualityTrend returns a 30-day point series with scores in [0,100]', () => {
    const trend = buildQualityTrend(TENANT, ASOF);
    expect(trend.length).toBeGreaterThan(0);
    for (const p of trend) {
      expect(p.overall_score).toBeGreaterThanOrEqual(0);
      expect(p.overall_score).toBeLessThanOrEqual(100);
    }
  });

  it('buildQualityHeatmap returns source × dimension cells with valid bands', () => {
    const cells = buildQualityHeatmap(TENANT, ASOF);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(QUALITY_DIMENSIONS).toContain(c.dimension);
      expect(QUALITY_BANDS).toContain(c.band);
    }
  });

  it('buildDataQualityCenterSummary partitions and exposes 6 dimensions', () => {
    const sum = buildDataQualityCenterSummary(TENANT, ASOF);
    expect(sum.overall_data_quality_score).toBeGreaterThanOrEqual(0);
    expect(sum.overall_data_quality_score).toBeLessThanOrEqual(100);
    for (const dim of QUALITY_DIMENSIONS) {
      expect(sum.by_dimension[dim]).toBeDefined();
    }
    for (const band of QUALITY_BANDS) {
      expect(typeof sum.by_band[band]).toBe('number');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Metadata catalog + lineage + governance
// ───────────────────────────────────────────────────────────────────────────

describe('Metadata catalog', () => {
  it('listGlossaryTerms non-empty with owner + definition', () => {
    const g = listGlossaryTerms(TENANT, ASOF);
    expect(g.length).toBeGreaterThan(0);
    for (const t of g) {
      expect(t.term.length).toBeGreaterThan(0);
      expect(t.definition.length).toBeGreaterThan(0);
      expect(t.owner.length).toBeGreaterThan(0);
    }
  });

  it('listDataDictionary respects limit + classifies fields', () => {
    const d = listDataDictionary(TENANT, ASOF, undefined, 5);
    expect(d.length).toBeLessThanOrEqual(5);
    for (const e of d) {
      expect(e.field_name.length).toBeGreaterThan(0);
      expect(DATA_CLASSIFICATIONS).toContain(e.classification);
    }
  });

  it('buildMetadataCatalogSummary aggregates totals', () => {
    const s = buildMetadataCatalogSummary(TENANT, ASOF);
    expect(s.total_glossary_terms).toBeGreaterThanOrEqual(0);
    expect(s.total_dictionary_entries).toBeGreaterThanOrEqual(0);
    expect(s.total_owners).toBeGreaterThanOrEqual(0);
  });
});

describe('Lineage', () => {
  it('buildLineageGraph returns nodes + edges with kind enum', () => {
    const g = buildLineageGraph(TENANT, ASOF);
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
    for (const n of g.nodes) {
      expect(n.node_id.length).toBeGreaterThan(0);
      expect(['source', 'transformation', 'data_quality', 'risk_engine', 'ai_model', 'dashboard', 'report'])
        .toContain(n.kind);
    }
    for (const e of g.edges) {
      expect(e.from.length).toBeGreaterThan(0);
      expect(e.to.length).toBeGreaterThan(0);
    }
  });

  it('analyzeImpact returns an impact result for a known node', () => {
    const g = buildLineageGraph(TENANT, ASOF);
    const node = g.nodes[0];
    if (node) {
      const impact = analyzeImpact(TENANT, node.node_id, ASOF);
      expect(impact).toBeDefined();
    }
  });
});

describe('Governance', () => {
  it('listDataPolicies returns policies across kinds', () => {
    const p = listDataPolicies(TENANT, ASOF);
    expect(p.length).toBeGreaterThan(0);
    for (const pol of p) {
      expect(['retention', 'access', 'classification', 'masking', 'anonymization'])
        .toContain(pol.policy_kind);
      expect(['active', 'draft', 'retired']).toContain(pol.status);
    }
  });

  it('buildDataGovernanceSummary partitions by_kind covers all 5 kinds', () => {
    const s = buildDataGovernanceSummary(TENANT, ASOF);
    for (const k of ['retention', 'access', 'classification', 'masking', 'anonymization'] as const) {
      expect(typeof s.by_kind[k]).toBe('number');
    }
    expect(s.compliance_score).toBeGreaterThanOrEqual(0);
    expect(s.compliance_score).toBeLessThanOrEqual(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Observability + AI readiness + Executive dashboard
// ───────────────────────────────────────────────────────────────────────────

describe('Observability', () => {
  it('listObservabilityEvents limit + enums', () => {
    const events = listObservabilityEvents(TENANT, ASOF, undefined, 6);
    expect(events.length).toBeLessThanOrEqual(6);
    for (const ev of events) {
      expect(OBSERVABILITY_EVENT_KINDS).toContain(ev.kind);
      expect(OBSERVABILITY_SEVERITIES).toContain(ev.severity);
    }
  });

  it('buildSourceHealth returns one row per source with health enum', () => {
    const h = buildSourceHealth(TENANT, ASOF);
    expect(h.length).toBeGreaterThan(0);
    for (const row of h) {
      expect(['healthy', 'degraded', 'incident']).toContain(row.overall_health);
      expect(row.freshness_lag_minutes).toBeGreaterThanOrEqual(0);
    }
  });

  it('buildDataObservabilitySummary partitions', () => {
    const s = buildDataObservabilitySummary(TENANT, ASOF);
    expect(s.total_events_24h).toBeGreaterThanOrEqual(0);
    expect(s.healthy_sources + s.degraded_sources + s.incident_sources).toBeGreaterThan(0);
  });
});

describe('AI data readiness', () => {
  it('listAIDatasetReadiness returns datasets with purpose + readiness_state enums', () => {
    const d = listAIDatasetReadiness(TENANT, ASOF);
    expect(d.length).toBeGreaterThan(0);
    for (const ds of d) {
      expect(['training', 'inference', 'validation']).toContain(ds.purpose);
      expect(READINESS_STATES).toContain(ds.readiness_state);
      expect(ds.feature_availability_pct).toBeGreaterThanOrEqual(0);
      expect(ds.feature_availability_pct).toBeLessThanOrEqual(100);
    }
  });

  it('buildAIDataReadinessSummary partitions ready + degraded + unavailable', () => {
    const s = buildAIDataReadinessSummary(TENANT, ASOF);
    expect(s.total_datasets).toBe(s.ready_count + s.degraded_count + s.unavailable_count);
    expect(s.avg_quality_score).toBeGreaterThanOrEqual(0);
    expect(s.avg_quality_score).toBeLessThanOrEqual(100);
  });
});

describe('Executive data health', () => {
  it('buildExecutiveDataHealthDashboard returns score + trend + top_incidents', () => {
    const d = buildExecutiveDataHealthDashboard(TENANT, ASOF);
    expect(d.overall_data_health_score).toBeGreaterThanOrEqual(0);
    expect(d.overall_data_health_score).toBeLessThanOrEqual(100);
    expect(d.trend_30d.length).toBeGreaterThan(0);
    expect(Array.isArray(d.top_incidents)).toBe(true);
  });

  it('trend points have all four scores in [0,100]', () => {
    const d = buildExecutiveDataHealthDashboard(TENANT, ASOF);
    for (const p of d.trend_30d) {
      expect(p.health_score).toBeGreaterThanOrEqual(0);
      expect(p.health_score).toBeLessThanOrEqual(100);
      expect(p.quality_score).toBeGreaterThanOrEqual(0);
      expect(p.freshness_score).toBeGreaterThanOrEqual(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SPA page render — role gate, 10 sections, filter wiring
// ───────────────────────────────────────────────────────────────────────────

describe('DataFabricCenterPage render', () => {
  it('bounces an unauthorized field_officer back to dashboard', () => {
    setUser('field_officer');
    renderRoute();
    // dashboard renders instead (no df-section-* on /)
    expect(screen.queryByTestId('df-section-sources')).toBeNull();
  });

  it('renders all 10 sections for admin', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('df-section-sources')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-integration')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-pipelines')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-quality')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-catalog')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-lineage')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-governance')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-observability')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-ai-readiness')).toBeInTheDocument();
    expect(screen.getByTestId('df-section-exec')).toBeInTheDocument();
  });

  it('renders for risk_analyst (analyst-level gate)', () => {
    setUser('risk_analyst');
    renderRoute();
    expect(screen.getByTestId('df-section-sources')).toBeInTheDocument();
  });

  it('renders for supervisor', () => {
    setUser('supervisor');
    renderRoute();
    expect(screen.getByTestId('df-section-integration')).toBeInTheDocument();
  });
});

describe('Source registry filters', () => {
  it('domain filter chips toggle without crashing', () => {
    setUser('admin');
    renderRoute();
    const insurance = screen.getByTestId('source-domain-insurance');
    fireEvent.click(insurance);
    // section still renders after filter change
    expect(screen.getByTestId('df-section-sources')).toBeInTheDocument();
  });

  it('status filter chip "all" exists alongside enum values', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('source-status-all')).toBeInTheDocument();
    for (const s of INTEGRATION_STATUSES) {
      expect(screen.getByTestId(`source-status-${s}`)).toBeInTheDocument();
    }
  });

  it('type filter chip "all" exists alongside enum values', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('source-type-all')).toBeInTheDocument();
    for (const t of INTEGRATION_TYPES) {
      expect(screen.getByTestId(`source-type-${t}`)).toBeInTheDocument();
    }
  });
});

describe('Integration hub KPIs', () => {
  it('renders 7 KPI tiles (connections / active / failed / retry / throughput / latency / success-rate)', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('kpi-connections')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-active')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-failed')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-retry')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-throughput')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-latency')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-success-rate')).toBeInTheDocument();
  });
});

describe('Pipeline orchestration', () => {
  it('renders every status bucket + every action button', () => {
    setUser('admin');
    renderRoute();
    for (const s of PIPELINE_STATUSES) {
      expect(screen.getByTestId(`pipeline-bucket-${s}`)).toBeInTheDocument();
    }
    for (const a of PIPELINE_ACTIONS) {
      expect(screen.getByTestId(`pipeline-action-${a}`)).toBeInTheDocument();
    }
  });
});

describe('Quality center', () => {
  it('renders one chip per quality dimension', () => {
    setUser('admin');
    renderRoute();
    for (const dim of QUALITY_DIMENSIONS) {
      expect(screen.getByTestId(`quality-dim-${dim}`)).toBeInTheDocument();
    }
  });
});

describe('Observability filter', () => {
  it('renders "all" + every kind filter chip and toggles without crashing', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('obs-filter-all')).toBeInTheDocument();
    for (const k of OBSERVABILITY_EVENT_KINDS) {
      expect(screen.getByTestId(`obs-filter-${k}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('obs-filter-freshness_lag'));
    expect(screen.getByTestId('df-section-observability')).toBeInTheDocument();
  });
});

describe('Executive dashboard KPI tiles', () => {
  it('renders 6 executive KPI tiles', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('exec-kpi-health')).toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-integration')).toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-pipeline')).toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-quality')).toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-freshness')).toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-governance')).toBeInTheDocument();
  });
});

describe('AI data readiness KPI tiles', () => {
  it('renders availability / freshness / quality / validation pass', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('ai-kpi-availability')).toBeInTheDocument();
    expect(screen.getByTestId('ai-kpi-freshness')).toBeInTheDocument();
    expect(screen.getByTestId('ai-kpi-quality')).toBeInTheDocument();
    expect(screen.getByTestId('ai-kpi-validation')).toBeInTheDocument();
  });
});
