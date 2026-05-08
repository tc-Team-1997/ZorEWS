// Tests for the SLA breach matrix resolver — BAC §3.1.9.1.4.
// Pattern: hand-built MatrixCase[] + SlaConfig[] → assert bucketing,
// breach percentage, severity split, and the fallback resolution.
// Pure function — no DB, no clock.

import {
  buildSlaConfigIndex,
  computeSlaBreachMatrix,
  type MatrixCase,
  type SlaConfig,
} from '../src/dashboard/sla_breach_matrix';

const NOW = new Date('2026-05-08T12:00:00Z');

function cfg(over: Partial<SlaConfig> = {}): SlaConfig {
  return {
    sla_config_id: over.sla_config_id ?? 'cfg-1',
    tenant_id: over.tenant_id ?? 'BANK_DEMO',
    case_category: over.case_category ?? 'credit_risk',
    priority: over.priority ?? 'P2',
    business_unit: over.business_unit ?? null,
    sla_target_days: over.sla_target_days ?? 3,
    status: over.status ?? 'ACTIVE',
  };
}

function caseRow(over: Partial<MatrixCase> & { ageDays: number }): MatrixCase {
  const created = new Date(NOW.getTime() - over.ageDays * 86_400_000).toISOString();
  return {
    case_id: over.case_id ?? `c-${over.ageDays}`,
    // Use `in` to distinguish "explicitly null" from "not set"
    case_category: 'case_category' in over ? over.case_category! : 'credit_risk',
    priority: over.priority ?? 'P2',
    business_unit: 'business_unit' in over ? over.business_unit! : null,
    status: over.status ?? 'OPEN',
    created_at: over.created_at ?? created,
    severity: over.severity,
  };
}

const ALL_CONFIGS: SlaConfig[] = [
  cfg({ case_category: 'credit_risk', priority: 'P1', sla_target_days: 1 }),
  cfg({ case_category: 'credit_risk', priority: 'P2', sla_target_days: 3 }),
  cfg({ case_category: 'credit_risk', priority: 'P3', sla_target_days: 7 }),
  cfg({ case_category: 'credit_risk', priority: 'P4', sla_target_days: 14 }),
  cfg({ case_category: 'fraud',       priority: 'P1', sla_target_days: 0.5 }),
  cfg({ case_category: 'default_fallback', priority: 'P1', sla_target_days: 2 }),
  cfg({ case_category: 'default_fallback', priority: 'P2', sla_target_days: 5 }),
  cfg({ case_category: 'default_fallback', priority: 'P3', sla_target_days: 10 }),
  cfg({ case_category: 'default_fallback', priority: 'P4', sla_target_days: 20 }),
];

