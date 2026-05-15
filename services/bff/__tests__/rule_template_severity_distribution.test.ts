// services/bff/__tests__/rule_template_severity_distribution.test.ts
//
// T6 M5.16 — Rule template severity distribution.

import request from 'supertest';
import { buildTemplateSeverityDistribution } from '../src/rule_template_severity_distribution';
import {
  RULE_TEMPLATES,
  type RecommendedSeverity,
  type RuleTemplateCategory,
  type RuleTemplateVertical,
} from '../src/rule_templates';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── buildTemplateSeverityDistribution — pure ───────────────────────

describe('M5.16 — distribution shape', () => {
  test('total_templates matches library size', () => {
    const s = buildTemplateSeverityDistribution();
    expect(s.total_templates).toBe(RULE_TEMPLATES.length);
  });

  test('every severity emitted even when zero templates use it', () => {
    const s = buildTemplateSeverityDistribution();
    const expected: RecommendedSeverity[] = ['critical', 'high', 'medium', 'low'];
    expect(s.severities.map((r) => r.severity)).toEqual(expected);
  });

  test('per-row total_count agrees with manual library scan', () => {
    const s = buildTemplateSeverityDistribution();
    for (const row of s.severities) {
      const manual = RULE_TEMPLATES.filter((t) => t.recommended_severity === row.severity).length;
      expect(row.total_count).toBe(manual);
    }
  });

  test('sum of total_count across severities = total_templates', () => {
    const s = buildTemplateSeverityDistribution();
    const sum = s.severities.reduce((acc, r) => acc + r.total_count, 0);
    expect(sum).toBe(s.total_templates);
  });

  test('per-row by_category sums to total_count', () => {
    const s = buildTemplateSeverityDistribution();
    for (const row of s.severities) {
      const sum = Object.values(row.by_category).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.total_count);
    }
  });

  test('per-row by_vertical sums to total_count', () => {
    const s = buildTemplateSeverityDistribution();
    for (const row of s.severities) {
      const sum = Object.values(row.by_vertical).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.total_count);
    }
  });

  test('every by_category key present even when zero', () => {
    const s = buildTemplateSeverityDistribution();
    const expectedKeys: RuleTemplateCategory[] = [
      'risk_monitoring',
      'fraud_detection',
      'compliance',
      'operational',
      'underwriting',
    ];
    for (const row of s.severities) {
      for (const k of expectedKeys) {
        expect(row.by_category).toHaveProperty(k);
        expect(typeof row.by_category[k]).toBe('number');
      }
    }
  });

  test('every by_vertical key present even when zero', () => {
    const s = buildTemplateSeverityDistribution();
    const expectedKeys: RuleTemplateVertical[] = ['banking', 'insurance', 'both'];
    for (const row of s.severities) {
      for (const k of expectedKeys) {
        expect(row.by_vertical).toHaveProperty(k);
        expect(typeof row.by_vertical[k]).toBe('number');
      }
    }
  });

  test('per-row template_ids sorted asc', () => {
    const s = buildTemplateSeverityDistribution();
    for (const row of s.severities) {
      expect([...row.template_ids].sort()).toEqual(row.template_ids);
    }
  });

  test('per-row template_ids ⊂ library', () => {
    const s = buildTemplateSeverityDistribution();
    const libraryIds = new Set(RULE_TEMPLATES.map((t) => t.id));
    for (const row of s.severities) {
      for (const id of row.template_ids) {
        expect(libraryIds.has(id)).toBe(true);
      }
      expect(row.template_ids.length).toBe(row.total_count);
    }
  });

  test('every template appears in exactly one severity bucket', () => {
    const s = buildTemplateSeverityDistribution();
    const allIds: string[] = [];
    for (const row of s.severities) allIds.push(...row.template_ids);
    expect(allIds.sort()).toEqual([...RULE_TEMPLATES.map((t) => t.id)].sort());
  });
});

describe('M5.16 — most_common_severity', () => {
  test('points at the row with the highest total_count', () => {
    const s = buildTemplateSeverityDistribution();
    if (s.most_common_severity !== null) {
      const max = Math.max(...s.severities.map((r) => r.total_count));
      const matched = s.severities.find((r) => r.severity === s.most_common_severity)!;
      expect(matched.total_count).toBe(max);
      expect(max).toBeGreaterThan(0);
    }
  });

  test('not null for the populated default library', () => {
    const s = buildTemplateSeverityDistribution();
    expect(s.most_common_severity).not.toBeNull();
  });
});

describe('M5.16 — unused_severities', () => {
  test('only zero-count severities surface, in canonical order', () => {
    const s = buildTemplateSeverityDistribution();
    for (const sev of s.unused_severities) {
      const row = s.severities.find((r) => r.severity === sev)!;
      expect(row.total_count).toBe(0);
    }
    // Reverse direction: any zero-count row appears in unused_severities
    for (const row of s.severities) {
      if (row.total_count === 0) {
        expect(s.unused_severities).toContain(row.severity);
      } else {
        expect(s.unused_severities).not.toContain(row.severity);
      }
    }
  });
});

describe('M5.16 — canonical severity order', () => {
  test('iteration is critical → high → medium → low', () => {
    const s = buildTemplateSeverityDistribution();
    const order: RecommendedSeverity[] = ['critical', 'high', 'medium', 'low'];
    expect(s.severities.map((r) => r.severity)).toEqual(order);
  });
});

// ─── GET /v1/rules/templates/severity-distribution ───────────────────

function makeDistApp(role = 'risk_analyst') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M5.16 — GET /v1/rules/templates/severity-distribution', () => {
  test('analyst+ → 200 with full distribution', async () => {
    const { app } = makeDistApp('risk_analyst');
    const r = await request(app)
      .get('/v1/rules/templates/severity-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_templates).toBe(RULE_TEMPLATES.length);
    expect(r.body.body.severities.length).toBe(4);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDistApp('case_owner');
    const r = await request(app)
      .get('/v1/rules/templates/severity-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same response', async () => {
    const { app } = makeDistApp('admin');
    const bil = await request(app)
      .get('/v1/rules/templates/severity-distribution')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/rules/templates/severity-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M5.15 /v1/rules/templates/action-inventory still works (sibling)', async () => {
    const { app } = makeDistApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/action-inventory')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
