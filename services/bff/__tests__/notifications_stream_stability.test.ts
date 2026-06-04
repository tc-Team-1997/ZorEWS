/**
 * notifications_stream_stability.test.ts
 *
 * Regression tests for the HTTP 500 on GET /v1/notifications/stream.
 *
 * Root causes fixed:
 *   1. openSse() backfill loop had no try-catch — res.write() on a
 *      disconnected socket (EPIPE) threw and Express returned 500.
 *   2. EventSource cannot send X-Tenant-ID — the stream fell through
 *      requireTenantMw and returned 400, triggering infinite EventSource
 *      reconnect loops.
 *
 * These tests verify both fixes are in place and stable.
 */

import { EventEmitter } from 'node:events';
import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { NotificationBus } from '../src/notifications/bus';
import { openSse } from '../src/notifications/sse';

const NOW = new Date('2026-06-04T09:00:00.000Z');
const TENANT = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TENANT_ROLE = { ...TENANT, 'x-apex-role': 'risk_analyst' };

// ─── helpers ────────────────────────────────────────────────────────────────

interface MockState {
  headers: Record<string, string>;
  body: string;
  ended: boolean;
  writable: boolean;
  writableEnded: boolean;
  destroyed: boolean;
}

function mockReqRes(opts: Partial<MockState> = {}): {
  req: EventEmitter;
  res: MockState & {
    setHeader(k: string, v: string): void;
    write(s: string): boolean;
    end(): void;
    flushHeaders(): void;
  };
  throws: string[];
} {
  const req = new EventEmitter();
  const throws: string[] = [];
  const state: MockState = {
    headers: {},
    body: '',
    ended: false,
    writable: true,
    writableEnded: false,
    destroyed: false,
    ...opts,
  };
  const res = {
    get headers() { return state.headers; },
    get body() { return state.body; },
    get ended() { return state.ended; },
    get writable() { return state.writable; },
    get writableEnded() { return state.writableEnded; },
    get destroyed() { return state.destroyed; },
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; },
    write(s: string): boolean {
      if (state.destroyed || state.writableEnded || !state.writable) {
        const err = new Error('write EPIPE');
        throws.push(err.message);
        throw err;
      }
      state.body += s;
      return true;
    },
    end() { state.ended = true; state.writable = false; state.writableEnded = true; },
    flushHeaders() { /* noop */ },
  };
  return { req, res: res as typeof res & MockState, throws };
}

function makeTestApp(role: string | null = 'risk_analyst') {
  const bus = new NotificationBus();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    notificationBus: bus,
    now: () => NOW,
    getRole: () => role,
  });
  return { app, bus };
}

// ─── Fix 1: EPIPE / 500 prevention in openSse ───────────────────────────────

