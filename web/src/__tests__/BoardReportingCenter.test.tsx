/**
 * BoardReportingCenter.test.tsx
 * Phase 21 — Board Reporting Center engine tests
 * 85+ tests across 14 groups
 */

import { describe, it, expect } from 'vitest';
import {
  buildBoardPackLibrary,
  buildExecutiveKpis,
  buildBoardDashboards,
  buildRegulatoryReports,
  buildAiGovernanceReports,
  buildComplianceSummary,
  buildPredictiveForecasts,
  buildDigitalTwinReports,
  buildAutonomousAiReport,
  buildRecentGenerations,
  buildReportSchedules,
  buildExecutiveIntelligenceSummary,
  buildBoardReportingKpis,
  canAccessBoardReportingCenter,
  PACK_TYPES,
  APPROVAL_STATUSES,
  REPORT_FORMATS,
  SCHEDULE_FREQUENCIES,
  REGULATORY_FRAMEWORKS,
  FORECAST_HORIZONS,
  TREND_DIRECTIONS,
} from '@/modules/boardReporting/boardReportingEngine';

const TENANT = 'BANK_DEMO';
const AS_OF = new Date('2026-06-01T12:00:00.000Z');

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — canAccessBoardReportingCenter (5 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('canAccessBoardReportingCenter', () => {
  it('returns false for undefined roles', () => {
    expect(canAccessBoardReportingCenter(undefined)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(canAccessBoardReportingCenter([])).toBe(false);
  });

  it('returns true for admin', () => {
    expect(canAccessBoardReportingCenter(['admin'])).toBe(true);
  });

  it('returns true for cro', () => {
    expect(canAccessBoardReportingCenter(['cro'])).toBe(true);
  });

  it('returns true for board_member', () => {
    expect(canAccessBoardReportingCenter(['board_member'])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — Enum constants (5 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('Enum constants', () => {
  it('PACK_TYPES has 9 values', () => {
    expect(PACK_TYPES.length).toBe(9);
  });

  it('APPROVAL_STATUSES has 5 values', () => {
    expect(APPROVAL_STATUSES.length).toBe(5);
  });

  it('FORECAST_HORIZONS has 4 values: 30d, 60d, 90d, 180d', () => {
    expect(FORECAST_HORIZONS).toEqual(['30d', '60d', '90d', '180d']);
  });

  it('REGULATORY_FRAMEWORKS includes RBI and IRDAI', () => {
    expect(REGULATORY_FRAMEWORKS).toContain('RBI');
    expect(REGULATORY_FRAMEWORKS).toContain('IRDAI');
  });

  it('SCHEDULE_FREQUENCIES has 5 values', () => {
    expect(SCHEDULE_FREQUENCIES.length).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3 — buildBoardPackLibrary (12 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBoardPackLibrary', () => {
  const packs = buildBoardPackLibrary(TENANT, AS_OF);

  it('returns 9 packs — one per PACK_TYPES value', () => {
    expect(packs.length).toBe(9);
  });

  it('every pack has required fields: pack_id, title, owner, version, approval_status', () => {
    for (const pack of packs) {
      expect(pack.pack_id).toBeTruthy();
      expect(pack.title).toBeTruthy();
      expect(pack.owner).toBeTruthy();
      expect(pack.version).toBeTruthy();
      expect(pack.approval_status).toBeTruthy();
    }
  });

  it('approval_status is within APPROVAL_STATUSES', () => {
    const allowed = new Set(APPROVAL_STATUSES);
    for (const pack of packs) {
      expect(allowed.has(pack.approval_status)).toBe(true);
    }
  });

  it('review_cycle is within SCHEDULE_FREQUENCIES', () => {
    const allowed = new Set(SCHEDULE_FREQUENCIES);
    for (const pack of packs) {
      expect(allowed.has(pack.review_cycle)).toBe(true);
    }
  });

  it('distribution_list is a non-empty array', () => {
    for (const pack of packs) {
      expect(Array.isArray(pack.distribution_list)).toBe(true);
      expect(pack.distribution_list.length).toBeGreaterThan(0);
    }
  });

  it('sections is a non-empty array', () => {
    for (const pack of packs) {
      expect(Array.isArray(pack.sections)).toBe(true);
      expect(pack.sections.length).toBeGreaterThan(0);
    }
  });

  it('pages_count > 0', () => {
    for (const pack of packs) {
      expect(pack.pages_count).toBeGreaterThan(0);
    }
  });

  it('size_kb > 0', () => {
    for (const pack of packs) {
      expect(pack.size_kb).toBeGreaterThan(0);
    }
  });

  it('is deterministic — same inputs produce same output', () => {
    const packs2 = buildBoardPackLibrary(TENANT, AS_OF);
    expect(JSON.stringify(packs)).toBe(JSON.stringify(packs2));
  });

  it('next_due is after last_generated', () => {
    for (const pack of packs) {
      expect(new Date(pack.next_due) >= new Date(pack.last_generated)).toBe(true);
    }
  });

  it('tenant isolation — BANK_DEMO and BIL produce different packs', () => {
    const bilPacks = buildBoardPackLibrary('BIL', AS_OF);
    // At minimum, pack IDs should differ if tenant affects synthesis, or versions
    // They share the same metadata but rng-derived fields (version, pages_count, size_kb) differ
    // Not strictly guaranteed to differ, but we can verify both produce 9 packs
    expect(bilPacks.length).toBe(9);
    // And that they are structurally valid regardless of tenant
    expect(bilPacks[0].pack_id).toBeTruthy();
    // Confirm at least one rng-derived field can differ (it almost certainly will)
    const anyDiff = packs.some((p, i) => p.pages_count !== bilPacks[i].pages_count || p.size_kb !== bilPacks[i].size_kb);
    expect(anyDiff).toBe(true);
  });

  it('pack_types cover all 9 PACK_TYPES values', () => {
    const types = new Set(packs.map(p => p.pack_type));
    for (const t of PACK_TYPES) {
      expect(types.has(t)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4 — buildExecutiveKpis (10 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildExecutiveKpis', () => {
  const kpis = buildExecutiveKpis(TENANT, AS_OF);

  it('has banking, insurance, enterprise, generated_at properties', () => {
    expect(kpis).toHaveProperty('banking');
    expect(kpis).toHaveProperty('insurance');
    expect(kpis).toHaveProperty('enterprise');
    expect(kpis).toHaveProperty('generated_at');
  });

  it('banking section has 6 KPI items', () => {
    expect(kpis.banking.length).toBe(6);
  });

  it('insurance section has 6 KPI items', () => {
    expect(kpis.insurance.length).toBe(6);
  });

  it('enterprise section has 4 KPI items', () => {
    expect(kpis.enterprise.length).toBe(4);
  });

  it('every item has kpi, value, unit, trend, threshold_status, benchmark', () => {
    const allItems = [...kpis.banking, ...kpis.insurance, ...kpis.enterprise];
    for (const item of allItems) {
      expect(item.kpi).toBeTruthy();
      expect(item.value).toBeTruthy();
      expect(item.unit).toBeTruthy();
      expect(item.trend).toBeTruthy();
      expect(item.threshold_status).toBeTruthy();
      expect(item.benchmark).toBeTruthy();
    }
  });

  it('trend is within TREND_DIRECTIONS', () => {
    const allowed = new Set(TREND_DIRECTIONS);
    const allItems = [...kpis.banking, ...kpis.insurance, ...kpis.enterprise];
    for (const item of allItems) {
      expect(allowed.has(item.trend)).toBe(true);
    }
  });

  it('threshold_status is within [within, watch, breach]', () => {
    const allowed = new Set(['within', 'watch', 'breach']);
    const allItems = [...kpis.banking, ...kpis.insurance, ...kpis.enterprise];
    for (const item of allItems) {
      expect(allowed.has(item.threshold_status)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const kpis2 = buildExecutiveKpis(TENANT, AS_OF);
    expect(JSON.stringify(kpis)).toBe(JSON.stringify(kpis2));
  });

  it('generated_at is a valid ISO string', () => {
    expect(() => new Date(kpis.generated_at)).not.toThrow();
    expect(kpis.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('Gross NPA Ratio KPI exists in banking section', () => {
    const npaKpi = kpis.banking.find(item => item.kpi.toLowerCase().includes('npa'));
    expect(npaKpi).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5 — buildBoardDashboards (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBoardDashboards', () => {
  const dashboards = buildBoardDashboards(TENANT, AS_OF);

  it('returns 6 dashboards', () => {
    expect(dashboards.length).toBe(6);
  });

  it('every dashboard has dashboard_id, title, category, status', () => {
    for (const d of dashboards) {
      expect(d.dashboard_id).toBeTruthy();
      expect(d.title).toBeTruthy();
      expect(d.category).toBeTruthy();
      expect(d.status).toBeTruthy();
    }
  });

  it('health_score is between 0 and 100', () => {
    for (const d of dashboards) {
      expect(d.health_score).toBeGreaterThanOrEqual(0);
      expect(d.health_score).toBeLessThanOrEqual(100);
    }
  });

  it('kpi_count > 0 for all dashboards', () => {
    for (const d of dashboards) {
      expect(d.kpi_count).toBeGreaterThan(0);
    }
  });

  it('viewers is a non-empty array', () => {
    for (const d of dashboards) {
      expect(Array.isArray(d.viewers)).toBe(true);
      expect(d.viewers.length).toBeGreaterThan(0);
    }
  });

  it('status is within [live, scheduled, maintenance]', () => {
    const allowed = new Set(['live', 'scheduled', 'maintenance']);
    for (const d of dashboards) {
      expect(allowed.has(d.status)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6 — buildRegulatoryReports (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRegulatoryReports', () => {
  const reports = buildRegulatoryReports(TENANT, AS_OF);

  it('returns 12 reports', () => {
    expect(reports.length).toBe(12);
  });

  it('every report has report_id, framework, report_name, domain, frequency', () => {
    for (const r of reports) {
      expect(r.report_id).toBeTruthy();
      expect(r.framework).toBeTruthy();
      expect(r.report_name).toBeTruthy();
      expect(r.domain).toBeTruthy();
      expect(r.frequency).toBeTruthy();
    }
  });

  it('framework values are within REGULATORY_FRAMEWORKS', () => {
    const allowed = new Set(REGULATORY_FRAMEWORKS);
    for (const r of reports) {
      expect(allowed.has(r.framework)).toBe(true);
    }
  });

  it('domain is either banking or insurance', () => {
    for (const r of reports) {
      expect(['banking', 'insurance']).toContain(r.domain);
    }
  });

  it('submission_status is within valid values', () => {
    const allowed = new Set(['filed', 'due_soon', 'overdue', 'in_preparation']);
    for (const r of reports) {
      expect(allowed.has(r.submission_status)).toBe(true);
    }
  });

  it('due_date is a valid YYYY-MM-DD date string', () => {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    for (const r of reports) {
      expect(r.due_date).toMatch(dateRe);
      expect(isNaN(new Date(r.due_date).getTime())).toBe(false);
    }
  });

  it('last_filed is a valid YYYY-MM-DD date string', () => {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    for (const r of reports) {
      expect(r.last_filed).toMatch(dateRe);
    }
  });

  it('filing_authority is non-empty', () => {
    for (const r of reports) {
      expect(r.filing_authority.trim().length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7 — buildAiGovernanceReports (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAiGovernanceReports', () => {
  const reports = buildAiGovernanceReports(TENANT, AS_OF);

  it('returns 5 reports', () => {
    expect(reports.length).toBe(5);
  });

  it('every report has report_id, report_type, title, overall_status', () => {
    for (const r of reports) {
      expect(r.report_id).toBeTruthy();
      expect(r.report_type).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.overall_status).toBeTruthy();
    }
  });

  it('overall_status is within [healthy, watch, action_required]', () => {
    const allowed = new Set(['healthy', 'watch', 'action_required']);
    for (const r of reports) {
      expect(allowed.has(r.overall_status)).toBe(true);
    }
  });

  it('key_metrics is a non-empty array', () => {
    for (const r of reports) {
      expect(Array.isArray(r.key_metrics)).toBe(true);
      expect(r.key_metrics.length).toBeGreaterThan(0);
    }
  });

  it('recommendations is a non-empty array', () => {
    for (const r of reports) {
      expect(Array.isArray(r.recommendations)).toBe(true);
      expect(r.recommendations.length).toBeGreaterThan(0);
    }
  });

  it('key_metrics items have metric, value, status fields', () => {
    for (const r of reports) {
      for (const km of r.key_metrics) {
        expect(km.metric).toBeTruthy();
        expect(km.value).toBeTruthy();
        expect(['good', 'fair', 'poor']).toContain(km.status);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8 — buildComplianceSummary (7 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildComplianceSummary', () => {
  const summary = buildComplianceSummary(TENANT, AS_OF);

  it('open_obligations > 0', () => {
    expect(summary.open_obligations).toBeGreaterThan(0);
  });

  it('compliance_score is between 0 and 100', () => {
    expect(summary.compliance_score).toBeGreaterThanOrEqual(0);
    expect(summary.compliance_score).toBeLessThanOrEqual(100);
  });

  it('top_breaches has at least 1 item', () => {
    expect(summary.top_breaches.length).toBeGreaterThanOrEqual(1);
  });

  it('upcoming_obligations has at least 1 item', () => {
    expect(summary.upcoming_obligations.length).toBeGreaterThanOrEqual(1);
  });

  it('remediation_plans has at least 1 item', () => {
    expect(summary.remediation_plans.length).toBeGreaterThanOrEqual(1);
  });

  it('remediation_plan status is within [on_track, delayed, completed]', () => {
    const allowed = new Set(['on_track', 'delayed', 'completed']);
    for (const plan of summary.remediation_plans) {
      expect(allowed.has(plan.status)).toBe(true);
    }
  });

  it('breaches_active >= 0', () => {
    expect(summary.breaches_active).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9 — buildPredictiveForecasts (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPredictiveForecasts', () => {
  const forecasts = buildPredictiveForecasts(TENANT, AS_OF);

  it('returns 12 items — 4 horizons × 3 domains', () => {
    expect(forecasts.length).toBe(12);
  });

  it('every item has horizon, domain, confidence_score', () => {
    for (const f of forecasts) {
      expect(f.horizon).toBeTruthy();
      expect(f.domain).toBeTruthy();
      expect(typeof f.confidence_score).toBe('number');
    }
  });

  it('banking items have banking_forecasts defined', () => {
    const bankingItems = forecasts.filter(f => f.domain === 'banking');
    for (const f of bankingItems) {
      expect(f.banking_forecasts).toBeDefined();
      expect(Array.isArray(f.banking_forecasts)).toBe(true);
    }
  });

  it('insurance items have insurance_forecasts defined', () => {
    const insuranceItems = forecasts.filter(f => f.domain === 'insurance');
    for (const f of insuranceItems) {
      expect(f.insurance_forecasts).toBeDefined();
      expect(Array.isArray(f.insurance_forecasts)).toBe(true);
    }
  });

  it('enterprise items have enterprise_forecasts defined', () => {
    const enterpriseItems = forecasts.filter(f => f.domain === 'enterprise');
    for (const f of enterpriseItems) {
      expect(f.enterprise_forecasts).toBeDefined();
      expect(Array.isArray(f.enterprise_forecasts)).toBe(true);
    }
  });

  it('confidence_score is between 0 and 1', () => {
    for (const f of forecasts) {
      expect(f.confidence_score).toBeGreaterThanOrEqual(0);
      expect(f.confidence_score).toBeLessThanOrEqual(1);
    }
  });

  it('30d forecasts have higher confidence than 180d forecasts (on average)', () => {
    const get30d = forecasts.filter(f => f.horizon === '30d').map(f => f.confidence_score);
    const get180d = forecasts.filter(f => f.horizon === '180d').map(f => f.confidence_score);
    const avg30 = get30d.reduce((a, b) => a + b, 0) / get30d.length;
    const avg180 = get180d.reduce((a, b) => a + b, 0) / get180d.length;
    expect(avg30).toBeGreaterThan(avg180);
  });

  it('key_risks is a non-empty array', () => {
    for (const f of forecasts) {
      expect(Array.isArray(f.key_risks)).toBe(true);
      expect(f.key_risks.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 10 — buildDigitalTwinReports (5 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDigitalTwinReports', () => {
  const reports = buildDigitalTwinReports(TENANT, AS_OF);

  it('returns 4 reports', () => {
    expect(reports.length).toBe(4);
  });

  it('every report has report_id, report_type, title, stress_level', () => {
    for (const r of reports) {
      expect(r.report_id).toBeTruthy();
      expect(r.report_type).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.stress_level).toBeTruthy();
    }
  });

  it('stress_level is within [mild, moderate, severe]', () => {
    const allowed = new Set(['mild', 'moderate', 'severe']);
    for (const r of reports) {
      expect(allowed.has(r.stress_level)).toBe(true);
    }
  });

  it('worst_case_npa_impact_pp > 0', () => {
    for (const r of reports) {
      expect(r.worst_case_npa_impact_pp).toBeGreaterThan(0);
    }
  });

  it('confidence is between 0 and 1', () => {
    for (const r of reports) {
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 11 — buildAutonomousAiReport (6 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAutonomousAiReport', () => {
  const report = buildAutonomousAiReport(TENANT, AS_OF);

  it('total_agent_executions > 0', () => {
    expect(report.total_agent_executions).toBeGreaterThan(0);
  });

  it('automation_rate_pct is between 0 and 100', () => {
    expect(report.automation_rate_pct).toBeGreaterThanOrEqual(0);
    expect(report.automation_rate_pct).toBeLessThanOrEqual(100);
  });

  it('human_override_count < total_agent_executions', () => {
    expect(report.human_override_count).toBeLessThan(report.total_agent_executions);
  });

  it('agent_performance has at least 6 entries', () => {
    expect(report.agent_performance.length).toBeGreaterThanOrEqual(6);
  });

  it('every agent has agent, executions, success_rate, escalations fields', () => {
    for (const agent of report.agent_performance) {
      expect(agent.agent).toBeTruthy();
      expect(typeof agent.executions).toBe('number');
      expect(typeof agent.success_rate).toBe('number');
      expect(typeof agent.escalations).toBe('number');
    }
  });

  it('top_automated_actions has at least 3 items', () => {
    expect(report.top_automated_actions.length).toBeGreaterThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 12 — buildReportSchedules (5 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildReportSchedules', () => {
  const schedules = buildReportSchedules(TENANT, AS_OF);

  it('returns 9 schedules — one per PACK_TYPES', () => {
    expect(schedules.length).toBe(9);
  });

  it('every schedule has schedule_id, report_name, frequency, is_active', () => {
    for (const s of schedules) {
      expect(s.schedule_id).toBeTruthy();
      expect(s.report_name).toBeTruthy();
      expect(s.frequency).toBeTruthy();
      expect(typeof s.is_active).toBe('boolean');
    }
  });

  it('frequency is within SCHEDULE_FREQUENCIES', () => {
    const allowed = new Set(SCHEDULE_FREQUENCIES);
    for (const s of schedules) {
      expect(allowed.has(s.frequency)).toBe(true);
    }
  });

  it('success_rate_pct is between 0 and 100', () => {
    for (const s of schedules) {
      expect(s.success_rate_pct).toBeGreaterThanOrEqual(0);
      expect(s.success_rate_pct).toBeLessThanOrEqual(100);
    }
  });

  it('last_run_status is within [success, failed, skipped]', () => {
    const allowed = new Set(['success', 'failed', 'skipped']);
    for (const s of schedules) {
      expect(allowed.has(s.last_run_status)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 13 — buildExecutiveIntelligenceSummary (8 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildExecutiveIntelligenceSummary', () => {
  const summary = buildExecutiveIntelligenceSummary(TENANT, AS_OF);

  it('confidence_score is between 0 and 1', () => {
    expect(summary.confidence_score).toBeGreaterThanOrEqual(0);
    expect(summary.confidence_score).toBeLessThanOrEqual(1);
  });

  it('board_health_score is between 0 and 100', () => {
    expect(summary.board_health_score).toBeGreaterThanOrEqual(0);
    expect(summary.board_health_score).toBeLessThanOrEqual(100);
  });

  it('top_risks has at least 1 item', () => {
    expect(summary.top_risks.length).toBeGreaterThanOrEqual(1);
  });

  it('top_opportunities has at least 1 item', () => {
    expect(summary.top_opportunities.length).toBeGreaterThanOrEqual(1);
  });

  it('emerging_threats has at least 1 item', () => {
    expect(summary.emerging_threats.length).toBeGreaterThanOrEqual(1);
  });

  it('recommended_actions has at least 1 item', () => {
    expect(summary.recommended_actions.length).toBeGreaterThanOrEqual(1);
  });

  it('every recommended_action has action, priority, owner fields', () => {
    const priorityAllowed = new Set(['immediate', 'this_week', 'this_month']);
    for (const ra of summary.recommended_actions) {
      expect(ra.action).toBeTruthy();
      expect(priorityAllowed.has(ra.priority)).toBe(true);
      expect(ra.owner).toBeTruthy();
    }
  });

  it('executive_narrative is a non-empty string', () => {
    expect(typeof summary.executive_narrative).toBe('string');
    expect(summary.executive_narrative.trim().length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 14 — buildBoardReportingKpis (5 tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildBoardReportingKpis', () => {
  const kpis = buildBoardReportingKpis(TENANT, AS_OF);

  it('total_packs === 9', () => {
    expect(kpis.total_packs).toBe(9);
  });

  it('approved_packs <= total_packs', () => {
    expect(kpis.approved_packs).toBeLessThanOrEqual(kpis.total_packs);
  });

  it('overdue_regulatory >= 0', () => {
    expect(kpis.overdue_regulatory).toBeGreaterThanOrEqual(0);
  });

  it('compliance_score is between 0 and 100', () => {
    expect(kpis.compliance_score).toBeGreaterThanOrEqual(0);
    expect(kpis.compliance_score).toBeLessThanOrEqual(100);
  });

  it('next_board_meeting is a valid YYYY-MM-DD date string', () => {
    expect(kpis.next_board_meeting).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isNaN(new Date(kpis.next_board_meeting).getTime())).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional edge-case and cross-group tests
// ─────────────────────────────────────────────────────────────────────────────

describe('REPORT_FORMATS constant', () => {
  it('contains pdf, excel, csv', () => {
    expect(REPORT_FORMATS).toContain('pdf');
    expect(REPORT_FORMATS).toContain('excel');
    expect(REPORT_FORMATS).toContain('csv');
  });
});

describe('buildRecentGenerations', () => {
  const generations = buildRecentGenerations(TENANT, AS_OF);

  it('returns 6 generation requests', () => {
    expect(generations.length).toBe(6);
  });

  it('every generation has request_id, pack_type, status', () => {
    for (const g of generations) {
      expect(g.request_id).toBeTruthy();
      expect(g.pack_type).toBeTruthy();
      expect(g.status).toBeTruthy();
    }
  });

  it('status is within valid generation statuses', () => {
    const allowed = new Set(['queued', 'generating', 'ready', 'failed']);
    for (const g of generations) {
      expect(allowed.has(g.status)).toBe(true);
    }
  });

  it('formats array contains pdf and excel', () => {
    for (const g of generations) {
      expect(g.formats).toContain('pdf');
      expect(g.formats).toContain('excel');
    }
  });
});

describe('canAccessBoardReportingCenter — additional roles', () => {
  it('returns true for executive', () => {
    expect(canAccessBoardReportingCenter(['executive'])).toBe(true);
  });

  it('returns true for auditor', () => {
    expect(canAccessBoardReportingCenter(['auditor'])).toBe(true);
  });

  it('returns false for unknown_role', () => {
    expect(canAccessBoardReportingCenter(['unknown_role'])).toBe(false);
  });

  it('returns true when at least one role in the array is valid', () => {
    expect(canAccessBoardReportingCenter(['unknown_role', 'admin'])).toBe(true);
  });
});

describe('buildBoardPackLibrary — approved pack fields', () => {
  it('approved packs have non-null approved_by', () => {
    const packs = buildBoardPackLibrary(TENANT, AS_OF);
    const approvedPacks = packs.filter(p => p.approval_status === 'approved' || p.approval_status === 'distributed');
    for (const pack of approvedPacks) {
      expect(pack.approved_by).not.toBeNull();
    }
  });

  it('draft or under_review packs have null approved_by', () => {
    const packs = buildBoardPackLibrary(TENANT, AS_OF);
    const draftOrReview = packs.filter(p => p.approval_status === 'draft' || p.approval_status === 'under_review');
    for (const pack of draftOrReview) {
      expect(pack.approved_by).toBeNull();
    }
  });
});

describe('buildRegulatoryReports — both domains present', () => {
  it('has at least one banking report', () => {
    const reports = buildRegulatoryReports(TENANT, AS_OF);
    expect(reports.some(r => r.domain === 'banking')).toBe(true);
  });

  it('has at least one insurance report', () => {
    const reports = buildRegulatoryReports(TENANT, AS_OF);
    expect(reports.some(r => r.domain === 'insurance')).toBe(true);
  });
});

describe('buildPredictiveForecasts — horizons coverage', () => {
  it('all 4 FORECAST_HORIZONS are represented', () => {
    const forecasts = buildPredictiveForecasts(TENANT, AS_OF);
    const horizons = new Set(forecasts.map(f => f.horizon));
    for (const h of FORECAST_HORIZONS) {
      expect(horizons.has(h)).toBe(true);
    }
  });

  it('all 3 domains are represented', () => {
    const forecasts = buildPredictiveForecasts(TENANT, AS_OF);
    const domains = new Set(forecasts.map(f => f.domain));
    expect(domains.has('banking')).toBe(true);
    expect(domains.has('insurance')).toBe(true);
    expect(domains.has('enterprise')).toBe(true);
  });
});
