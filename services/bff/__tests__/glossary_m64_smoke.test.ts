// services/bff/__tests__/glossary_m64_smoke.test.ts
//
// M6.4 — Glossary smoke
//
// Spec acceptance:
//   #1  "Glossary search returns results in <500ms"
//   #2  "'?' tooltip in any screen pulls definition from glossary"
//       (proven by the tenant-aware GET /terms/:id route returning the
//        live override OR platform definition for any term — the SPA
//        GlossaryTooltip uses this same route)
//
// Routes verified:
//   GET    /v1/glossary/terms?q=&category=
//   GET    /v1/glossary/terms/:term_id
//   GET    /v1/glossary/categories
//   POST   /v1/glossary/terms                 (M6.4 NEW — admin create)
//   PUT    /v1/glossary/terms/:term_id        (M6.4 NEW — admin update / override)
//   DELETE /v1/glossary/terms/:term_id        (M6.4 NEW — admin tombstone)

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { defaultAuditTrailStore, InMemoryAuditTrailStore } from '../src/audit_trail';
import { _resetGlossaryOverlay, GLOSSARY_TERMS } from '../src/glossary';

const NOW = new Date('2026-05-26T12:00:00.000Z');

function makeSmokeApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: (req) => (req.headers['x-apex-role'] as string) || 'admin',
  });
}

const H = (tenant: string, role = 'admin', user = 'alice.admin') => ({
  'X-Tenant-ID': tenant,
  'X-Channel': 'API',
  'X-APEX-USER': user,
  'X-APEX-ROLE': role,
  'Content-Type': 'application/json',
});

