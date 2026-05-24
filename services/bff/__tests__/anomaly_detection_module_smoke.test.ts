// services/bff/__tests__/anomaly_detection_module_smoke.test.ts
//
// Module 1.5 — Anomaly Detection (AI) smoke test.
//
// Walks the complete user journey end-to-end:
//
//   GET   /v1/anomalies?window=24h&source_id=&severity=&min_score=
//   GET   /v1/anomalies/:id                                       (with time_series + score_100)
//   GET   /v1/anomalies/patterns/config
//   POST  /v1/anomalies/patterns/config
//   POST  /v1/anomalies/rerun
//   POST  /v1/anomalies/inject-spike      (NEW — Module 1.5)
//   POST  /v1/anomalies/:id/investigate   (NEW — Module 1.5)
//   POST  /v1/anomalies/:id/dismiss       (NEW — Module 1.5)
//
// Spec acceptance: inject a 10× spike in a feed → anomaly appears in the
// 24h table within 1 hour with score ≥ 80. This test exercises that path
// end-to-end against the live BFF (in-memory store).
//
// Also exercises:
//   - audit-log write fan-out on inject/investigate/dismiss (cross-cutting #6)
//   - RBAC + tenant-header guards (cross-cutting #12)
//   - 404 / 409 / 400 envelope shapes for the error paths

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { _resetAnomalyStore } from '../src/anomaly_detection';

const NOW = new Date('2026-05-24T14:00:00.000Z');
const TENANT = 'BANK_DEMO';
const HEADERS = {
  'X-Tenant-ID': TENANT,
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
};

