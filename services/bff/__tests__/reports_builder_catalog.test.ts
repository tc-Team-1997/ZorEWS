// services/bff/__tests__/reports_builder_catalog.test.ts
//
// T4.6.1 — Self-service reporting: data source catalog.

import request from 'supertest';
import {
  ALL_REPORT_SCHEMAS,
  REPORT_SOURCE_COUNT,
  ReportCatalogError,
  getReportField,
  getReportSource,
  listReportSources,
  requireReportField,
  requireReportSource,
} from '../src/reports/builder_catalog';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCatalogApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── Catalog shape ────────────────────────────────────────────────────

describe('report builder catalog', () => {
  test('catalog has ≥ 8 sources (mart × 4 + app_* × 3 + audit × 1)', () => {
    expect(REPORT_SOURCE_COUNT).toBeGreaterThanOrEqual(8);
    expect(listReportSources()).toHaveLength(REPORT_SOURCE_COUNT);
  });

  test('every source has required envelope fields', () => {
    for (const src of listReportSources()) {
      expect(src.source_id).toBeTruthy();
      expect(src.display_name).toBeTruthy();
      expect(src.description).toBeTruthy();
      expect(src.schema).toBeTruthy();
      expect(src.table).toBeTruthy();
      expect(src.fields.length).toBeGreaterThan(0);
      expect(typeof src.tenant_scoped).toBe('boolean');
      expect(src.required_role).toBeTruthy();
    }
  });

  test('every source schema in ALL_REPORT_SCHEMAS closed enum', () => {
    for (const src of listReportSources()) {
      expect(ALL_REPORT_SCHEMAS).toContain(src.schema);
    }
  });

  test('source_id is unique', () => {
    const ids = listReportSources().map((s) => s.source_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('source_id matches schema.table convention', () => {
    for (const src of listReportSources()) {
      expect(src.source_id).toBe(`${src.schema}.${src.table}`);
    }
  });

  test('every field has required shape', () => {
    for (const src of listReportSources()) {
      for (const field of src.fields) {
        expect(field.name).toBeTruthy();
        expect(field.display_name).toBeTruthy();
        expect(field.type).toBeTruthy();
        expect(typeof field.filterable).toBe('boolean');
        expect(typeof field.groupable).toBe('boolean');
        expect(typeof field.aggregatable).toBe('boolean');
        expect(typeof field.pii).toBe('boolean');
      }
    }
  });

  test('every field name is unique within source', () => {
    for (const src of listReportSources()) {
      const names = src.fields.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test('every enum-type field declares enum_values', () => {
    for (const src of listReportSources()) {
      for (const field of src.fields) {
        if (field.type === 'enum') {
          expect(field.enum_values).toBeDefined();
          expect(field.enum_values!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('aggregatable invariant: only integer + number fields default aggregatable', () => {
    for (const src of listReportSources()) {
      for (const field of src.fields) {
        // Defaults set via the f() helper — string/boolean/date/datetime/enum
        // never aggregatable unless caller overrode (none do in this catalog).
        if (field.aggregatable) {
          expect(['integer', 'number']).toContain(field.type);
        }
      }
    }
  });

  test('default_filter_fields ⊂ source.fields', () => {
    for (const src of listReportSources()) {
      const fieldNames = new Set(src.fields.map((f) => f.name));
      for (const f of src.default_filter_fields) {
        expect(fieldNames.has(f)).toBe(true);
      }
    }
  });

  test('drill_targets reference real source_ids', () => {
    const validSourceIds = new Set(listReportSources().map((s) => s.source_id));
    for (const src of listReportSources()) {
      for (const drill of src.drill_targets) {
        expect(validSourceIds.has(drill.to_source_id)).toBe(true);
      }
    }
  });

  test('drill via_field exists on both source AND target', () => {
    for (const src of listReportSources()) {
      const srcFields = new Set(src.fields.map((f) => f.name));
      for (const drill of src.drill_targets) {
        const target = getReportSource(drill.to_source_id);
        expect(target).not.toBeNull();
        const targetFields = new Set(target!.fields.map((f) => f.name));
        // The via_field must exist on the SOURCE (so we can read its value
        // and pass it as the filter) and on the TARGET (so we can filter
        // on it). E.g. customer_360.customer_id → loan_360.customer_id.
        expect(srcFields.has(drill.via_field)).toBe(true);
        expect(targetFields.has(drill.via_field)).toBe(true);
      }
    }
  });

  test('mart.customer_360 has expected core fields', () => {
    const src = getReportSource('mart.customer_360')!;
    const names = src.fields.map((f) => f.name);
    expect(names).toContain('customer_id');
    expect(names).toContain('risk_level');
    expect(names).toContain('pd_score');
    expect(names).toContain('exposure_kes');
    expect(names).toContain('has_npa');
  });

  test('app_alerts.alerts is tenant_scoped + alerts:list-required', () => {
    const src = getReportSource('app_alerts.alerts')!;
    expect(src.tenant_scoped).toBe(true);
    expect(src.required_role).toBe('alerts:list');
  });

  test('audit.event_log has 10-resource_type enum matching M15.x', () => {
    const field = getReportField('audit.event_log', 'resource_type')!;
    expect(field.type).toBe('enum');
    expect(field.enum_values).toHaveLength(10);
  });

  test('PII fields flagged on customer-identifying columns', () => {
    const customerIdField = getReportField('mart.customer_360', 'customer_id');
    expect(customerIdField?.pii).toBe(true);
    const nameField = getReportField('mart.customer_360', 'name');
    expect(nameField?.pii).toBe(true);
    const assigneeField = getReportField('app_cases.cases', 'assignee');
    expect(assigneeField?.pii).toBe(true);
  });

  test('tenant_scoped applies to every source (audit chain is also segmented per T4.24 P3)', () => {
    for (const src of listReportSources()) {
      expect(src.tenant_scoped).toBe(true);
    }
  });
});

// ─── Accessors + error paths ──────────────────────────────────────────

describe('catalog accessors', () => {
  test('getReportSource returns null on miss', () => {
    expect(getReportSource('does.not.exist')).toBeNull();
  });

  test('getReportField returns null on missing source', () => {
    expect(getReportField('does.not.exist', 'x')).toBeNull();
  });

  test('getReportField returns null on missing field', () => {
    expect(getReportField('mart.customer_360', 'does_not_exist')).toBeNull();
  });

  test('requireReportSource throws ReportCatalogError on miss', () => {
    expect(() => requireReportSource('does.not.exist')).toThrow(ReportCatalogError);
  });

  test('requireReportField throws on missing field', () => {
    expect(() =>
      requireReportField('mart.customer_360', 'does_not_exist'),
    ).toThrow(ReportCatalogError);
  });

  test('ReportCatalogError carries correct code', () => {
    try {
      requireReportSource('xxx');
    } catch (e) {
      expect((e as ReportCatalogError).code).toBe('unknown_source');
    }
    try {
      requireReportField('mart.customer_360', 'xxx');
    } catch (e) {
      expect((e as ReportCatalogError).code).toBe('unknown_field');
    }
  });
});

// ─── Route ────────────────────────────────────────────────────────────

describe('GET /v1/reports/builder/sources route', () => {
  test('analyst+ → 200 with envelope shape', async () => {
    const { app } = makeCatalogApp('risk_analyst');
    const r = await request(app).get('/v1/reports/builder/sources').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_sources).toBe(REPORT_SOURCE_COUNT);
    expect(Array.isArray(r.body.body.sources)).toBe(true);
  });

  test('admin → 200', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/reports/builder/sources').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeCatalogApp('unknown_role');
    const r = await request(app).get('/v1/reports/builder/sources').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('response includes every catalog source', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/reports/builder/sources').set(TH_BIL);
    expect(r.status).toBe(200);
    const expectedIds = listReportSources().map((s) => s.source_id).sort();
    const actualIds = r.body.body.sources
      .map((s: { source_id: string }) => s.source_id)
      .sort();
    expect(actualIds).toEqual(expectedIds);
  });

  test('platform-static — BIL ↔ BANK_DEMO same shape', async () => {
    const { app } = makeCatalogApp('admin');
    const rBil = await request(app).get('/v1/reports/builder/sources').set(TH_BIL);
    const rBank = await request(app)
      .get('/v1/reports/builder/sources')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(rBil.body.body.total_sources).toBe(rBank.body.body.total_sources);
  });

  test('no tenant header → 400', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app).get('/v1/reports/builder/sources');
    expect(r.status).toBe(400);
  });
});

// ─── Single-source lookup route ───────────────────────────────────────

describe('GET /v1/reports/builder/sources/:source_id route', () => {
  test('admin known source → 200', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app)
      .get('/v1/reports/builder/sources/mart.customer_360')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.source_id).toBe('mart.customer_360');
    expect(r.body.body.fields.length).toBeGreaterThan(0);
  });

  test('unknown source → 404 EWS_404_unknown_source', async () => {
    const { app } = makeCatalogApp('admin');
    const r = await request(app)
      .get('/v1/reports/builder/sources/does.not.exist')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toMatch(/EWS_404/);
  });

  test('analyst+ accepted', async () => {
    const { app } = makeCatalogApp('risk_analyst');
    const r = await request(app)
      .get('/v1/reports/builder/sources/mart.customer_360')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeCatalogApp('unknown_role');
    const r = await request(app)
      .get('/v1/reports/builder/sources/mart.customer_360')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