describe('computeSlaBreachMatrix', () => {
  it('returns 4 buckets with zero counts on empty input', () => {
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases: [], configs: ALL_CONFIGS, asOf: NOW });
    expect(out.buckets.map((b) => b.label)).toEqual(['0-7 days', '8-30 days', '31-90 days', '90+ days']);
    for (const b of out.buckets) {
      expect(b.total_open).toBe(0);
      expect(b.breached).toBe(0);
      expect(b.breach_pct).toBe(0);
    }
    expect(out.unresolved_count).toBe(0);
  });

  it('buckets cases by age', () => {
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 1, case_id: 'a' }),    // 0-7
      caseRow({ ageDays: 7, case_id: 'b' }),    // 0-7
      caseRow({ ageDays: 8, case_id: 'c' }),    // 8-30
      caseRow({ ageDays: 30, case_id: 'd' }),   // 8-30
      caseRow({ ageDays: 45, case_id: 'e' }),   // 31-90
      caseRow({ ageDays: 91, case_id: 'f' }),   // 90+
      caseRow({ ageDays: 365, case_id: 'g' }),  // 90+
    ];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    expect(out.buckets.find((b) => b.label === '0-7 days')!.total_open).toBe(2);
    expect(out.buckets.find((b) => b.label === '8-30 days')!.total_open).toBe(2);
    expect(out.buckets.find((b) => b.label === '31-90 days')!.total_open).toBe(1);
    expect(out.buckets.find((b) => b.label === '90+ days')!.total_open).toBe(2);
  });

  it('flags breached cases (age > sla_target_days)', () => {
    // P2 credit_risk target is 3 days. Age 5 → breached. Age 2 → on track.
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 2, case_id: 'on-track' }),
      caseRow({ ageDays: 5, case_id: 'breached' }),
    ];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    const b07 = out.buckets.find((b) => b.label === '0-7 days')!;
    expect(b07.total_open).toBe(2);
    expect(b07.breached).toBe(1);
    expect(b07.breach_pct).toBe(50);
  });

  it('breach_pct rounds to one decimal', () => {
    // 1 of 3 breached → 33.3%
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 2, case_id: 'a' }),
      caseRow({ ageDays: 2, case_id: 'b' }),
      caseRow({ ageDays: 5, case_id: 'c' }),  // breached (target=3)
    ];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    const b07 = out.buckets.find((b) => b.label === '0-7 days')!;
    expect(b07.breach_pct).toBe(33.3);
  });

  it('skips closed cases', () => {
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 5, case_id: 'closed', status: 'CLOSED' }),
      caseRow({ ageDays: 5, case_id: 'resolved', status: 'RESOLVED' }),
      caseRow({ ageDays: 5, case_id: 'open', status: 'OPEN' }),
    ];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    expect(out.buckets.find((b) => b.label === '0-7 days')!.total_open).toBe(1);
  });

  it('falls back to default_fallback when category-specific row is missing', () => {
    // Pretend the case has category 'mystery' (no specific config)
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 6, case_id: 'mystery', case_category: 'mystery', priority: 'P2' }),
    ];
    // default_fallback P2 target = 5 → age 6 → breached
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    expect(out.buckets.find((b) => b.label === '0-7 days')!.breached).toBe(1);
  });

  it('counts uncategorised cases (case_category=null)', () => {
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 1, case_category: null, priority: 'P2' }),
      caseRow({ ageDays: 1, case_category: 'credit_risk', priority: 'P2' }),
    ];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    expect(out.uncategorised_count).toBe(1);
    expect(out.unresolved_count).toBe(0);
  });

  it('counts unresolved cases (no config matches at all)', () => {
    const sparseConfigs = ALL_CONFIGS.filter((c) => c.case_category !== 'default_fallback');
    const cases: MatrixCase[] = [caseRow({ ageDays: 1, case_category: 'mystery', priority: 'P2' })];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: sparseConfigs, asOf: NOW });
    expect(out.unresolved_count).toBe(1);
    // unresolved cases are NOT in any bucket
    expect(out.buckets.reduce((s, b) => s + b.total_open, 0)).toBe(0);
  });

  it('severity split — defaults from priority when severity is unset', () => {
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 1, case_id: 'p1a', priority: 'P1' }),  // high
      caseRow({ ageDays: 1, case_id: 'p1b', priority: 'P1' }),  // high
      caseRow({ ageDays: 1, case_id: 'p2',  priority: 'P2' }),  // medium
      caseRow({ ageDays: 1, case_id: 'p3',  priority: 'P3' }),  // medium
      caseRow({ ageDays: 1, case_id: 'p4',  priority: 'P4' }),  // low
    ];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    const b07 = out.buckets.find((b) => b.label === '0-7 days')!;
    expect(b07.severity_split).toEqual({ high: 2, medium: 2, low: 1 });
  });

  it('explicit severity overrides priority-derived severity', () => {
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 1, priority: 'P4', severity: 'high' }),
    ];
    const out = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    expect(out.buckets[0].severity_split.high).toBe(1);
    expect(out.buckets[0].severity_split.low).toBe(0);
  });

  it('business_unit filter scopes to matching cases', () => {
    const cases: MatrixCase[] = [
      caseRow({ ageDays: 1, case_id: 'corp', business_unit: 'CORPORATE' }),
      caseRow({ ageDays: 1, case_id: 'retail', business_unit: 'RETAIL' }),
      caseRow({ ageDays: 1, case_id: 'unknown', business_unit: null }),
    ];
    const out = computeSlaBreachMatrix({
      tenant_id: 'BANK_DEMO',
      cases,
      configs: ALL_CONFIGS,
      asOf: NOW,
      filters: { business_unit: 'CORPORATE' },
    });
    expect(out.buckets[0].total_open).toBe(1);
  });

  it('echoes filters in the response', () => {
    const out = computeSlaBreachMatrix({
      tenant_id: 'BANK_DEMO',
      cases: [],
      configs: ALL_CONFIGS,
      asOf: NOW,
      filters: { branch: 'BR-NRB-01', business_unit: 'CORPORATE' },
    });
    expect(out.filters.tenant_id).toBe('BANK_DEMO');
    expect(out.filters.branch).toBe('BR-NRB-01');
    expect(out.filters.business_unit).toBe('CORPORATE');
    expect(out.filters.as_of).toBe(NOW.toISOString());
  });

  it('is a pure function — same inputs → identical output', () => {
    const cases = [caseRow({ ageDays: 5 })];
    const a = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    const b = computeSlaBreachMatrix({ tenant_id: 'BANK_DEMO', cases, configs: ALL_CONFIGS, asOf: NOW });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildSlaConfigIndex (lookup specificity)', () => {
  it('prefers BU-specific row over the general one', () => {
    const configs: SlaConfig[] = [
      cfg({ sla_config_id: 'general', case_category: 'credit_risk', priority: 'P1', business_unit: null,        sla_target_days: 1 }),
      cfg({ sla_config_id: 'corp',    case_category: 'credit_risk', priority: 'P1', business_unit: 'CORPORATE', sla_target_days: 0.5 }),
    ];
    const lookup = buildSlaConfigIndex(configs);
    expect(lookup('BANK_DEMO', 'credit_risk', 'P1', 'CORPORATE')).toBe(0.5);
    expect(lookup('BANK_DEMO', 'credit_risk', 'P1', null)).toBe(1);
    expect(lookup('BANK_DEMO', 'credit_risk', 'P1', 'RETAIL')).toBe(1); // BU-specific miss → general
  });

  it('falls back to default_fallback when category is missing', () => {
    const configs: SlaConfig[] = [
      cfg({ sla_config_id: 'fb-p2', case_category: 'default_fallback', priority: 'P2', sla_target_days: 5 }),
    ];
    const lookup = buildSlaConfigIndex(configs);
    expect(lookup('BANK_DEMO', 'mystery', 'P2', null)).toBe(5);
    expect(lookup('BANK_DEMO', null, 'P2', null)).toBe(5);
  });

  it('returns undefined when even the fallback row is missing', () => {
    const configs: SlaConfig[] = [
      cfg({ sla_config_id: 'fb-p1', case_category: 'default_fallback', priority: 'P1', sla_target_days: 1 }),
    ];
    const lookup = buildSlaConfigIndex(configs);
    expect(lookup('BANK_DEMO', 'mystery', 'P3', null)).toBeUndefined();
  });

  it('ignores SUPERSEDED + ARCHIVED rows', () => {
    const configs: SlaConfig[] = [
      cfg({ sla_config_id: 'old',    case_category: 'credit_risk', priority: 'P1', sla_target_days: 5, status: 'SUPERSEDED' }),
      cfg({ sla_config_id: 'archive',case_category: 'credit_risk', priority: 'P1', sla_target_days: 99, status: 'ARCHIVED' }),
      cfg({ sla_config_id: 'live',   case_category: 'credit_risk', priority: 'P1', sla_target_days: 1, status: 'ACTIVE' }),
    ];
    const lookup = buildSlaConfigIndex(configs);
    expect(lookup('BANK_DEMO', 'credit_risk', 'P1', null)).toBe(1);
  });
});
