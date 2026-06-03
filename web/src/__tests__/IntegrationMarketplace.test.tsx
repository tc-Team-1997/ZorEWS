/**
 * IntegrationMarketplace.test.tsx
 * Tests for Phase 20 — Enterprise Integration Marketplace
 */
import { describe, it, expect } from 'vitest';
import {
  buildIntegrationCatalog,
  buildApiMarketplace,
  buildDataExchangeFlows,
  buildDataExchangeMetrics,
  buildEventSubscriptions,
  buildPartnerEcosystem,
  buildGovernanceRecords,
  buildObservabilityMetrics,
  buildIntegrationInsights,
  buildExecutiveKpis,
  buildReadinessScore,
  canAccessIntegrationMarketplace,
  INTEGRATION_CATEGORIES,
  INTEGRATION_STATUSES,
  GOVERNANCE_STATES,
  API_TYPES,
  PARTNER_TYPES,
  HEALTH_LEVELS,
  READINESS_DIMENSIONS,
  EVENT_DEFINITIONS,
} from '@/modules/integrationMarketplace/integrationMarketplaceEngine';

const NOW = new Date('2026-06-01T09:00:00Z');
const TENANT = 'BANK_DEMO';
const TENANT_B = 'BIL';

// ─────────────────────────────────────────────────────────────────────────────
// Access control
// ─────────────────────────────────────────────────────────────────────────────

