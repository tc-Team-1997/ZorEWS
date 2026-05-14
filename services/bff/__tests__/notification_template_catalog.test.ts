// services/bff/__tests__/notification_template_catalog.test.ts
//
// T6 M10.11 — Unified notification template catalog.

import request from 'supertest';
import { introspectNotificationTemplateCatalog } from '../src/notification_template_catalog';
import { listTemplates as listEmailTemplates } from '../src/notifications/email';
import { listSmsTemplates } from '../src/notifications/sms';
import { listPushTemplates } from '../src/notifications/push';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── introspectNotificationTemplateCatalog — pure ────────────────────

describe('M10.11 — total counts', () => {
  test('total_templates == sum of per-channel counts', () => {
    const cat = introspectNotificationTemplateCatalog();
    const sum = cat.by_channel.email + cat.by_channel.sms + cat.by_channel.push;
    expect(sum).toBe(cat.total_templates);
  });

  test('per-channel counts match the underlying registries', () => {
    const cat = introspectNotificationTemplateCatalog();
    expect(cat.by_channel.email).toBe(listEmailTemplates().length);
    expect(cat.by_channel.sms).toBe(listSmsTemplates().length);
    expect(cat.by_channel.push).toBe(listPushTemplates().length);
  });
});

describe('M10.11 — sort order', () => {
  test('templates sorted by (channel asc, template_id asc)', () => {
    const cat = introspectNotificationTemplateCatalog();
    for (let i = 1; i < cat.templates.length; i += 1) {
      const a = cat.templates[i - 1]!;
      const b = cat.templates[i]!;
      if (a.channel === b.channel) {
        expect(a.template_id.localeCompare(b.template_id)).toBeLessThan(0);
      } else {
        expect(a.channel.localeCompare(b.channel)).toBeLessThan(0);
      }
    }
  });
});

describe('M10.11 — shape', () => {
  test('every entry carries the four required fields', () => {
    const cat = introspectNotificationTemplateCatalog();
    for (const t of cat.templates) {
      expect(['email', 'sms', 'push']).toContain(t.channel);
      expect(typeof t.template_id).toBe('string');
      expect(t.template_id.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(Array.isArray(t.required_vars)).toBe(true);
    }
  });

  test('required_vars arrays are copies (mutation does not pollute the source)', () => {
    const cat = introspectNotificationTemplateCatalog();
    const sample = cat.templates[0]!;
    const originalLen = sample.required_vars.length;
    sample.required_vars.push('mutation');
    const cat2 = introspectNotificationTemplateCatalog();
    expect(cat2.templates[0]!.required_vars.length).toBe(originalLen);
  });
});

describe('M10.11 — distinct_required_vars', () => {
  test('union over every template; sorted asc; non-empty', () => {
    const cat = introspectNotificationTemplateCatalog();
    // Recompute the union manually
    const expected = new Set<string>();
    for (const t of cat.templates) {
      for (const v of t.required_vars) expected.add(v);
    }
    expect(new Set(cat.distinct_required_vars)).toEqual(expected);
    // Sorted asc
    expect(cat.distinct_required_vars).toEqual([...cat.distinct_required_vars].sort());
    // Non-empty since BIL templates do have required vars (e.g. customer_name, case_id)
    expect(cat.distinct_required_vars.length).toBeGreaterThan(0);
  });
});

// ─── GET /v1/notifications/templates/catalog ─────────────────────────

function makeCatalogApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M10.11 — GET /v1/notifications/templates/catalog', () => {
  test('admin → 200 with full unified catalog', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/notifications/templates/catalog').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_templates).toBeGreaterThan(0);
    expect(r.body.body.by_channel.email).toBe(listEmailTemplates().length);
    expect(r.body.body.by_channel.sms).toBe(listSmsTemplates().length);
    expect(r.body.body.by_channel.push).toBe(listPushTemplates().length);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCatalogApp('case_owner');
    const r = await request(app).get('/v1/notifications/templates/catalog').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('platform-static — same response across tenants', async () => {
    const { app } = makeCatalogApp('admin');
    const bil = await request(app).get('/v1/notifications/templates/catalog').set(TH_BIL);
    const bank = await request(app)
      .get('/v1/notifications/templates/catalog')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bil.body.body).toEqual(bank.body.body);
  });

  test('existing M10.1 /v1/notifications/email/templates still works', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/notifications/email/templates').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