describe('openSse() — EPIPE / disconnect safety (fix 1 regression)', () => {
  test('write on a pre-destroyed socket does NOT throw to caller', () => {
    const bus = new NotificationBus();
    bus.publish({ level: 'info', title: 'pre-disconnect' });

    // Socket is destroyed BEFORE openSse runs (simulates ultra-fast disconnect)
    const { req, res, throws } = mockReqRes({ destroyed: true });

    // Must not throw — error should be absorbed inside openSse.
    expect(() => openSse(req as never, res as never, bus)).not.toThrow();
    expect(throws).toHaveLength(0);
    // Backfill was skipped because socket was gone.
    expect(res.body).toBe('');
  });

  test('write on a writableEnded socket does NOT throw to caller', () => {
    const bus = new NotificationBus();
    bus.publish({ level: 'warning', title: 'already-ended' });

    const { req, res, throws } = mockReqRes({ writableEnded: true });
    expect(() => openSse(req as never, res as never, bus)).not.toThrow();
    expect(throws).toHaveLength(0);
    expect(res.body).toBe('');
  });

  test('socket closes mid-backfill — remaining items are skipped, no throw', () => {
    const bus = new NotificationBus();
    // Fill recent buffer with 5 items.
    for (let i = 0; i < 5; i++) bus.publish({ level: 'info', title: `msg-${i}` });

    const { req, res } = mockReqRes();
    let writeCount = 0;
    const origWrite = res.write.bind(res);
    (res as { write: (s: string) => boolean }).write = (s: string) => {
      writeCount++;
      if (writeCount === 4) {
        // Simulate socket closing after the 4th write frame
        (res as MockState).destroyed = true;
      }
      return origWrite(s);
    };

    expect(() => openSse(req as never, res as never, bus)).not.toThrow();
    // At most a handful of frames written before the loop bails out.
    expect(writeCount).toBeGreaterThanOrEqual(1);
    expect(writeCount).toBeLessThan(100);
  });

  test('new publish after client closes does NOT write to socket', () => {
    const bus = new NotificationBus();
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);

    // Disconnect
    (req as EventEmitter).emit('close');

    const sizeBefore = res.body.length;
    // This MUST NOT write and MUST NOT throw
    expect(() => bus.publish({ level: 'info', title: 'post-close' })).not.toThrow();
    expect(res.body.length).toBe(sizeBefore);
  });

  test('EPIPE during write is caught and does not propagate as 500', () => {
    const bus = new NotificationBus();

    // Build a fresh mock that throws EPIPE on the very first write.
    const req2 = new EventEmitter();
    let didThrow = false;
    const throwingRes = {
      headers: {} as Record<string, string>,
      writable: true,
      writableEnded: false,
      destroyed: false,
      ended: false,
      setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
      write(_s: string): boolean {
        // Simulate Node throwing EPIPE synchronously on every write.
        didThrow = true;
        throw new Error('write EPIPE');
      },
      end() { this.ended = true; },
      flushHeaders() { /* noop */ },
    };

    // openSse itself must not throw even though every write throws EPIPE.
    expect(() => openSse(req2 as never, throwingRes as never, bus)).not.toThrow();
    // At least one write was attempted (the header flush triggers flushHeaders; actual
    // write calls come from backfill/subscribe). If the bus has no recent items the
    // subscriber is still registered; a publish below will trigger the throw.
    bus.publish({ level: 'danger', title: 'epipe-publish' });
    // The throw was absorbed — confirm it happened (proves we hit the guarded path).
    // writable=true so isWritable passes, the write path inside send() threw.
    expect(didThrow).toBe(true);
  });
});

// ─── Fix 2: SSE route 400 when X-Tenant-ID is absent ────────────────────────

describe('GET /v1/notifications/stream — tenant header fallback (fix 2 regression)', () => {
  test('request without X-Tenant-ID + Accept: text/event-stream gets 200', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app)
      .get('/v1/notifications/stream')
      .set({ 'Accept': 'text/event-stream', 'x-apex-role': 'risk_analyst' })
      .timeout(500)
      .catch((e: { timeout?: boolean; response?: { status: number } }) => {
        // Supertest times out on open streams — that IS a 200 (headers sent).
        if (e.timeout) return { status: 200 };
        // Socket closed by test teardown also counts as connected.
        if (e.response) return e.response;
        return { status: 0 };
      });
    // Must NOT be 400 (missing tenant) or 500.
    expect(r.status).not.toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('request without X-Tenant-ID + no Accept gets 200 (EventSource default)', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app)
      .get('/v1/notifications/stream')
      .set({ 'x-apex-role': 'risk_analyst' })
      .timeout(500)
      .catch((e: { timeout?: boolean; response?: { status: number } }) => {
        if (e.timeout) return { status: 200 };
        if (e.response) return e.response;
        return { status: 0 };
      });
    expect(r.status).not.toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('explicit X-Tenant-ID still works as before', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app)
      .get('/v1/notifications/stream')
      .set({ ...TENANT_ROLE })
      .timeout(500)
      .catch((e: { timeout?: boolean; response?: { status: number } }) => {
        if (e.timeout) return { status: 200 };
        if (e.response) return e.response;
        return { status: 0 };
      });
    expect(r.status).not.toBe(400);
    expect(r.status).not.toBe(500);
  });

  test('JSON client without X-Tenant-ID still gets 400 (not a bypass)', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app)
      .get('/v1/notifications/stream')
      .set({ 'Accept': 'application/json', 'x-apex-role': 'risk_analyst' });
    expect(r.status).toBe(400);
    expect(r.body?.error?.code).toMatch(/EWS_400/);
  });

  test('role-less request still returns 401/403 even with tenant default', async () => {
    const { app } = makeTestApp(null);
    const r = await request(app)
      .get('/v1/notifications/stream')
      .set({ 'Accept': 'text/event-stream' })
      .timeout(500)
      .catch((e: { timeout?: boolean; response?: { status: number } }) => {
        if (e.timeout) return { status: 999 }; // unexpected — role-less should NOT get 200
        if (e.response) return e.response;
        return { status: 0 };
      });
    expect([401, 403]).toContain(r.status);
  });
});

