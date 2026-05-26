// services/bff/__tests__/audit_m62_smoke.test.ts
//
// M6.2 — Audit Trail smoke
//
// Spec acceptance gates:
//   #1  "Integrity check on the full chain completes in <30 seconds
//        for 1M events"
//   #2  "Tampering of any past event must be detected"
//
// Routes verified:
//   GET  /v1/audit/events
//   GET  /v1/audit/events/:id
//   GET  /v1/audit/integrity                  (M15.2)
//   GET  /v1/audit/correlations               (M15.10)
//   GET  /v1/audit/evidence                   (M15.3 — list)
//   POST /v1/audit/evidence                   (M15.3 — build package)
//   GET  /v1/admin/audit-retention            (T6 — list)
//   POST /v1/admin/audit-retention            (T6 — create policy)

import request from 'supertest';
import {
  defaultAuditTrailStore,
  InMemoryAuditTrailStore,
  type AuditEvent,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

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

// ─────────────────────────────────────────────────────────────────────────
// AT-1: Spec acceptance #1 — verifyChain on 1M events completes < 30s
//
// Notes on the test rig:
//   - We construct a SEPARATE InMemoryAuditTrailStore with cap=1_100_000
//     so the default 5000-event eviction doesn't truncate the chain.
//   - Population time is NOT the gate — only verifyChain. The benchmark
//     run during development showed ~2.7s populate + ~1.4s verify on
//     100k, projecting to ~27s + ~14s for 1M.
//   - The `30_000ms` budget is the literal spec gate.
//   - Test timeout extended to 240s to cover population + verify + slack
//     for slower CI hardware.
// ─────────────────────────────────────────────────────────────────────────
describe('M6.2 — Audit Trail acceptance', () => {
  it('AT-1 SPEC: verifyChain on 1M events completes in <30 seconds (gate)', () => {
    const COUNT = 1_000_000;
    const store = new InMemoryAuditTrailStore({ cap: COUNT + 100 });

    // Populate — not in the perf budget; only the verify is.
    const populateStart = process.hrtime.bigint();
    for (let i = 0; i < COUNT; i++) {
      store.record(
        'BIL',
        {
          actor_username: i % 7 === 0 ? 'alice.admin' : 'bob.analyst',
          actor_role: i % 7 === 0 ? 'admin' : 'risk_analyst',
          action: i % 3 === 0 ? 'config.update' : 'case.opened',
          resource_type: 'config',
          resource_id: `k-${i % 1000}`,
          outcome: 'success',
          severity: 'info',
        },
        // Synthetic ts; monotonically increasing.
        new Date(1700000000000 + i),
      );
    }
    const populateMs = Number(process.hrtime.bigint() - populateStart) / 1e6;

    // The actual spec gate — verifyChain alone.
    const verifyStart = process.hrtime.bigint();
    const result = store.verifyChain('BIL', NOW);
    const verifyMs = Number(process.hrtime.bigint() - verifyStart) / 1e6;

    // eslint-disable-next-line no-console
    console.log(
      `M6.2 perf: populated ${COUNT} in ${populateMs.toFixed(0)}ms, verifyChain ran in ${verifyMs.toFixed(0)}ms (valid=${result.valid})`,
    );
    expect(result.valid).toBe(true);
    expect(result.total_events).toBe(COUNT);
    // SPEC ACCEPTANCE GATE: < 30 seconds
    expect(verifyMs).toBeLessThan(30_000);
  }, 240_000);

  // ─────────────────────────────────────────────────────────────────────
  // AT-2: Spec acceptance #2 — tampering on a PAST event is detected.
  //
  // The chain links event N to event N+1 via prev_hash. Modifying event
  // N's payload changes its hash, which invalidates event N+1's
  // prev_hash, which invalidates event N+2's prev_hash, and so on. So a
  // single byte tampered in the past propagates forward + verifyChain
  // catches it at the FIRST broken link.
  // ─────────────────────────────────────────────────────────────────────
  it('AT-2 SPEC: tampering of any past event is detected by verifyChain', () => {
    const store = new InMemoryAuditTrailStore({ cap: 1000 });
    const t = 'BIL';
    // Build a small chain we can manipulate directly
    for (let i = 0; i < 100; i++) {
      store.record(t, {
        actor_username: 'alice.admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: `k-${i}`,
        outcome: 'success',
        severity: 'info',
      }, new Date(1700000000000 + i));
    }

    // Clean-chain baseline
    const clean = store.verifyChain(t, NOW);
    expect(clean.valid).toBe(true);
    expect(clean.total_events).toBe(100);

    // Reach into the internal array (testing hook) and modify event #42
    // in place — change the actor. Crucially: the row's STORED hash is
    // UNCHANGED, so the verifier will recompute a NEW hash that no
    // longer matches the stored value.
    const eventsArr = (store as unknown as {
      events: Map<string, AuditEvent[]>;
    }).events.get(t)!;
    eventsArr[42]!.actor_username = 'mallory.attacker';

    const tampered = store.verifyChain(t, NOW);
    expect(tampered.valid).toBe(false);
    expect(tampered.broken_at).toBeDefined();
    expect(tampered.broken_at?.index).toBe(42);
    expect(tampered.broken_at?.reason).toBe('hash_mismatch');
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-3: tampering propagates forward — modifying event N also breaks
  // verification of events N+1, N+2 because their prev_hash chain refers
  // back. verifyChain reports the FIRST break.
  // ─────────────────────────────────────────────────────────────────────
  it('AT-3 chain propagation: prev_hash break detected on event N+1 when row N has been removed', () => {
    const store = new InMemoryAuditTrailStore({ cap: 1000 });
    const t = 'BIL';
    for (let i = 0; i < 20; i++) {
      store.record(t, {
        actor_username: 'alice.admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: `k-${i}`,
        outcome: 'success',
        severity: 'info',
      }, new Date(1700000000000 + i));
    }
    const eventsArr = (store as unknown as {
      events: Map<string, AuditEvent[]>;
    }).events.get(t)!;
    // Splice — pretend an attacker deleted event #10. Event #11's
    // prev_hash now points at #9's hash but the verifier expected #10's.
    eventsArr.splice(10, 1);

    const tampered = store.verifyChain(t, NOW);
    expect(tampered.valid).toBe(false);
    expect(tampered.broken_at).toBeDefined();
    // Position 10 in the spliced array is what was #11 — chain breaks
    // at the first event whose prev_hash doesn't match its predecessor.
    expect(tampered.broken_at?.reason).toBe('prev_hash_mismatch');
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-4: GET /v1/audit/integrity HTTP smoke — happy path returns
  // {valid:true} after a clean chain build.
  // ─────────────────────────────────────────────────────────────────────
  it('AT-4 GET /v1/audit/integrity returns valid=true on a clean chain', async () => {
    const { app } = makeSmokeApp();
    // Seed a fresh chain in the BIL slot via the public API. We can
    // either POST /v1/audit/events directly or just rely on the
    // defaultAuditTrailStore's existing seed. Use the existing
    // surface — the smoke test should be drift-resistant.
    await request(app).get('/v1/audit/events').set(H('BIL'));

    const r = await request(app).get('/v1/audit/integrity').set(H('BIL'));
    expect(r.status).toBe(200);
    expect(r.body.body.valid).toBe(true);
    expect(typeof r.body.body.total_events).toBe('number');
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-5: GET /v1/audit/events + filters — multi-axis query
  // ─────────────────────────────────────────────────────────────────────
  it('AT-5 GET /v1/audit/events accepts filters (actor / action / resource_type / severity)', async () => {
    const { app } = makeSmokeApp();
    // Build a few events
    for (let i = 0; i < 5; i++) {
      defaultAuditTrailStore.record('BIL', {
        actor_username: 'alice.admin',
        actor_role: 'admin',
        action: 'config.update',
        resource_type: 'config',
        resource_id: `at5-${i}`,
        outcome: 'success',
        severity: 'info',
      }, NOW);
    }
    // Filter by action
    const byAction = await request(app)
      .get('/v1/audit/events?action=config.update')
      .set(H('BIL'));
    expect(byAction.status).toBe(200);
    expect(Array.isArray(byAction.body.body.items)).toBe(true);
    // Bad outcome → 400 EWS_400_invalid_outcome
    const badOutcome = await request(app)
      .get('/v1/audit/events?outcome=nope')
      .set(H('BIL'));
    expect(badOutcome.status).toBe(400);
    expect(badOutcome.body.error.code).toBe('EWS_400_invalid_outcome');
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-6: POST /v1/audit/evidence — builds an evidence package
  // ─────────────────────────────────────────────────────────────────────
  it('AT-6 POST /v1/audit/evidence builds an immutable package + GET lists it', async () => {
    const { app } = makeSmokeApp();
    // Make sure at least one event exists in the target tenant
    defaultAuditTrailStore.record('BIL', {
      actor_username: 'alice.admin',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'at6-key',
      outcome: 'success',
      severity: 'info',
    }, NOW);

    const build = await request(app)
      .post('/v1/audit/evidence')
      .set(H('BIL'))
      .send({
        actor_username: 'alice.admin',
        action: 'config.update',
      });
    expect(build.status).toBe(201);
    const pkg = build.body.body as { package_id: string; event_count: number; integrity: { chain_verified: boolean } };
    expect(pkg.package_id).toMatch(/^EVD-/);
    expect(pkg.event_count).toBeGreaterThanOrEqual(1);
    expect(pkg.integrity.chain_verified).toBe(true);

    // GET /v1/audit/evidence — newer-first list
    const list = await request(app).get('/v1/audit/evidence').set(H('BIL'));
    expect(list.status).toBe(200);
    const found = (list.body.body.items as Array<{ package_id: string }>).find(
      (x) => x.package_id === pkg.package_id,
    );
    expect(found).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-7: GET /v1/audit/correlations — group events by correlation_id
  // ─────────────────────────────────────────────────────────────────────
  it('AT-7 GET /v1/audit/correlations returns shape envelope', async () => {
    const { app } = makeSmokeApp();
    const r = await request(app).get('/v1/audit/correlations').set(H('BIL'));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.correlations)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-8: POST /v1/admin/audit-retention — create a tenant retention
  // policy. Mirrors the spec "Configure retention" surface.
  // ─────────────────────────────────────────────────────────────────────
  it('AT-8 POST /v1/admin/audit-retention creates a retention policy', async () => {
    const { app } = makeSmokeApp();

    // List the strategies + scopes first
    const strategies = await request(app)
      .get('/v1/admin/audit-retention/strategies')
      .set(H('BIL'));
    expect(strategies.status).toBe(200);
    const validStrategies = strategies.body.body.strategies as string[];
    const validScopes = strategies.body.body.scopes as string[];
    expect(validStrategies.length).toBeGreaterThan(0);
    expect(validScopes.length).toBeGreaterThan(0);

    // Strategies are ['count_cap', 'time_window', 'never_purge']; we use
    // time_window since retention_days is the natural compliance dial.
    const timeWindowStrategy = validStrategies.find((s) => s === 'time_window');
    expect(timeWindowStrategy).toBe('time_window');

    const created = await request(app)
      .post('/v1/admin/audit-retention')
      .set(H('BIL'))
      .send({
        policy_id: `m62-${Date.now()}`,
        scope: validScopes[0],
        strategy: 'time_window',
        retention_days: 365,
        notes: 'M6.2 spec smoke',
      });
    expect([200, 201]).toContain(created.status);
    expect(created.body.body.scope).toBe(validScopes[0]);
    expect(created.body.body.strategy).toBe('time_window');
    expect(created.body.body.retention_days).toBe(365);

    // List should now include it
    const list = await request(app)
      .get('/v1/admin/audit-retention')
      .set(H('BIL'));
    expect(list.status).toBe(200);
    expect(list.body.body.items.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-9: 403 on non-admin role — every audit route requires audit:read
  // ─────────────────────────────────────────────────────────────────────
  it('AT-9 non-admin role gets 403 on /v1/audit/events + /integrity + /evidence + /admin/audit-retention', async () => {
    const { app } = makeSmokeApp();
    const headers = H('BIL', 'field_officer');

    const r1 = await request(app).get('/v1/audit/events').set(headers);
    expect(r1.status).toBe(403);

    const r2 = await request(app).get('/v1/audit/integrity').set(headers);
    expect(r2.status).toBe(403);

    const r3 = await request(app).post('/v1/audit/evidence').set(headers).send({});
    expect(r3.status).toBe(403);

    const r4 = await request(app).get('/v1/admin/audit-retention').set(headers);
    expect(r4.status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────
  // AT-10: cross-tenant isolation — BIL events invisible to BANK_DEMO
  // ─────────────────────────────────────────────────────────────────────
  it('AT-10 BIL audit events invisible to BANK_DEMO', async () => {
    const { app } = makeSmokeApp();
    defaultAuditTrailStore.record('BIL', {
      actor_username: 'alice.admin',
      actor_role: 'admin',
      action: 'config.update',
      resource_type: 'config',
      resource_id: 'cross-tenant-probe-bil',
      outcome: 'success',
      severity: 'info',
    }, NOW);

    const bil = await request(app).get('/v1/audit/events?action=config.update').set(H('BIL'));
    expect(bil.status).toBe(200);
    const bilHas = (bil.body.body.items as Array<{ resource_id: string }>).some(
      (x) => x.resource_id === 'cross-tenant-probe-bil',
    );
    expect(bilHas).toBe(true);

    const bd = await request(app).get('/v1/audit/events?action=config.update').set(H('BANK_DEMO'));
    expect(bd.status).toBe(200);
    const bdHas = (bd.body.body.items as Array<{ resource_id: string }>).some(
      (x) => x.resource_id === 'cross-tenant-probe-bil',
    );
    expect(bdHas).toBe(false);
  });
});
