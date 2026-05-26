/* M5.3 — Thresholds & Limits smoke.
 *
 * Spec acceptance: "Editing a threshold takes effect on next rule
 * evaluation (within 1 minute) and writes audit event."
 *
 * 6 of 7 spec routes already exist (M4.3/4.4/4.9/4.10/4.12 + check).
 * The new work in M5.3 is wiring audit fan-out on PUT + DELETE so the
 * SPA "last-run banner" + Audit Trail can reconstruct every threshold
 * change. This suite verifies the audit events fan out correctly and
 * regression-tests the 6 existing routes still respond.
 */

import request from 'supertest';
import { defaultAuditTrailStore } from '../src/audit_trail';
import { listThresholds } from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-26T12:00:00.000Z');
const TH_BIL = {
  'x-tenant-id': 'BIL',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};
const TH_BANK = {
  'x-tenant-id': 'BANK_DEMO',
  'x-channel': 'API',
  'x-apex-role': 'admin',
  'x-apex-user': 'alice.admin',
};

function makeSmokeApp() {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => 'admin',
  });
}

function pickIndicator(): string {
  // First indicator from the platform threshold catalogue
  const all = listThresholds();
  if (all.length === 0) throw new Error('no thresholds in seed');
  return all[0]!.indicator_id;
}

describe('M5.3 — audit fan-out on PUT + DELETE', () => {
  it('TL-1: PUT writes a threshold.update audit event with prev + new values', async () => {
    const { app } = makeSmokeApp();
    const id = pickIndicator();

    // GET current effective so we know the "previous_value"
    const cur = await request(app).get(`/v1/indicators/thresholds/${id}`).set(TH_BIL);
    expect(cur.status).toBe(200);
    const previous = cur.body.body;

    // PUT a new override
    const newVal = { yellow_at: 0.4, orange_at: 0.6, red_at: 0.85 };
    const put = await request(app)
      .put(`/v1/indicators/thresholds/${id}`)
      .set(TH_BIL)
      .send(newVal);
    expect(put.status).toBe(200);
    expect(put.body.body.yellow_at).toBe(newVal.yellow_at);

    // Audit event landed
    const audit = defaultAuditTrailStore.list('BIL', {
      action: 'threshold.update',
      resource_type: 'config',
      page: 1,
      page_size: 50,
    });
    const ours = audit.items.find((e) => e.resource_id === id);
    expect(ours).toBeDefined();
    expect(ours!.actor_username).toBe('alice.admin');
    expect(ours!.metadata).toBeTruthy();
    const meta = ours!.metadata as {
      previous_value?: { yellow_at: number } | null;
      new_value: { yellow_at: number; orange_at: number; red_at: number };
      source: string;
    };
    expect(meta.source).toBe('tenant_override');
    expect(meta.new_value.yellow_at).toBe(newVal.yellow_at);
    expect(meta.new_value.orange_at).toBe(newVal.orange_at);
    expect(meta.new_value.red_at).toBe(newVal.red_at);
    if (meta.previous_value) {
      expect(meta.previous_value.yellow_at).toBe(previous.yellow_at);
    }
  });

  it('TL-2: DELETE writes a threshold.reset audit event with prev + default', async () => {
    const { app } = makeSmokeApp();
    const id = pickIndicator();
    // First seed an override so DELETE has something to clear
    await request(app)
      .put(`/v1/indicators/thresholds/${id}`)
      .set(TH_BIL)
      .send({ yellow_at: 0.35, orange_at: 0.55, red_at: 0.8 });
    const del = await request(app).delete(`/v1/indicators/thresholds/${id}`).set(TH_BIL);
    expect(del.status).toBe(204);
    const audit = defaultAuditTrailStore.list('BIL', {
      action: 'threshold.reset',
      resource_type: 'config',
      page: 1,
      page_size: 50,
    });
    const ours = audit.items.find((e) => e.resource_id === id);
    expect(ours).toBeDefined();
    const meta = ours!.metadata as {
      previous_value?: { yellow_at: number } | null;
      default_value?: { yellow_at: number; orange_at: number; red_at: number } | null;
    };
    expect(meta.previous_value?.yellow_at).toBe(0.35);
    expect(meta.default_value).toBeTruthy();
  });

  it('TL-3: DELETE without an override → 404 + no audit event', async () => {
    const { app } = makeSmokeApp();
    const id = pickIndicator();
    // Make sure no override exists — first reset (may 404, that's fine)
    await request(app).delete(`/v1/indicators/thresholds/${id}`).set(TH_BIL);
    const before = defaultAuditTrailStore.list('BIL', {
      action: 'threshold.reset',
      resource_type: 'config',
      page: 1,
      page_size: 50,
    }).items.filter((e) => e.resource_id === id).length;
    const r = await request(app).delete(`/v1/indicators/thresholds/${id}`).set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_no_override');
    const after = defaultAuditTrailStore.list('BIL', {
      action: 'threshold.reset',
      resource_type: 'config',
      page: 1,
      page_size: 50,
    }).items.filter((e) => e.resource_id === id).length;
    expect(after).toBe(before); // no new audit event
  });

  it('TL-4: PUT on BIL never lands in BANK_DEMO audit chain (cross-tenant isolation)', async () => {
    const { app } = makeSmokeApp();
    const id = pickIndicator();
    await request(app)
      .put(`/v1/indicators/thresholds/${id}`)
      .set(TH_BIL)
      .send({ yellow_at: 0.2, orange_at: 0.5, red_at: 0.75 });
    const bank = defaultAuditTrailStore.list('BANK_DEMO', {
      action: 'threshold.update',
      resource_type: 'config',
      page: 1,
      page_size: 50,
    });
    expect(bank.items.find((e) => e.resource_id === id)).toBeUndefined();
  });
});

describe('M5.3 — spec routes regression', () => {
  it('TL-5: GET /v1/indicators/thresholds lists every platform default', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/indicators/thresholds').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items.length).toBeGreaterThan(0);
  });

  it('TL-6: GET /v1/indicators/thresholds/effective surfaces resolution', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/indicators/thresholds/effective').set(TH_BIL);
    expect(r.status).toBe(200);
    // resolveEffectiveThresholds may return entries[] / items[] / rows[] —
    // any array shape under body indicates the resolution worked.
    const body = r.body.body;
    const arr = body.items ?? body.entries ?? body.rows ?? body.thresholds;
    expect(Array.isArray(arr)).toBe(true);
  });

  it('TL-7: GET /v1/indicators/thresholds/drift returns drift envelope', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/indicators/thresholds/drift').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body).toBeTruthy();
  });

  it('TL-8: POST /v1/indicators/thresholds/check classifies values', async () => {
    const { app } = makeSmokeApp();
    const id = pickIndicator();
    const r = await request(app)
      .post('/v1/indicators/thresholds/check')
      .set(TH_BIL)
      .send({ indicator_id: id, value: 0.9 });
    expect(r.status).toBe(200);
    expect(r.body.body).toBeTruthy();
  });

  it('TL-9: POST /v1/indicators/thresholds/:id/suggest returns auto-tune', async () => {
    const { app } = makeSmokeApp();
    const id = pickIndicator();
    const r = await request(app)
      .post(`/v1/indicators/thresholds/${id}/suggest`)
      .set(TH_BIL)
      .send({ values: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] });
    expect(r.status).toBe(200);
    expect(r.body.body).toBeTruthy();
  });
});
