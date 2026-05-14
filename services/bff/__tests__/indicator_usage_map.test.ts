// services/bff/__tests__/indicator_usage_map.test.ts
//
// T6 M4.11 — Indicator usage / orphan detection.

import request from 'supertest';
import { mapIndicatorUsage } from '../src/indicator_usage_map';
import type { RuleTemplate } from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkTpl(o: Partial<RuleTemplate> & { id: string }): RuleTemplate {
  return {
    id: o.id,
    name: o.name ?? `Tpl ${o.id}`,
    description: 'desc',
    category: o.category ?? 'risk_monitoring',
    vertical: o.vertical ?? 'banking',
    condition_pseudocode: 'x > 0',
    recommended_severity: 'medium',
    recommended_actions: ['open_case'],
    supporting_indicators: o.supporting_indicators ?? [],
    source_doc: '',
  };
}

const CATALOG = {
  'FIN-001': { vertical: 'banking', weight: 0.9, name: 'DPD' },
  'POL-001': { vertical: 'insurance', weight: 0.7, name: 'Lapse' },
  'ORPHAN-1': { vertical: 'banking', weight: 0.5, name: 'Orphan banking' },
};

// ─── mapIndicatorUsage — pure ────────────────────────────────────────

describe('M4.11 — empty templates', () => {
  test('zero templates → every indicator is orphaned', () => {
    const r = mapIndicatorUsage(CATALOG, []);
    expect(r.total_indicators).toBe(3);
    expect(r.orphaned_count).toBe(3);
    for (const i of r.indicators) expect(i.reference_count).toBe(0);
  });
});

describe('M4.11 — single template reference', () => {
  test('one template references FIN-001 → FIN-001.reference_count=1', () => {
    const tpls = [mkTpl({ id: 't1', vertical: 'banking', supporting_indicators: ['FIN-001'] })];
    const r = mapIndicatorUsage(CATALOG, tpls);
    const fin = r.indicators.find((i) => i.indicator_id === 'FIN-001')!;
    expect(fin.reference_count).toBe(1);
    expect(fin.referenced_by_templates[0]!.template_id).toBe('t1');
    expect(fin.referenced_by_templates[0]!.vertical_matches).toBe(true);
    // Other indicators stay orphaned
    expect(r.orphaned_count).toBe(2);
  });
});

describe('M4.11 — vertical mismatch surfaces', () => {
  test('banking template referencing insurance indicator → vertical_matches=false', () => {
    const tpls = [mkTpl({ id: 't1', vertical: 'banking', supporting_indicators: ['POL-001'] })];
    const r = mapIndicatorUsage(CATALOG, tpls);
    const pol = r.indicators.find((i) => i.indicator_id === 'POL-001')!;
    expect(pol.reference_count).toBe(1);
    expect(pol.referenced_by_templates[0]!.vertical_matches).toBe(false);
  });
});

describe('M4.11 — vertical=both accepts either', () => {
  test('template vertical=both → vertical_matches=true for any indicator', () => {
    const tpls = [
      mkTpl({ id: 't1', vertical: 'both', supporting_indicators: ['FIN-001', 'POL-001'] }),
    ];
    const r = mapIndicatorUsage(CATALOG, tpls);
    for (const i of r.indicators) {
      if (i.indicator_id === 'ORPHAN-1') continue;
      expect(i.referenced_by_templates[0]!.vertical_matches).toBe(true);
    }
  });
});

describe('M4.11 — multi-template + orphan invariant', () => {
  test('reference_counts aggregate; orphan count = template-less indicators', () => {
    const tpls = [
      mkTpl({ id: 'a', vertical: 'banking', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'b', vertical: 'banking', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'c', vertical: 'insurance', supporting_indicators: ['POL-001'] }),
    ];
    const r = mapIndicatorUsage(CATALOG, tpls);
    expect(r.indicators.find((i) => i.indicator_id === 'FIN-001')!.reference_count).toBe(2);
    expect(r.indicators.find((i) => i.indicator_id === 'POL-001')!.reference_count).toBe(1);
    expect(r.indicators.find((i) => i.indicator_id === 'ORPHAN-1')!.reference_count).toBe(0);
    expect(r.orphaned_count).toBe(1); // ORPHAN-1
  });
});

describe('M4.11 — most_referenced top-5', () => {
  test('top-5 sorted by reference_count desc + indicator_id asc tie-break', () => {
    const tpls = [
      mkTpl({ id: 'a', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'b', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'c', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'd', supporting_indicators: ['POL-001'] }),
    ];
    const r = mapIndicatorUsage(CATALOG, tpls);
    expect(r.most_referenced[0]!.indicator_id).toBe('FIN-001');
    expect(r.most_referenced[0]!.reference_count).toBe(3);
    expect(r.most_referenced[1]!.indicator_id).toBe('POL-001');
  });
});

describe('M4.11 — by_vertical counts', () => {
  test('verticals enumerated correctly', () => {
    const r = mapIndicatorUsage(CATALOG, []);
    expect(r.by_vertical.banking).toBe(2); // FIN-001 + ORPHAN-1
    expect(r.by_vertical.insurance).toBe(1); // POL-001
    expect(r.by_vertical.both).toBe(0);
    expect(r.by_vertical.other).toBe(0);
  });
});

describe('M4.11 — referenced_by_templates sort', () => {
  test('per-indicator references sorted by template_id asc', () => {
    const tpls = [
      mkTpl({ id: 'c_late', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'a_early', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'b_mid', supporting_indicators: ['FIN-001'] }),
    ];
    const r = mapIndicatorUsage(CATALOG, tpls);
    const fin = r.indicators.find((i) => i.indicator_id === 'FIN-001')!;
    expect(fin.referenced_by_templates.map((t) => t.template_id)).toEqual(['a_early', 'b_mid', 'c_late']);
  });
});

describe('M4.11 — default registries integration', () => {
  test('called with no args → uses real M6.2 catalog + M5.1 templates', () => {
    const r = mapIndicatorUsage();
    expect(r.total_indicators).toBeGreaterThan(0);
    // The real catalog has 17 indicators; some are referenced, some are not.
    // The orphaned + referenced count should partition the total.
    const refCounts = new Map<number, number>();
    for (const i of r.indicators) {
      refCounts.set(i.reference_count, (refCounts.get(i.reference_count) ?? 0) + 1);
    }
    const orphans = refCounts.get(0) ?? 0;
    expect(orphans).toBe(r.orphaned_count);
  });
});

// ─── GET /v1/indicators/usage ────────────────────────────────────────

function makeUsageApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M4.11 — GET /v1/indicators/usage', () => {
  test('admin → 200 with full report', async () => {
    const { app } = makeUsageApp('admin');
    const r = await request(app).get('/v1/indicators/usage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_indicators).toBeGreaterThan(0);
    expect(Array.isArray(r.body.body.indicators)).toBe(true);
    expect(Array.isArray(r.body.body.most_referenced)).toBe(true);
    expect(r.body.body.most_referenced.length).toBeLessThanOrEqual(5);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeUsageApp('readonly');
    const r = await request(app).get('/v1/indicators/usage').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeUsageApp('admin');
    const bil = await request(app).get('/v1/indicators/usage').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/indicators/usage')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });
});