function makeSmokeApp(role: string = 'admin') {
  _resetAnomalyStore();
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('Module 1.5 — Anomaly Detection smoke', () => {
  it('walks the full 24h list → inject 10× spike → investigate → dismiss flow', async () => {
    const { app } = makeSmokeApp('admin');

    // 1. Baseline 24h list — seeds 40 deterministic anomalies per tenant.
    // Cap to window=24h + min_score=0.8 → only the critical/high tier.
    const baseline = await request(app)
      .get('/v1/anomalies?window=24h&min_score=80')
      .set(HEADERS);
    expect(baseline.status).toBe(200);
    const baseTotal = baseline.body.body.total;
    expect(typeof baseTotal).toBe('number');
    // Sanity: the baseline list returns the envelope shape with by_severity counters
    expect(baseline.body.body.by_severity).toBeDefined();
    expect(baseline.body.body.by_pattern).toBeDefined();
    expect(baseline.body.body.by_status).toBeDefined();

    // 2. Inject a 10× spike — acceptance path.
    const inject = await request(app)
      .post('/v1/anomalies/inject-spike')
      .set(HEADERS)
      .send({ source_id: 'cbs_txns', multiplier: 10 });
    expect(inject.status).toBe(201);
    const injected = inject.body.body;
    expect(injected.anomaly_id).toMatch(/^anm-BANK_DEMO-\d+-spike/);
    expect(injected.pattern).toBe('txn_volume_spike');
    expect(injected.source_id).toBe('cbs_txns');
    expect(injected.injected).toBe(true);
    // Spec acceptance: score ≥ 80 (0..100 scale) → anomaly_score ≥ 0.80
    expect(injected.anomaly_score).toBeGreaterThanOrEqual(0.80);
    expect(injected.severity).toBe('high'); // 0.85 → high band
    expect(injected.affected_records).toBe(10000); // baseline 1000 × 10 multiplier
    expect(injected.status).toBe('open');
    // Status update ledger contains the inject record
    expect(injected.status_updates).toHaveLength(1);
    expect(injected.status_updates[0].status).toBe('open');
    expect(injected.status_updates[0].notes).toMatch(/Injected 10× spike/);

    // 3. List again with min_score=80 — spike is present.
    const afterInject = await request(app)
      .get('/v1/anomalies?window=24h&min_score=80')
      .set(HEADERS);
    expect(afterInject.status).toBe(200);
    expect(afterInject.body.body.total).toBeGreaterThan(baseTotal);
    const ids = afterInject.body.body.anomalies.map((a: { anomaly_id: string }) => a.anomaly_id);
    expect(ids).toContain(injected.anomaly_id);
    // The injected row's score is ≥ 0.80 (spec ≥ 80)
    const row = afterInject.body.body.anomalies.find((a: { anomaly_id: string }) => a.anomaly_id === injected.anomaly_id);
    expect(row.anomaly_score).toBeGreaterThanOrEqual(0.80);
    expect(row.injected).toBe(true);

    // 4. GET single anomaly — verifies time_series + score_100 are decorated.
    const single = await request(app)
      .get(`/v1/anomalies/${injected.anomaly_id}`)
      .set(HEADERS);
    expect(single.status).toBe(200);
    expect(single.body.body.score_100).toBe(85); // 0.85 × 100
    expect(single.body.body.time_series).toHaveLength(24);
    const outliers = single.body.body.time_series.filter((p: { is_outlier: boolean }) => p.is_outlier);
    expect(outliers).toHaveLength(1);

    // 5. Investigate — cross-link case_id, transitions status to 'investigating'.
    const inv = await request(app)
      .post(`/v1/anomalies/${injected.anomaly_id}/investigate`)
      .set(HEADERS)
      .send({ notes: 'Smoke investigation — open case' });
    expect(inv.status).toBe(200);
    expect(inv.body.body.status).toBe('investigating');
    expect(inv.body.body.case_id).toBe(`case-anom-${injected.anomaly_id}`);
    expect(inv.body.body.status_updates).toHaveLength(2);
    expect(inv.body.body.status_updates[1].status).toBe('investigating');
    expect(inv.body.body.status_updates[1].notes).toMatch(/Smoke investigation/);

    // 6. Double-investigate → 409 already_investigating
    const dupInv = await request(app)
      .post(`/v1/anomalies/${injected.anomaly_id}/investigate`)
      .set(HEADERS)
      .send({});
    expect(dupInv.status).toBe(409);
    expect(dupInv.body.error.code).toBe('EWS_409_already_investigating');

    // 7. Inject a SECOND spike to exercise the dismiss path on a fresh anomaly.
    const inject2 = await request(app)
      .post('/v1/anomalies/inject-spike')
      .set(HEADERS)
      .send({ source_id: 'cbs_repayments', multiplier: 15 });
    expect(inject2.status).toBe(201);
    const anom2 = inject2.body.body.anomaly_id;

    // Dismiss missing reason → 400
    const dismissNoReason = await request(app)
      .post(`/v1/anomalies/${anom2}/dismiss`)
      .set(HEADERS)
      .send({});
    expect(dismissNoReason.status).toBe(400);
    expect(dismissNoReason.body.error.code).toBe('EWS_400_invalid_input');

    // Dismiss with reason → 200
    const dismiss = await request(app)
      .post(`/v1/anomalies/${anom2}/dismiss`)
      .set(HEADERS)
      .send({ reason: 'False positive — expected EOM batch ran late' });
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.body.status).toBe('false_positive');
    expect(dismiss.body.body.status_updates.at(-1).notes).toMatch(/EOM batch/);

    // Double-dismiss → 409
    const dupDismiss = await request(app)
      .post(`/v1/anomalies/${anom2}/dismiss`)
      .set(HEADERS)
      .send({ reason: 'duplicate dismissal attempt' });
    expect(dupDismiss.status).toBe(409);
    expect(dupDismiss.body.error.code).toBe('EWS_409_already_dismissed');

    // 8. Audit-log fan-out — all 3 actions recorded as audit events.
    const audit = await request(app)
      .get('/v1/audit/events?resource_type=system&page_size=50')
      .set(HEADERS);
    expect(audit.status).toBe(200);
    const events = audit.body.body.items as Array<{ action: string; resource_id: string; actor_username: string }>;
    const anomEvents = events.filter((e) =>
      e.action === 'anomaly.inject_spike'
      || e.action === 'anomaly.investigate'
      || e.action === 'anomaly.dismiss',
    );
    expect(anomEvents.length).toBeGreaterThanOrEqual(4);
    const actions = new Set(anomEvents.map((e) => e.action));
    expect(actions.has('anomaly.inject_spike')).toBe(true);
    expect(actions.has('anomaly.investigate')).toBe(true);
    expect(actions.has('anomaly.dismiss')).toBe(true);
    // Actor stamped (X-APEX-USER)
    expect(anomEvents.every((e) => e.actor_username === 'alice.admin')).toBe(true);

    // 9. Rerun detection — generates fresh anomalies for the day.
    const rerun = await request(app)
      .post('/v1/anomalies/rerun')
      .set(HEADERS)
      .send({});
    expect(rerun.status).toBe(201);
    expect(rerun.body.body.tenant_id).toBe(TENANT);
    expect(rerun.body.body.triggered_by).toBe('alice.admin');
    expect(typeof rerun.body.body.new_anomalies).toBe('number');
    expect(rerun.body.body.new_anomalies).toBeGreaterThan(0);
    expect(rerun.body.body.patterns_evaluated).toBeGreaterThanOrEqual(1);

    // 10. Pattern config — GET + POST round-trip.
    const cfgRead = await request(app)
      .get('/v1/anomalies/patterns/config')
      .set(HEADERS);
    expect(cfgRead.status).toBe(200);
    expect(cfgRead.body.body.patterns).toBeDefined();
    expect(cfgRead.body.body.patterns.length).toBeGreaterThan(0);
    const firstPattern = cfgRead.body.body.patterns[0].pattern;

    const cfgUpdate = await request(app)
      .post('/v1/anomalies/patterns/config')
      .set(HEADERS)
      .send({ updates: [{ pattern: firstPattern, enabled: false, threshold: 0.85 }] });
    expect(cfgUpdate.status).toBe(200);
    const updated = cfgUpdate.body.body.patterns.find((p: { pattern: string }) => p.pattern === firstPattern);
    expect(updated.enabled).toBe(false);
    expect(updated.threshold).toBe(0.85);
  });

  it('GET /v1/anomalies window math: window=24h excludes older anomalies', async () => {
    const { app } = makeSmokeApp('admin');
    // The deterministic seed produces anomalies up to 72h back. window=1h
    // should drop most; window=72h captures all.
    const oneHour = await request(app).get('/v1/anomalies?window=1h').set(HEADERS);
    const seventyTwo = await request(app).get('/v1/anomalies?window=72h').set(HEADERS);
    expect(oneHour.status).toBe(200);
    expect(seventyTwo.status).toBe(200);
    expect(seventyTwo.body.body.total).toBeGreaterThan(oneHour.body.body.total);
  });

  it('GET /v1/anomalies bad ?window= → 400 invalid_input', async () => {
    const { app } = makeSmokeApp('admin');
    const r = await request(app).get('/v1/anomalies?window=bogus').set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  it('GET /v1/anomalies bad ?min_score=-5 → 400', async () => {
    const { app } = makeSmokeApp('admin');
    const r = await request(app).get('/v1/anomalies?min_score=-5').set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  it('Unknown anomaly: investigate + dismiss + get all return EWS_404_unknown_anomaly', async () => {
    const { app } = makeSmokeApp('admin');
    const id = 'no_such_anomaly';
    const inv = await request(app).post(`/v1/anomalies/${id}/investigate`).set(HEADERS).send({});
    const dis = await request(app).post(`/v1/anomalies/${id}/dismiss`).set(HEADERS).send({ reason: 'x' });
    const get = await request(app).get(`/v1/anomalies/${id}`).set(HEADERS);
    for (const r of [inv, dis, get]) {
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('EWS_404_unknown_anomaly');
    }
  });

  it('RBAC: field_officer blocked on audit:read routes (list, inject-spike, rerun)', async () => {
    // Note: investigate + dismiss require `cases:log_action`, which
    // field_officer holds by canonical matrix (they log case actions in
    // the field). So those routes legitimately pass auth for
    // field_officer + are tested via 404 elsewhere. The audit:read
    // routes here SHOULD fail-closed for field_officer.
    const { app } = makeSmokeApp('field_officer');
    const block = (s: number) => expect([401, 403]).toContain(s);
    block((await request(app).get('/v1/anomalies').set(HEADERS)).status);
    block(
      (await request(app).post('/v1/anomalies/inject-spike').set(HEADERS).send({})).status,
    );
    block((await request(app).post('/v1/anomalies/rerun').set(HEADERS).send({})).status);
  });

  it('Tenant gate: every route refuses without X-Tenant-ID + X-Channel', async () => {
    const { app } = makeSmokeApp('admin');
    const block = (s: number) => expect([400, 401, 403]).toContain(s);
    block((await request(app).get('/v1/anomalies')).status);
    block((await request(app).post('/v1/anomalies/inject-spike').send({})).status);
    block((await request(app).post('/v1/anomalies/abc/investigate').send({})).status);
    block((await request(app).post('/v1/anomalies/abc/dismiss').send({ reason: 'x' })).status);
  });
});