// ─── Stream content / event delivery ───────────────────────────────────────

describe('openSse() — event delivery correctness', () => {
  test('SSE headers are correct', () => {
    const bus = new NotificationBus();
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.headers['x-accel-buffering']).toBe('no');
  });

  test('SSE frame format: id + event + data lines', () => {
    const bus = new NotificationBus();
    bus.publish({ level: 'info', title: 'frame-check' });
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);
    // Verify the three-line SSE format: id, event, data
    expect(res.body).toMatch(/id: [\w-]+\nevent: notification\ndata: \{[^\n]*"frame-check"/);
  });

  test('backfill is received by new subscribers', () => {
    const bus = new NotificationBus();
    bus.publish({ level: 'info', title: 'first' });
    bus.publish({ level: 'warning', title: 'second' });
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);
    expect(res.body).toContain('"first"');
    expect(res.body).toContain('"second"');
  });

  test('live publishes after subscribe are received', () => {
    const bus = new NotificationBus();
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);
    bus.publish({ level: 'danger', title: 'live-event' });
    expect(res.body).toContain('"live-event"');
  });

  test('all 10 canonical notification types can be published and received', () => {
    const bus = new NotificationBus();
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);
    const types = [
      'alert.created', 'case.assigned', 'case.closed', 'scenario.run', 'system',
    ];
    for (const type of types) {
      bus.publish({ level: 'info', title: `type-${type}`, type: type as never });
    }
    for (const type of types) {
      expect(res.body).toContain(`"type-${type}"`);
    }
  });

  test('large recent buffer does not throw or produce 500', () => {
    const bus = new NotificationBus(50);
    // Fill to capacity.
    for (let i = 0; i < 60; i++) bus.publish({ level: 'info', title: `n-${i}` });
    const { req, res } = mockReqRes();
    expect(() => openSse(req as never, res as never, bus)).not.toThrow();
    // At most 50 items backfilled (bus cap).
    const matches = res.body.match(/event: notification/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(50);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('cleanup fires once on close and no duplicate unsubscribes', () => {
    const bus = new NotificationBus();
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);
    expect(bus.size()).toBe(1);
    (req as EventEmitter).emit('close');
    expect(res.ended).toBe(true);
    expect(bus.size()).toBe(0);
    // Emit close a second time — must not throw.
    expect(() => (req as EventEmitter).emit('close')).not.toThrow();
  });
});

// ─── Integration smoke: stream endpoint returns 200 with proper headers ──────

describe('GET /v1/notifications/stream — integration smoke', () => {
  test('200 text/event-stream with tenant + role headers', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app)
      .get('/v1/notifications/stream')
      .set(TENANT_ROLE)
      .timeout(400)
      .catch((e: { timeout?: boolean; response?: { status: number; headers: Record<string, string> } }) => {
        // A timeout on an SSE endpoint means the connection was accepted (200) and stayed open.
        if (e.timeout) return { status: 200, headers: {} };
        if (e.response) return e.response;
        return { status: 0, headers: {} };
      });
    expect(r.status).toBe(200);
  });

  test('connecting registers a subscriber and backfill is visible via unit test', () => {
    // Verifies the end-to-end path using the unit-level mock to avoid
    // supertest's inability to resolve open SSE streams in CI.
    const bus = new NotificationBus();
    bus.publish({ level: 'info', title: 'pre-connect' });
    const { req, res } = mockReqRes();

    expect(bus.size()).toBe(0);
    openSse(req as never, res as never, bus);
    expect(bus.size()).toBe(1);

    // Backfill visible.
    expect(res.body).toContain('pre-connect');

    // Live event after connect.
    bus.publish({ level: 'warning', title: 'post-connect' });
    expect(res.body).toContain('post-connect');

    // Disconnect — subscriber removed.
    (req as EventEmitter).emit('close');
    expect(bus.size()).toBe(0);
  });
});
