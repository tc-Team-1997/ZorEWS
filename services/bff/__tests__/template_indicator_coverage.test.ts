// services/bff/__tests__/template_indicator_coverage.test.ts
//
// T6 M5.14 — Rule template indicator-coverage check.

import request from 'supertest';
import { checkTemplateIndicatorCoverage } from '../src/template_indicator_coverage';
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
    description: o.description ?? 'desc',
    category: o.category ?? 'risk_monitoring',
    vertical: o.vertical ?? 'banking',
    condition_pseudocode: o.condition_pseudocode ?? 'x > 0',
    recommended_severity: o.recommended_severity ?? 'medium',
    recommended_actions: o.recommended_actions ?? ['open_case'],
    supporting_indicators: o.supporting_indicators ?? [],
    source_doc: o.source_doc ?? '',
  };
}

const CATALOG = {
  'FIN-001': { vertical: 'banking' },
  'POL-001': { vertical: 'insurance' },
  'CLM-002': { vertical: 'insurance' },
};

// ─── checkTemplateIndicatorCoverage — pure ───────────────────────────

describe('M5.14 — fully resolved', () => {
  test('every indicator known + vertical matches → fully_resolved', () => {
    const tpl = mkTpl({ id: 't1', vertical: 'banking', supporting_indicators: ['FIN-001'] });
    const r = checkTemplateIndicatorCoverage([tpl], CATALOG);
    expect(r.total_templates).toBe(1);
    expect(r.fully_resolved_count).toBe(1);
    expect(r.has_unknown_count).toBe(0);
    expect(r.templates[0]!.status).toBe('fully_resolved');
    expect(r.templates[0]!.known_count).toBe(1);
    expect(r.templates[0]!.unknown_count).toBe(0);
    expect(r.templates[0]!.vertical_mismatch_count).toBe(0);
  });
});

describe('M5.14 — unknown indicator id', () => {
  test('unknown id → has_unknown status + unknown_count increments', () => {
    const tpl = mkTpl({ id: 't1', vertical: 'banking', supporting_indicators: ['NOT-A-REAL-ID'] });
    const r = checkTemplateIndicatorCoverage([tpl], CATALOG);
    expect(r.has_unknown_count).toBe(1);
    expect(r.templates[0]!.status).toBe('has_unknown');
    expect(r.templates[0]!.unknown_count).toBe(1);
    expect(r.templates[0]!.items[0]!.exists).toBe(false);
    expect(r.templates[0]!.items[0]!.catalog_vertical).toBeNull();
  });
});

describe('M5.14 — vertical mismatch', () => {
  test('banking template referencing insurance indicator → has_mismatch', () => {
    const tpl = mkTpl({ id: 't1', vertical: 'banking', supporting_indicators: ['POL-001'] });
    const r = checkTemplateIndicatorCoverage([tpl], CATALOG);
    expect(r.has_mismatch_count).toBe(1);
    expect(r.templates[0]!.status).toBe('has_mismatch');
    expect(r.templates[0]!.vertical_mismatch_count).toBe(1);
    expect(r.templates[0]!.items[0]!.exists).toBe(true);
    expect(r.templates[0]!.items[0]!.matches_template_vertical).toBe(false);
    expect(r.templates[0]!.items[0]!.catalog_vertical).toBe('insurance');
  });
});

describe('M5.14 — vertical=both accepts either', () => {
  test('template vertical="both" matches banking + insurance indicators', () => {
    const tpl = mkTpl({
      id: 't1',
      vertical: 'both',
      supporting_indicators: ['FIN-001', 'POL-001'],
    });
    const r = checkTemplateIndicatorCoverage([tpl], CATALOG);
    expect(r.templates[0]!.status).toBe('fully_resolved');
    expect(r.templates[0]!.vertical_mismatch_count).toBe(0);
    for (const item of r.templates[0]!.items) {
      expect(item.matches_template_vertical).toBe(true);
    }
  });
});

describe('M5.14 — no_indicators bucket', () => {
  test('template with zero supporting_indicators → no_indicators status', () => {
    const tpl = mkTpl({ id: 't1', vertical: 'banking', supporting_indicators: [] });
    const r = checkTemplateIndicatorCoverage([tpl], CATALOG);
    expect(r.no_indicators_count).toBe(1);
    expect(r.templates[0]!.status).toBe('no_indicators');
    expect(r.templates[0]!.indicators_total).toBe(0);
  });
});

describe('M5.14 — unknown takes precedence over mismatch', () => {
  test('mixed unknown + mismatch → status=has_unknown', () => {
    const tpl = mkTpl({
      id: 't1',
      vertical: 'banking',
      supporting_indicators: ['NOT-A-REAL-ID', 'POL-001'],
    });
    const r = checkTemplateIndicatorCoverage([tpl], CATALOG);
    expect(r.templates[0]!.status).toBe('has_unknown');
    expect(r.templates[0]!.unknown_count).toBe(1);
    expect(r.templates[0]!.vertical_mismatch_count).toBe(1);
  });
});

describe('M5.14 — multi-template aggregation', () => {
  test('envelope counters sum per-status', () => {
    const tpls = [
      mkTpl({ id: 'a', vertical: 'banking', supporting_indicators: ['FIN-001'] }),
      mkTpl({ id: 'b', vertical: 'banking', supporting_indicators: ['NOT-REAL'] }),
      mkTpl({ id: 'c', vertical: 'banking', supporting_indicators: ['POL-001'] }),
      mkTpl({ id: 'd', vertical: 'banking', supporting_indicators: [] }),
    ];
    const r = checkTemplateIndicatorCoverage(tpls, CATALOG);
    expect(r.total_templates).toBe(4);
    expect(r.fully_resolved_count).toBe(1);
    expect(r.has_unknown_count).toBe(1);
    expect(r.has_mismatch_count).toBe(1);
    expect(r.no_indicators_count).toBe(1);
  });
});

describe('M5.14 — default registries', () => {
  test('called with no args → uses real M5.1 templates + M6.2 catalog', () => {
    const r = checkTemplateIndicatorCoverage();
    expect(r.total_templates).toBeGreaterThan(0);
    // The real BIL catalog should have most of its supporting_indicators known.
    // Allow a few "no_indicators" / "has_unknown" entries (templates with no
    // indicators or that reference catalog entries outside STUB_CATALOG).
    // But fully_resolved + no_indicators + has_unknown + has_mismatch should
    // partition the set.
    const sum =
      r.fully_resolved_count + r.has_unknown_count + r.has_mismatch_count + r.no_indicators_count;
    expect(sum).toBe(r.total_templates);
  });
});

// ─── GET /v1/rules/templates/indicator-coverage ──────────────────────

function makeCoverageApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M5.14 — GET /v1/rules/templates/indicator-coverage', () => {
  test('analyst+ → 200 with full report', async () => {
    const { app } = makeCoverageApp('admin');
    const r = await request(app).get('/v1/rules/templates/indicator-coverage').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_templates).toBeGreaterThan(0);
    const sum =
      r.body.body.fully_resolved_count +
      r.body.body.has_unknown_count +
      r.body.body.has_mismatch_count +
      r.body.body.no_indicators_count;
    expect(sum).toBe(r.body.body.total_templates);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCoverageApp('readonly');
    const r = await request(app).get('/v1/rules/templates/indicator-coverage').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeCoverageApp('admin');
    const bil = await request(app).get('/v1/rules/templates/indicator-coverage').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/rules/templates/indicator-coverage')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });
});
