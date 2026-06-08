// services/bff/__tests__/evidence_export.test.ts
//
// T6 M15.4 — PDF/Excel evidence export.
//
// Tests CSV and plain-text (branded as .pdf) export routes for
// evidence packages.

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import {
  InMemoryEvidencePackageStore,
  buildEvidencePackage,
} from '../src/audit_evidence';
import {
  InMemoryAuditTrailStore,
  type AuditEventInput,
} from '../src/audit_trail';

const NOW = new Date('2026-06-08T10:00:00.000Z');
const TH_ADMIN = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-role': 'admin' };

// ─── Helpers ──────────────────────────────────────────────────────────

function seedAuditStore(tenant: string = 'BIL'): InMemoryAuditTrailStore {
  const store = new InMemoryAuditTrailStore();
  const events: AuditEventInput[] = [
    {
      actor_username: 'alice.admin',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'alerts.red_sla_hours',
      outcome: 'success',
    },
    {
      actor_username: 'bob.risk',
      actor_role: 'risk_analyst',
      action: 'case.close',
      resource_type: 'case',
      resource_id: 'CASE-001',
      outcome: 'success',
    },
    {
      actor_username: 'alice.admin',
      actor_role: 'admin',
      action: 'config.reset',
      resource_type: 'config',
      resource_id: 'scoring.default_thresholds.low_max',
      outcome: 'success',
    },
  ];
  for (const ev of events) {
    store.record(tenant, ev, NOW);
  }
  return store;
}

function seedEvidence(audit: InMemoryAuditTrailStore, tenant: string = 'BIL') {
  const pkgStore = new InMemoryEvidencePackageStore();
  pkgStore.create(tenant, audit, 'admin', {}, NOW);
  return pkgStore;
}

function makeTestApp(
  audit?: InMemoryAuditTrailStore,
  pkgStore?: InMemoryEvidencePackageStore,
) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    auditTrailStore: audit ?? new InMemoryAuditTrailStore(),
    evidenceStore: pkgStore ?? new InMemoryEvidencePackageStore(),
    now: () => NOW,
  }).app;
}

// ─── GET /v1/audit/evidence/:package_id/export.csv ───────────────────

describe('GET /v1/audit/evidence/:package_id/export.csv', () => {
  test('returns CSV with correct Content-Type and attachment header', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    // First get the list to find the package_id
    const listR = await request(app)
      .get('/v1/audit/evidence')
      .set(TH_ADMIN);
    expect(listR.status).toBe(200);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.csv`)
      .set(TH_ADMIN);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    expect(r.headers['content-disposition']).toMatch(/evidence-.*\.csv/);
  });

  test('CSV has header row + event rows', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    const listR = await request(app).get('/v1/audit/evidence').set(TH_ADMIN);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.csv`)
      .set(TH_ADMIN);

    const lines = (r.text as string).split('\r\n').filter(Boolean);
    // Header + 3 events
    expect(lines.length).toBeGreaterThanOrEqual(4);
    // Header row should have the expected columns
    const header = lines[0]!;
    expect(header).toContain('event_id');
    expect(header).toContain('actor_username');
    expect(header).toContain('action');
    expect(header).toContain('resource_type');
    expect(header).toContain('outcome');
  });

  test('CSV data rows contain expected values', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    const listR = await request(app).get('/v1/audit/evidence').set(TH_ADMIN);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.csv`)
      .set(TH_ADMIN);

    expect(r.text).toContain('alice.admin');
    expect(r.text).toContain('config.update');
    expect(r.text).toContain('success');
  });

  test('unknown package_id → 404', async () => {
    const app = makeTestApp();
    const r = await request(app)
      .get('/v1/audit/evidence/EVD-BIL-NOTREAL-0001/export.csv')
      .set(TH_ADMIN);
    expect(r.status).toBe(404);
  });

  test('cross-tenant package not found → 404', async () => {
    const audit = seedAuditStore('BANK_DEMO');
    const pkgStore = new InMemoryEvidencePackageStore();
    pkgStore.create('BANK_DEMO', audit, 'admin', {}, NOW);
    const app = makeTestApp(audit, pkgStore);

    // Get BANK_DEMO package via BANK_DEMO headers
    const listR = await request(app)
      .get('/v1/audit/evidence')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'x-apex-role': 'admin' });
    const packageId = listR.body.body.items[0].package_id;

    // Now try to access it as BIL → should 404
    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.csv`)
      .set(TH_ADMIN);  // BIL admin
    expect(r.status).toBe(404);
  });

  test('403 for non-admin role', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    const listR = await request(app).get('/v1/audit/evidence').set(TH_ADMIN);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.csv`)
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-role': 'risk_analyst' });
    expect(r.status).toBe(403);
  });
});

// ─── GET /v1/audit/evidence/:package_id/export.pdf ───────────────────

describe('GET /v1/audit/evidence/:package_id/export.pdf', () => {
  test('returns text/plain with inline content-disposition', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    const listR = await request(app).get('/v1/audit/evidence').set(TH_ADMIN);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.pdf`)
      .set(TH_ADMIN);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.headers['content-disposition']).toMatch(/inline/);
    expect(r.headers['content-disposition']).toMatch(/\.pdf/);
  });

  test('body is non-empty printable text containing package info', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    const listR = await request(app).get('/v1/audit/evidence').set(TH_ADMIN);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.pdf`)
      .set(TH_ADMIN);

    // The summary text should contain the tenant id and some event info
    const body = r.text as string;
    expect(body.length).toBeGreaterThan(100);
    expect(body).toContain('BIL');
  });

  test('unknown package_id → 404', async () => {
    const app = makeTestApp();
    const r = await request(app)
      .get('/v1/audit/evidence/EVD-BIL-NOTREAL-0001/export.pdf')
      .set(TH_ADMIN);
    expect(r.status).toBe(404);
  });

  test('403 for non-admin role', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    const listR = await request(app).get('/v1/audit/evidence').set(TH_ADMIN);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}/export.pdf`)
      .set({ 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'x-apex-role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('no-regression: /v1/audit/evidence/:id still returns JSON envelope', async () => {
    const audit = seedAuditStore();
    const pkgStore = seedEvidence(audit);
    const app = makeTestApp(audit, pkgStore);

    const listR = await request(app).get('/v1/audit/evidence').set(TH_ADMIN);
    const packageId = listR.body.body.items[0].package_id;

    const r = await request(app)
      .get(`/v1/audit/evidence/${packageId}`)
      .set(TH_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.package_id).toBe(packageId);
  });
});
