// services/bff/__tests__/notification_variable_index.test.ts
//
// T6 M10.13 — Notification template variable cross-reference.

import request from 'supertest';
import { buildNotificationVariableIndex } from '../src/notification_variable_index';
import { introspectNotificationTemplateCatalog } from '../src/notification_template_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── buildNotificationVariableIndex — pure ───────────────────────────

describe('M10.13 — buildNotificationVariableIndex', () => {
  test('total_templates matches the catalog', () => {
    const idx = buildNotificationVariableIndex();
    const catalog = introspectNotificationTemplateCatalog();
    expect(idx.total_templates).toBe(catalog.total_templates);
  });

  test('total_variables matches the catalog distinct_required_vars count', () => {
    const idx = buildNotificationVariableIndex();
    const catalog = introspectNotificationTemplateCatalog();
    expect(idx.total_variables).toBe(catalog.distinct_required_vars.length);
  });

  test('every variable in the catalog appears in the index', () => {
    const idx = buildNotificationVariableIndex();
    const catalog = introspectNotificationTemplateCatalog();
    const idxNames = new Set(idx.variables.map((v) => v.variable));
    for (const v of catalog.distinct_required_vars) {
      expect(idxNames.has(v)).toBe(true);
    }
  });

  test('reference_count matches manual library scan per variable', () => {
    const idx = buildNotificationVariableIndex();
    const catalog = introspectNotificationTemplateCatalog();
    for (const row of idx.variables) {
      const manualCount = catalog.templates.filter((t) =>
        t.required_vars.includes(row.variable),
      ).length;
      expect(row.reference_count).toBe(manualCount);
    }
  });

  test('per-row templates sorted by (channel asc, template_id asc)', () => {
    const idx = buildNotificationVariableIndex();
    for (const row of idx.variables) {
      for (let i = 1; i < row.templates.length; i++) {
        const prev = row.templates[i - 1]!;
        const curr = row.templates[i]!;
        if (prev.channel !== curr.channel) {
          expect(prev.channel < curr.channel).toBe(true);
        } else {
          expect(prev.template_id < curr.template_id).toBe(true);
        }
      }
    }
  });

  test('variables sorted by reference_count desc with variable name asc tie-break', () => {
    const idx = buildNotificationVariableIndex();
    for (let i = 1; i < idx.variables.length; i++) {
      const prev = idx.variables[i - 1]!;
      const curr = idx.variables[i]!;
      if (prev.reference_count === curr.reference_count) {
        expect(prev.variable < curr.variable).toBe(true);
      } else {
        expect(prev.reference_count).toBeGreaterThan(curr.reference_count);
      }
    }
  });

  test('channels[] is correct subset matching template channels', () => {
    const idx = buildNotificationVariableIndex();
    for (const row of idx.variables) {
      // From template list
      const expected = Array.from(new Set(row.templates.map((t) => t.channel))).sort();
      const actual = [...row.channels].sort();
      expect(actual).toEqual(expected);
    }
  });

  test('channels[] follows declared order (email → sms → push)', () => {
    const idx = buildNotificationVariableIndex();
    // Declared ALL_CHANNELS order = email, sms, push
    const declaredIndex: Record<string, number> = { email: 0, sms: 1, push: 2 };
    for (const row of idx.variables) {
      for (let i = 1; i < row.channels.length; i++) {
        const prev = row.channels[i - 1]!;
        const curr = row.channels[i]!;
        expect(declaredIndex[prev]).toBeLessThan(declaredIndex[curr]!);
      }
    }
  });

  test('spans_all_channels is true iff channels covers email+sms+push', () => {
    const idx = buildNotificationVariableIndex();
    for (const row of idx.variables) {
      const expected =
        row.channels.includes('email')
        && row.channels.includes('sms')
        && row.channels.includes('push');
      expect(row.spans_all_channels).toBe(expected);
    }
  });

  test('single_use_variables only contains reference_count===1 rows', () => {
    const idx = buildNotificationVariableIndex();
    for (const v of idx.single_use_variables) {
      const row = idx.variables.find((r) => r.variable === v)!;
      expect(row.reference_count).toBe(1);
    }
    // Reverse direction
    for (const row of idx.variables) {
      if (row.reference_count === 1) {
        expect(idx.single_use_variables).toContain(row.variable);
      } else {
        expect(idx.single_use_variables).not.toContain(row.variable);
      }
    }
  });

  test('shared_variables only contains spans_all_channels rows', () => {
    const idx = buildNotificationVariableIndex();
    for (const v of idx.shared_variables) {
      const row = idx.variables.find((r) => r.variable === v)!;
      expect(row.spans_all_channels).toBe(true);
    }
    // Reverse direction
    for (const row of idx.variables) {
      if (row.spans_all_channels) {
        expect(idx.shared_variables).toContain(row.variable);
      } else {
        expect(idx.shared_variables).not.toContain(row.variable);
      }
    }
  });

  test('most_referenced points at the top row', () => {
    const idx = buildNotificationVariableIndex();
    if (idx.most_referenced !== null) {
      expect(idx.most_referenced).toBe(idx.variables[0]!.variable);
    }
  });

  test('total reference_count across all rows = Σ unique-var-per-template', () => {
    const idx = buildNotificationVariableIndex();
    const catalog = introspectNotificationTemplateCatalog();
    let expected = 0;
    for (const t of catalog.templates) {
      expected += new Set(t.required_vars).size;
    }
    const actual = idx.variables.reduce((sum, r) => sum + r.reference_count, 0);
    expect(actual).toBe(expected);
  });

  test('total_variables > 0 (catalog has at least one variable)', () => {
    const idx = buildNotificationVariableIndex();
    expect(idx.total_variables).toBeGreaterThan(0);
    expect(idx.most_referenced).not.toBeNull();
  });
});

// ─── GET /v1/notifications/variables/index ───────────────────────────

function makeIndexApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M10.13 — GET /v1/notifications/variables/index', () => {
  test('admin → 200 with full index', async () => {
    const { app } = makeIndexApp('admin');
    const r = await request(app).get('/v1/notifications/variables/index').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_variables).toBeGreaterThan(0);
    expect(r.body.body.variables.length).toBe(r.body.body.total_variables);
  });

  test('analyst-tier role accepted (audit:read)', async () => {
    const { app } = makeIndexApp('risk_analyst');
    const r = await request(app).get('/v1/notifications/variables/index').set(TH_BIL);
    // audit:read is admin-only — risk_analyst should be denied.
    expect(r.status).toBe(403);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeIndexApp('case_owner');
    const r = await request(app).get('/v1/notifications/variables/index').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static: BIL and BANK_DEMO see the same index', async () => {
    const { app } = makeIndexApp('admin');
    const bil = await request(app).get('/v1/notifications/variables/index').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/notifications/variables/index')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('M10.11 /v1/notifications/templates/catalog still works (sibling route)', async () => {
    const { app } = makeIndexApp('admin');
    const r = await request(app).get('/v1/notifications/templates/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