describe('canAccessIntegrationMarketplace', () => {
  it('grants access to admin', () => {
    expect(canAccessIntegrationMarketplace(['admin'])).toBe(true);
  });
  it('grants access to risk_analyst', () => {
    expect(canAccessIntegrationMarketplace(['risk_analyst'])).toBe(true);
  });
  it('grants access to supervisor', () => {
    expect(canAccessIntegrationMarketplace(['supervisor'])).toBe(true);
  });
  it('grants access to cro', () => {
    expect(canAccessIntegrationMarketplace(['cro'])).toBe(true);
  });
  it('denies empty roles', () => {
    expect(canAccessIntegrationMarketplace([])).toBe(false);
  });
  it('denies undefined roles', () => {
    expect(canAccessIntegrationMarketplace(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Enum constants
// ─────────────────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('INTEGRATION_CATEGORIES has 3 values', () => {
    expect(INTEGRATION_CATEGORIES).toHaveLength(3);
    expect(INTEGRATION_CATEGORIES).toContain('banking');
    expect(INTEGRATION_CATEGORIES).toContain('insurance');
    expect(INTEGRATION_CATEGORIES).toContain('enterprise');
  });
  it('INTEGRATION_STATUSES has 5 values', () => {
    expect(INTEGRATION_STATUSES).toHaveLength(5);
  });
  it('GOVERNANCE_STATES has 5 values', () => {
    expect(GOVERNANCE_STATES).toHaveLength(5);
    expect(GOVERNANCE_STATES).toContain('approved');
  });
  it('API_TYPES has 4 values', () => {
    expect(API_TYPES).toHaveLength(4);
    expect(API_TYPES).toContain('REST');
    expect(API_TYPES).toContain('GraphQL');
  });
  it('PARTNER_TYPES has 6 values', () => {
    expect(PARTNER_TYPES).toHaveLength(6);
    expect(PARTNER_TYPES).toContain('credit_bureau');
  });
  it('HEALTH_LEVELS has 4 values', () => {
    expect(HEALTH_LEVELS).toHaveLength(4);
  });
  it('READINESS_DIMENSIONS has 6 values', () => {
    expect(READINESS_DIMENSIONS).toHaveLength(6);
    expect(READINESS_DIMENSIONS).toContain('security');
    expect(READINESS_DIMENSIONS).toContain('compliance');
  });
  it('EVENT_DEFINITIONS has 10 entries', () => {
    expect(EVENT_DEFINITIONS).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Integration Catalog
// ─────────────────────────────────────────────────────────────────────────────

describe('buildIntegrationCatalog', () => {
  it('returns 22 integrations', () => {
    const catalog = buildIntegrationCatalog(TENANT, NOW);
    expect(catalog).toHaveLength(22);
  });
  it('covers all 3 categories', () => {
    const catalog = buildIntegrationCatalog(TENANT, NOW);
    const cats = new Set(catalog.map(e => e.category));
    expect(cats.has('banking')).toBe(true);
    expect(cats.has('insurance')).toBe(true);
    expect(cats.has('enterprise')).toBe(true);
  });
  it('all entries have required fields', () => {
    const catalog = buildIntegrationCatalog(TENANT, NOW);
    for (const e of catalog) {
      expect(e.integration_id).toBeTruthy();
      expect(e.name).toBeTruthy();
      expect(e.owner).toBeTruthy();
      expect(e.status).toBeTruthy();
      expect(typeof e.health_score).toBe('number');
      expect(e.health_score).toBeGreaterThanOrEqual(0);
      expect(e.health_score).toBeLessThanOrEqual(100);
    }
  });
  it('SLA uptime pct is in [0, 100]', () => {
    const catalog = buildIntegrationCatalog(TENANT, NOW);
    for (const e of catalog) {
      expect(e.sla_uptime_pct).toBeGreaterThanOrEqual(0);
      expect(e.sla_uptime_pct).toBeLessThanOrEqual(100);
    }
  });
  it('is deterministic for same (tenant, day)', () => {
    const a = buildIntegrationCatalog(TENANT, NOW);
    const b = buildIntegrationCatalog(TENANT, NOW);
    expect(a[0].health_score).toBe(b[0].health_score);
    expect(a[5].sla_uptime_pct).toBe(b[5].sla_uptime_pct);
  });
  it('produces different data for different tenants', () => {
    const a = buildIntegrationCatalog(TENANT, NOW);
    const b = buildIntegrationCatalog(TENANT_B, NOW);
    const allSame = a.every((e, i) => e.health_score === b[i].health_score);
    expect(allSame).toBe(false);
  });
  it('has 8 banking integrations', () => {
    const catalog = buildIntegrationCatalog(TENANT, NOW);
    expect(catalog.filter(e => e.category === 'banking')).toHaveLength(8);
  });
  it('has 6 insurance integrations', () => {
    const catalog = buildIntegrationCatalog(TENANT, NOW);
    expect(catalog.filter(e => e.category === 'insurance')).toHaveLength(6);
  });
  it('has 8 enterprise integrations', () => {
    const catalog = buildIntegrationCatalog(TENANT, NOW);
    expect(catalog.filter(e => e.category === 'enterprise')).toHaveLength(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — API Marketplace
// ─────────────────────────────────────────────────────────────────────────────

describe('buildApiMarketplace', () => {
  it('returns 15 API entries', () => {
    const apis = buildApiMarketplace(TENANT, NOW);
    expect(apis).toHaveLength(15);
  });
  it('all entries have required fields', () => {
    const apis = buildApiMarketplace(TENANT, NOW);
    for (const a of apis) {
      expect(a.api_id).toBeTruthy();
      expect(a.name).toBeTruthy();
      expect(a.endpoint).toBeTruthy();
      expect(a.sla_ms).toBeGreaterThan(0);
      expect(a.availability_pct).toBeGreaterThan(0);
      expect(a.availability_pct).toBeLessThanOrEqual(100);
    }
  });
  it('availability pct is in [0, 100]', () => {
    const apis = buildApiMarketplace(TENANT, NOW);
    for (const a of apis) {
      expect(a.availability_pct).toBeGreaterThanOrEqual(90);
    }
  });
  it('error rate pct is non-negative', () => {
    const apis = buildApiMarketplace(TENANT, NOW);
    for (const a of apis) {
      expect(a.error_rate_pct).toBeGreaterThanOrEqual(0);
    }
  });
  it('is deterministic', () => {
    const a = buildApiMarketplace(TENANT, NOW);
    const b = buildApiMarketplace(TENANT, NOW);
    expect(a[0].availability_pct).toBe(b[0].availability_pct);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Data Exchange Hub
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDataExchangeFlows', () => {
  it('returns 12 flows', () => {
    const flows = buildDataExchangeFlows(TENANT, NOW);
    expect(flows).toHaveLength(12);
  });
  it('all flows have required fields', () => {
    const flows = buildDataExchangeFlows(TENANT, NOW);
    for (const f of flows) {
      expect(f.flow_id).toBeTruthy();
      expect(f.source).toBeTruthy();
      expect(f.target).toBeTruthy();
      expect(typeof f.records_processed_today).toBe('number');
    }
  });
  it('success_rate_pct in [0, 100]', () => {
    const flows = buildDataExchangeFlows(TENANT, NOW);
    for (const f of flows) {
      expect(f.success_rate_pct).toBeGreaterThanOrEqual(0);
      expect(f.success_rate_pct).toBeLessThanOrEqual(100);
    }
  });
  it('failures_today <= records_processed_today', () => {
    const flows = buildDataExchangeFlows(TENANT, NOW);
    for (const f of flows) {
      expect(f.failures_today).toBeLessThanOrEqual(f.records_processed_today);
    }
  });
  it('is deterministic', () => {
    const a = buildDataExchangeFlows(TENANT, NOW);
    const b = buildDataExchangeFlows(TENANT, NOW);
    expect(a[0].records_processed_today).toBe(b[0].records_processed_today);
  });
});

describe('buildDataExchangeMetrics', () => {
  it('returns 3 period metrics (daily/weekly/monthly)', () => {
    const metrics = buildDataExchangeMetrics(TENANT, NOW);
    expect(metrics).toHaveLength(3);
    const periods = metrics.map(m => m.period);
    expect(periods).toContain('daily');
    expect(periods).toContain('weekly');
    expect(periods).toContain('monthly');
  });
  it('monthly total > weekly total > daily total', () => {
    const metrics = buildDataExchangeMetrics(TENANT, NOW);
    const daily = metrics.find(m => m.period === 'daily')!;
    const weekly = metrics.find(m => m.period === 'weekly')!;
    const monthly = metrics.find(m => m.period === 'monthly')!;
    expect(weekly.total_records).toBeGreaterThan(daily.total_records);
    expect(monthly.total_records).toBeGreaterThan(weekly.total_records);
  });
  it('success_rate_pct >= 99', () => {
    const metrics = buildDataExchangeMetrics(TENANT, NOW);
    for (const m of metrics) {
      expect(m.success_rate_pct).toBeGreaterThanOrEqual(99);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — Event Subscription Center
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEventSubscriptions', () => {
  it('returns subscriptions (multiple per event type)', () => {
    const subs = buildEventSubscriptions(TENANT, NOW);
    expect(subs.length).toBeGreaterThan(10);
  });
  it('all subscriptions have required fields', () => {
    const subs = buildEventSubscriptions(TENANT, NOW);
    for (const s of subs) {
      expect(s.subscription_id).toBeTruthy();
      expect(s.event_type).toBeTruthy();
      expect(s.subscriber).toBeTruthy();
      expect(s.endpoint).toBeTruthy();
      expect(['healthy', 'degraded', 'failed']).toContain(s.delivery_status);
    }
  });
  it('success_rate_pct in [0, 100]', () => {
    const subs = buildEventSubscriptions(TENANT, NOW);
    for (const s of subs) {
      expect(s.success_rate_pct).toBeGreaterThanOrEqual(0);
      expect(s.success_rate_pct).toBeLessThanOrEqual(100);
    }
  });
  it('covers all 10 event types', () => {
    const subs = buildEventSubscriptions(TENANT, NOW);
    const eventTypes = new Set(subs.map(s => s.event_type));
    for (const def of EVENT_DEFINITIONS) {
      expect(eventTypes.has(def.event_type)).toBe(true);
    }
  });
  it('is deterministic', () => {
    const a = buildEventSubscriptions(TENANT, NOW);
    const b = buildEventSubscriptions(TENANT, NOW);
    expect(a.length).toBe(b.length);
    expect(a[0].success_rate_pct).toBe(b[0].success_rate_pct);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 5 — Partner Ecosystem
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPartnerEcosystem', () => {
  it('returns 12 partners', () => {
    const partners = buildPartnerEcosystem(TENANT, NOW);
    expect(partners).toHaveLength(12);
  });
  it('all partners have required fields', () => {
    const partners = buildPartnerEcosystem(TENANT, NOW);
    for (const p of partners) {
      expect(p.partner_id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(['credit_bureau', 'collection_agency', 'investigator', 'audit_firm', 'recovery_agency', 'insurance_surveyor']).toContain(p.type);
      expect(p.sla_met_pct).toBeGreaterThan(0);
    }
  });
  it('SLA met pct is in [0, 100]', () => {
    const partners = buildPartnerEcosystem(TENANT, NOW);
    for (const p of partners) {
      expect(p.sla_met_pct).toBeGreaterThanOrEqual(0);
      expect(p.sla_met_pct).toBeLessThanOrEqual(100);
    }
  });
  it('has at least 2 credit bureaus', () => {
    const partners = buildPartnerEcosystem(TENANT, NOW);
    const bureaus = partners.filter(p => p.type === 'credit_bureau');
    expect(bureaus.length).toBeGreaterThanOrEqual(2);
  });
  it('is deterministic', () => {
    const a = buildPartnerEcosystem(TENANT, NOW);
    const b = buildPartnerEcosystem(TENANT, NOW);
    expect(a[0].sla_met_pct).toBe(b[0].sla_met_pct);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 6 — Governance Records
// ─────────────────────────────────────────────────────────────────────────────

describe('buildGovernanceRecords', () => {
  it('returns 12 records', () => {
    const records = buildGovernanceRecords(TENANT, NOW);
    expect(records).toHaveLength(12);
  });
  it('all records have required fields', () => {
    const records = buildGovernanceRecords(TENANT, NOW);
    for (const r of records) {
      expect(r.record_id).toBeTruthy();
      expect(r.integration_name).toBeTruthy();
      expect(['draft', 'review', 'approved', 'rejected', 'retired']).toContain(r.state);
      expect(r.approver).toBeTruthy();
    }
  });
  it('approved records have approved_at set', () => {
    const records = buildGovernanceRecords(TENANT, NOW);
    for (const r of records) {
      if (r.state === 'approved') {
        expect(r.approved_at).not.toBeNull();
      }
    }
  });
  it('non-approved records have approved_at null', () => {
    const records = buildGovernanceRecords(TENANT, NOW);
    for (const r of records) {
      if (r.state !== 'approved') {
        expect(r.approved_at).toBeNull();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 7 — Observability Metrics
// ─────────────────────────────────────────────────────────────────────────────

describe('buildObservabilityMetrics', () => {
  it('returns an object with all required fields', () => {
    const obs = buildObservabilityMetrics(TENANT, NOW);
    expect(obs.total_integrations).toBe(22);
    expect(typeof obs.healthy_count).toBe('number');
    expect(typeof obs.degraded_count).toBe('number');
    expect(typeof obs.overall_availability_pct).toBe('number');
    expect(obs.error_trend).toHaveLength(12);
  });
  it('availability pct >= 98', () => {
    const obs = buildObservabilityMetrics(TENANT, NOW);
    expect(obs.overall_availability_pct).toBeGreaterThanOrEqual(98);
  });
  it('p99 latency >= p95 latency', () => {
    const obs = buildObservabilityMetrics(TENANT, NOW);
    expect(obs.p99_latency_ms).toBeGreaterThanOrEqual(obs.p95_latency_ms);
  });
  it('error rate pct >= 0', () => {
    const obs = buildObservabilityMetrics(TENANT, NOW);
    expect(obs.error_rate_pct).toBeGreaterThanOrEqual(0);
  });
  it('error trend has hour and count fields', () => {
    const obs = buildObservabilityMetrics(TENANT, NOW);
    for (const t of obs.error_trend) {
      expect(t.hour).toBeTruthy();
      expect(typeof t.errors).toBe('number');
      expect(typeof t.requests).toBe('number');
      expect(t.requests).toBeGreaterThan(0);
    }
  });
  it('healthy + degraded + failed count <= total_integrations', () => {
    const obs = buildObservabilityMetrics(TENANT, NOW);
    expect(obs.healthy_count + obs.degraded_count + obs.failed_count).toBeLessThanOrEqual(obs.total_integrations);
  });
  it('is deterministic', () => {
    const a = buildObservabilityMetrics(TENANT, NOW);
    const b = buildObservabilityMetrics(TENANT, NOW);
    expect(a.total_api_calls_24h).toBe(b.total_api_calls_24h);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 8 — AI Integration Insights
// ─────────────────────────────────────────────────────────────────────────────

describe('buildIntegrationInsights', () => {
  it('returns 7 insights', () => {
    const insights = buildIntegrationInsights(TENANT, NOW);
    expect(insights).toHaveLength(7);
  });
  it('all insights have required fields', () => {
    const insights = buildIntegrationInsights(TENANT, NOW);
    for (const ins of insights) {
      expect(ins.insight_id).toBeTruthy();
      expect(['risk', 'bottleneck', 'sla_breach', 'capacity', 'optimization']).toContain(ins.type);
      expect(['info', 'warning', 'critical']).toContain(ins.severity);
      expect(ins.title).toBeTruthy();
      expect(ins.description).toBeTruthy();
      expect(ins.recommendation).toBeTruthy();
    }
  });
  it('confidence score is in [0, 1]', () => {
    const insights = buildIntegrationInsights(TENANT, NOW);
    for (const ins of insights) {
      expect(ins.confidence_score).toBeGreaterThan(0);
      expect(ins.confidence_score).toBeLessThanOrEqual(1);
    }
  });
  it('has at least one critical insight', () => {
    const insights = buildIntegrationInsights(TENANT, NOW);
    const critical = insights.filter(i => i.severity === 'critical');
    expect(critical.length).toBeGreaterThanOrEqual(1);
  });
  it('is deterministic', () => {
    const a = buildIntegrationInsights(TENANT, NOW);
    const b = buildIntegrationInsights(TENANT, NOW);
    expect(a[0].confidence_score).toBe(b[0].confidence_score);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 9 — Executive KPIs
// ─────────────────────────────────────────────────────────────────────────────

describe('buildExecutiveKpis', () => {
  it('returns an object with required KPI fields', () => {
    const kpis = buildExecutiveKpis(TENANT, NOW);
    expect(kpis.total_integrations).toBe(22);
    expect(typeof kpis.active_integrations).toBe('number');
    expect(typeof kpis.vendor_risk_score).toBe('number');
    expect(typeof kpis.integration_maturity_score).toBe('number');
    expect(typeof kpis.estimated_integration_value_cr).toBe('number');
    expect(kpis.top_risks).toHaveLength(3);
  });
  it('active integrations <= total integrations', () => {
    const kpis = buildExecutiveKpis(TENANT, NOW);
    expect(kpis.active_integrations).toBeLessThanOrEqual(kpis.total_integrations);
  });
  it('integrations_by_category sums to 22', () => {
    const kpis = buildExecutiveKpis(TENANT, NOW);
    const sum = kpis.integrations_by_category.banking +
      kpis.integrations_by_category.insurance +
      kpis.integrations_by_category.enterprise;
    expect(sum).toBe(22);
  });
  it('vendor_risk_score in [0, 100]', () => {
    const kpis = buildExecutiveKpis(TENANT, NOW);
    expect(kpis.vendor_risk_score).toBeGreaterThanOrEqual(0);
    expect(kpis.vendor_risk_score).toBeLessThanOrEqual(100);
  });
  it('partner_sla_compliance_pct >= 90', () => {
    const kpis = buildExecutiveKpis(TENANT, NOW);
    expect(kpis.partner_sla_compliance_pct).toBeGreaterThanOrEqual(90);
  });
  it('is deterministic', () => {
    const a = buildExecutiveKpis(TENANT, NOW);
    const b = buildExecutiveKpis(TENANT, NOW);
    expect(a.integration_maturity_score).toBe(b.integration_maturity_score);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 10 — Readiness Score
// ─────────────────────────────────────────────────────────────────────────────

describe('buildReadinessScore', () => {
  it('returns an object with overall_score and grade', () => {
    const rs = buildReadinessScore(TENANT, NOW);
    expect(typeof rs.overall_score).toBe('number');
    expect(['A+', 'A', 'B+', 'B', 'C', 'D']).toContain(rs.grade);
  });
  it('overall score is in [0, 100]', () => {
    const rs = buildReadinessScore(TENANT, NOW);
    expect(rs.overall_score).toBeGreaterThan(0);
    expect(rs.overall_score).toBeLessThanOrEqual(100);
  });
  it('dimensions covers all 6 readiness dimensions', () => {
    const rs = buildReadinessScore(TENANT, NOW);
    for (const dim of READINESS_DIMENSIONS) {
      expect(rs.dimensions[dim]).toBeDefined();
      expect(rs.dimensions[dim].score).toBeGreaterThan(0);
      expect(['good', 'fair', 'poor']).toContain(rs.dimensions[dim].status);
      expect(rs.dimensions[dim].gap).toBeTruthy();
    }
  });
  it('dimension scores are in [0, 100]', () => {
    const rs = buildReadinessScore(TENANT, NOW);
    for (const dim of READINESS_DIMENSIONS) {
      expect(rs.dimensions[dim].score).toBeGreaterThanOrEqual(0);
      expect(rs.dimensions[dim].score).toBeLessThanOrEqual(100);
    }
  });
  it('benchmark comparison has 3 values', () => {
    const rs = buildReadinessScore(TENANT, NOW);
    expect(typeof rs.benchmark_comparison.industry_avg).toBe('number');
    expect(typeof rs.benchmark_comparison.top_quartile).toBe('number');
    expect(rs.benchmark_comparison.our_score).toBe(rs.overall_score);
  });
  it('has strengths and improvement_areas arrays', () => {
    const rs = buildReadinessScore(TENANT, NOW);
    expect(Array.isArray(rs.strengths)).toBe(true);
    expect(rs.strengths.length).toBeGreaterThan(0);
    expect(Array.isArray(rs.improvement_areas)).toBe(true);
    expect(rs.improvement_areas.length).toBeGreaterThan(0);
  });
  it('is deterministic', () => {
    const a = buildReadinessScore(TENANT, NOW);
    const b = buildReadinessScore(TENANT, NOW);
    expect(a.overall_score).toBe(b.overall_score);
    expect(a.grade).toBe(b.grade);
  });
  it('produces different scores for different tenants', () => {
    const a = buildReadinessScore(TENANT, NOW);
    const b = buildReadinessScore(TENANT_B, NOW);
    // They may occasionally match but overall_score likely differs
    const dimensionsDiffer = READINESS_DIMENSIONS.some(
      dim => a.dimensions[dim].score !== b.dimensions[dim].score
    );
    expect(dimensionsDiffer).toBe(true);
  });
});
