import { EventEmitter } from 'node:events';
import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { NotificationBus } from '../src/notifications/bus';
import { openSse } from '../src/notifications/sse';

// Lightweight mock req/res for SSE unit tests — avoids supertest's
// "aborted" rejection on long-lived streams.
interface MockRes {
  headers: Record<string, string>;
  body: string;
  ended: boolean;
}
function mockReqRes(): {
  req: EventEmitter;
  res: MockRes & {
    setHeader: (k: string, v: string) => void;
    write: (s: string) => boolean;
    end: () => void;
    flushHeaders: () => void;
  };
} {
  const req = new EventEmitter();
  const state: MockRes = { headers: {}, body: '', ended: false };
  const res = {
    ...state,
    setHeader(k: string, v: string) {
      state.headers[k.toLowerCase()] = v;
    },
    write(s: string): boolean {
      state.body += s;
      return true;
    },
    end() {
      state.ended = true;
    },
    flushHeaders() {
      /* noop */
    },
  };
  // Surface the live state via getters.
  Object.defineProperties(res, {
    headers: { get: () => state.headers },
    body: { get: () => state.body },
    ended: { get: () => state.ended },
  });
  return { req, res: res as ReturnType<typeof mockReqRes>['res'] };
}

const NOW = new Date('2026-04-29T12:00:00.000Z');

function makeNotifApp(role: string = 'admin', bus?: NotificationBus) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    notificationBus: bus ?? new NotificationBus(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('NotificationBus', () => {
  test('publish stamps an id + ts when not provided', () => {
    const bus = new NotificationBus();
    const n = bus.publish({ level: 'info', title: 'hello' });
    expect(n.id).toBeTruthy();
    expect(n.ts).toBeTruthy();
    expect(n.level).toBe('info');
    expect(n.title).toBe('hello');
  });

  test('subscriber receives every publish; unsubscribe stops delivery', () => {
    const bus = new NotificationBus();
    const seen: string[] = [];
    const off = bus.subscribe((n) => seen.push(n.title));
    bus.publish({ level: 'info', title: 'one' });
    bus.publish({ level: 'info', title: 'two' });
    off();
    bus.publish({ level: 'info', title: 'three' });
    expect(seen).toEqual(['one', 'two']);
  });

  test('recent buffer is capped', () => {
    const bus = new NotificationBus(3);
    for (let i = 0; i < 10; i++) bus.publish({ level: 'info', title: `n${i}` });
    expect(bus.recent).toHaveLength(3);
    expect(bus.recent.map((n) => n.title)).toEqual(['n7', 'n8', 'n9']);
  });

  test('subscriber error does not stop the publish loop', () => {
    const bus = new NotificationBus();
    let bSawIt = false;
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => {
      bSawIt = true;
    });
    expect(() => bus.publish({ level: 'info', title: 'x' })).not.toThrow();
    expect(bSawIt).toBe(true);
  });

  test('size() reports active subscribers', () => {
    const bus = new NotificationBus();
    expect(bus.size()).toBe(0);
    const off = bus.subscribe(() => {});
    expect(bus.size()).toBe(1);
    off();
    expect(bus.size()).toBe(0);
  });
});

describe('POST /v1/notifications/publish', () => {
  test('admin publishes an info notification', async () => {
    const bus = new NotificationBus();
    const { app } = makeNotifApp('admin', bus);
    const r = await request(app)
      .post('/v1/notifications/publish')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .send({ level: 'info', title: 'hello world' });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.notification.title).toBe('hello world');
    expect(bus.recent).toHaveLength(1);
  });

  test('field_officer is forbidden', async () => {
    const { app } = makeNotifApp('field_officer');
    const r = await request(app)
      .post('/v1/notifications/publish')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .send({ level: 'info', title: 'hi' });
    expect(r.status).toBe(403);
  });

  test('400 on missing title', async () => {
    const { app } = makeNotifApp('admin');
    const r = await request(app)
      .post('/v1/notifications/publish')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .send({ level: 'info' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/title/);
  });

  test('400 on bad level', async () => {
    const { app } = makeNotifApp('admin');
    const r = await request(app)
      .post('/v1/notifications/publish')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .send({ level: 'fatal', title: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/level/);
  });
});

describe('openSse() — direct unit test', () => {
  test('sets text/event-stream headers + backfills recent + streams new publishes', () => {
    const bus = new NotificationBus();
    bus.publish({ level: 'info', title: 'backfill-1' });
    bus.publish({ level: 'warning', title: 'backfill-2' });
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);

    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['connection']).toBe('keep-alive');
    // Backfill present
    expect(res.body).toContain('event: notification');
    expect(res.body).toContain('backfill-1');
    expect(res.body).toContain('backfill-2');

    // New publishes flow through.
    bus.publish({ level: 'danger', title: 'live-3' });
    expect(res.body).toContain('live-3');
  });

  test('client close triggers cleanup — no further writes after disconnect', () => {
    const bus = new NotificationBus();
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);

    bus.publish({ level: 'info', title: 'before-close' });
    expect(res.body).toContain('before-close');

    // Simulate client disconnect.
    (req as EventEmitter).emit('close');
    expect(res.ended).toBe(true);
    const sizeBefore = res.body.length;
    bus.publish({ level: 'info', title: 'after-close' });
    expect(res.body.length).toBe(sizeBefore);
  });

  test('formats SSE frame: id + event + data on three lines', () => {
    const bus = new NotificationBus();
    bus.publish({ level: 'info', title: 'frame-test' });
    const { req, res } = mockReqRes();
    openSse(req as never, res as never, bus);
    expect(res.body).toMatch(/id: [\w-]+\nevent: notification\ndata: \{[^\n]*"frame-test"/);
  });
});

describe('GET /v1/notifications/stream — auth gate (status code only)', () => {
  test('role-less request 403', async () => {
    const app = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      notificationBus: new NotificationBus(),
      now: () => NOW,
      getRole: () => null,
    });
    const r = await request(app.app)
      .get('/v1/notifications/stream')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect([401, 403]).toContain(r.status);
  });
});

describe('scenario.run hook', () => {
  const TENANT_HEADERS = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('publishing a successful scenario emits a notification', async () => {
    const bus = new NotificationBus();
    const { app } = makeNotifApp('risk_analyst', bus);
    await request(app).post('/v1/scenario/run').set(TENANT_HEADERS).send({ gdp: -2, rate: 100, fx: 5 });
    expect(bus.recent.length).toBeGreaterThanOrEqual(1);
    const last = bus.recent[bus.recent.length - 1];
    expect(last.title).toMatch(/Scenario|ECL/i);
    expect(last.href).toBe('/scenario');
  });

  test('benign zero-shock scenario uses info level', async () => {
    const bus = new NotificationBus();
    const { app } = makeNotifApp('risk_analyst', bus);
    await request(app).post('/v1/scenario/run').set(TENANT_HEADERS).send({ gdp: 0, rate: 0, fx: 0 });
    const last = bus.recent[bus.recent.length - 1];
    expect(last.level).toBe('info');
  });

  test('adverse shock uses warning level', async () => {
    const bus = new NotificationBus();
    const { app } = makeNotifApp('risk_analyst', bus);
    await request(app).post('/v1/scenario/run').set(TENANT_HEADERS).send({ gdp: -4, rate: 200, fx: 10 });
    const last = bus.recent[bus.recent.length - 1];
    expect(last.level).toBe('warning');
  });
});