describe('M6.4 — Glossary', () => {
  beforeEach(() => {
    _resetGlossaryOverlay();
    (defaultAuditTrailStore as InMemoryAuditTrailStore).reset();
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-1: GET /v1/glossary/terms — platform seed visible by default
  // ─────────────────────────────────────────────────────────────────────
  it('GL-1 GET /terms returns the platform seed + every term carries source="platform"', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/glossary/terms').set(H('BIL'));
    expect(r.status).toBe(200);
    const terms = r.body.body.terms as Array<{ term_id: string; source: string }>;
    expect(terms.length).toBe(GLOSSARY_TERMS.length);
    for (const t of terms) {
      expect(t.source).toBe('platform');
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-2 SPEC ACCEPTANCE — search returns in <500ms
  //
  // Run 5 searches against the full seed catalog + assert each <500ms.
  // The in-memory store is O(N) over ~24 terms; trivially under budget.
  // ─────────────────────────────────────────────────────────────────────
  it('GL-2 SPEC: search across the catalog completes in <500ms', async () => {
    const { app } = makeSmokeApp();
    const queries = ['NPA', 'shap', 'covenant', 'persistency', 'sma'];
    for (const q of queries) {
      const t0 = process.hrtime.bigint();
      const r = await request(app)
        .get(`/v1/glossary/terms?q=${encodeURIComponent(q)}`)
        .set(H('BIL'));
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      expect(r.status).toBe(200);
      expect(elapsedMs).toBeLessThan(500);
      // Some queries (NPA, sma) MUST match seed entries
      expect((r.body.body.terms as unknown[]).length).toBeGreaterThan(0);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-3 GET /terms/:id — single fetch + 404
  // ─────────────────────────────────────────────────────────────────────
  it('GL-3 GET /terms/:id returns platform term + 404 on unknown', async () => {
    const { app } = makeSmokeApp();
    const hit = await request(app).get('/v1/glossary/terms/npa').set(H('BIL'));
    expect(hit.status).toBe(200);
    expect(hit.body.body.term_id).toBe('npa');
    expect(hit.body.body.source).toBe('platform');

    const miss = await request(app).get('/v1/glossary/terms/does_not_exist').set(H('BIL'));
    expect(miss.status).toBe(404);
    expect(miss.body.error.code).toBe('EWS_404_unknown_term');
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-4 POST /terms — admin creates a tenant-only term + audit fan-out
  // ─────────────────────────────────────────────────────────────────────
  it('GL-4 POST /terms creates a tenant term + writes glossary.term.create audit', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app)
      .post('/v1/glossary/terms')
      .set(H('BIL'))
      .send({
        term_id: 'bil_specific_term',
        term: 'BIL-only term',
        category: 'banking',
        definition: 'A tenant-specific term defined by BIL admin for compliance lookups.',
      });
    expect(r.status).toBe(201);
    expect(r.body.body.term_id).toBe('bil_specific_term');
    expect(r.body.body.source).toBe('tenant');
    expect(r.body.body.updated_by).toBe('alice.admin');

    // GET list reflects it
    const list = await request(app).get('/v1/glossary/terms').set(H('BIL'));
    const found = (list.body.body.terms as Array<{ term_id: string; source: string }>).find(
      (t) => t.term_id === 'bil_specific_term',
    );
    expect(found).toBeDefined();
    expect(found!.source).toBe('tenant');

    // Audit fan-out
    const audit = await request(app)
      .get('/v1/audit/events?action=glossary.term.create')
      .set(H('BIL'));
    expect(audit.status).toBe(200);
    const events = audit.body.body.items as Array<{ resource_id: string; metadata: Record<string, unknown> }>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events.find((e) => e.resource_id === 'bil_specific_term');
    expect(ev).toBeDefined();
    expect(ev!.metadata.category).toBe('banking');
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-5 PUT /terms — admin override of a platform term (copy-on-write)
  // ─────────────────────────────────────────────────────────────────────
  it('GL-5 PUT /terms/:id copy-on-writes platform term → tenant override + audit', async () => {
    const { app } = makeSmokeApp();
    const originalNpa = await request(app).get('/v1/glossary/terms/npa').set(H('BIL'));
    const originalDefinition = originalNpa.body.body.definition as string;

    const updated = await request(app)
      .put('/v1/glossary/terms/npa')
      .set(H('BIL'))
      .send({
        definition: 'BIL custom definition of NPA emphasising the IRDAI insurance-book treatment alongside RBI banking-book NPA classification.',
      });
    expect(updated.status).toBe(200);
    expect(updated.body.body.source).toBe('tenant');
    expect(updated.body.body.definition).not.toBe(originalDefinition);

    // Tenant override visible
    const reread = await request(app).get('/v1/glossary/terms/npa').set(H('BIL'));
    expect(reread.body.body.source).toBe('tenant');

    // Other tenant should still see the original (cross-tenant isolation)
    const bd = await request(app).get('/v1/glossary/terms/npa').set(H('BANK_DEMO'));
    expect(bd.body.body.source).toBe('platform');
    expect(bd.body.body.definition).toBe(originalDefinition);

    // Audit fan-out
    const audit = await request(app)
      .get('/v1/audit/events?action=glossary.term.update')
      .set(H('BIL'));
    expect(audit.body.body.items.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-6 DELETE /terms — tombstone a platform term (hides it in this tenant)
  // ─────────────────────────────────────────────────────────────────────
  it('GL-6 DELETE /terms/:id tombstones a platform term + audit', async () => {
    const { app } = makeSmokeApp();
    const r1 = await request(app).get('/v1/glossary/terms/sma').set(H('BIL'));
    expect(r1.status).toBe(200);

    const del = await request(app).delete('/v1/glossary/terms/sma').set(H('BIL'));
    expect(del.status).toBe(204);

    // Hidden in BIL
    const r2 = await request(app).get('/v1/glossary/terms/sma').set(H('BIL'));
    expect(r2.status).toBe(404);

    // Other tenants still see it
    const bd = await request(app).get('/v1/glossary/terms/sma').set(H('BANK_DEMO'));
    expect(bd.status).toBe(200);

    // Repeat delete → 404 (already tombstoned)
    const del2 = await request(app).delete('/v1/glossary/terms/sma').set(H('BIL'));
    expect(del2.status).toBe(404);

    // Audit fan-out severity=warning since this is a hide operation
    const audit = await request(app)
      .get('/v1/audit/events?action=glossary.term.delete')
      .set(H('BIL'));
    expect(audit.body.body.items.length).toBeGreaterThanOrEqual(1);
    expect(audit.body.body.items[0].severity).toBe('warning');
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-7 POST /terms — validation 400s
  // ─────────────────────────────────────────────────────────────────────
  it('GL-7 POST /terms rejects malformed input with code-routed 400s', async () => {
    const { app } = makeSmokeApp();

    // Missing term_id
    const r1 = await request(app)
      .post('/v1/glossary/terms')
      .set(H('BIL'))
      .send({ term: 'x', category: 'banking', definition: 'long enough definition' });
    expect(r1.status).toBe(400);
    expect(r1.body.error.code).toBe('EWS_400_invalid_term_id');

    // Bad category — term is long enough so the category validator
    // fires next instead of being short-circuited by the term-length check.
    const r2 = await request(app)
      .post('/v1/glossary/terms')
      .set(H('BIL'))
      .send({ term_id: 'tt1', term: 'Valid term', category: 'not_a_cat', definition: 'long enough definition' });
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('EWS_400_invalid_category');

    // Definition too short
    const r3 = await request(app)
      .post('/v1/glossary/terms')
      .set(H('BIL'))
      .send({ term_id: 'tt2', term: 'Valid term', category: 'banking', definition: 'short' });
    expect(r3.status).toBe(400);
    expect(r3.body.error.code).toBe('EWS_400_invalid_definition');
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-8 POST /terms — 409 on platform-term collision
  // ─────────────────────────────────────────────────────────────────────
  it('GL-8 POST /terms returns 409 when term_id collides with a platform term', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app)
      .post('/v1/glossary/terms')
      .set(H('BIL'))
      .send({ term_id: 'npa', term: 'Valid NPA term', category: 'banking', definition: 'long enough definition for npa override' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_platform_term_exists');
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-9 non-admin role 403
  // ─────────────────────────────────────────────────────────────────────
  it('GL-9 unknown_role gets 403 on every M6.4 admin route', async () => {
    const { app } = makeSmokeApp();
    const h = H('BIL', 'unknown_role');

    const r1 = await request(app).post('/v1/glossary/terms').set(h).send({});
    expect(r1.status).toBe(403);

    const r2 = await request(app).put('/v1/glossary/terms/npa').set(h).send({});
    expect(r2.status).toBe(403);

    const r3 = await request(app).delete('/v1/glossary/terms/npa').set(h);
    expect(r3.status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-10 cross-tenant isolation of overlays
  // ─────────────────────────────────────────────────────────────────────
  it('GL-10 tenant overlay is invisible to other tenants', async () => {
    const { app } = makeSmokeApp();
    await request(app)
      .post('/v1/glossary/terms')
      .set(H('BIL'))
      .send({
        term_id: 'bil_only',
        term: 'BIL only term',
        category: 'banking',
        definition: 'Tenant-scoped definition visible only inside BIL admin context.',
      });

    const bil = await request(app).get('/v1/glossary/terms').set(H('BIL'));
    const bilHas = (bil.body.body.terms as Array<{ term_id: string }>).some((t) => t.term_id === 'bil_only');
    expect(bilHas).toBe(true);

    const bd = await request(app).get('/v1/glossary/terms').set(H('BANK_DEMO'));
    const bdHas = (bd.body.body.terms as Array<{ term_id: string }>).some((t) => t.term_id === 'bil_only');
    expect(bdHas).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────
  // GL-11 GET /v1/glossary/categories — 7 canonical categories
  // ─────────────────────────────────────────────────────────────────────
  it('GL-11 GET /v1/glossary/categories returns the 7 canonical categories', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/glossary/categories').set(H('BIL'));
    expect(r.status).toBe(200);
    expect(r.body.body.categories).toEqual([
      'banking', 'regulatory', 'risk', 'ai_ml', 'workflow', 'fraud', 'insurance',
    ]);
  });
});
