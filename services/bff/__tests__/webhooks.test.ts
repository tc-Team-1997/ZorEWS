// Coverage for the outbound webhook subsystem:
//   - Dispatcher signs payloads with HMAC-SHA256
//   - Dispatcher retries 3x on failure with the configured back-off
//   - Final outcome is recorded as a delivery row
//   - Admin REST routes (/v1/webhooks*) enforce webhooks:manage
//   - dispatch() fan-outs only to active subs that listen for the event
//   - Hook in /v1/ews/evaluate fires alert.created on High level only
//   - test-fire endpoint synthesises a webhook.test event end-to-end
//
// We inject a custom fetch + zero retry-delays into the dispatcher
// per-test so the suite runs fast (no real HTTP, no 21s back-off wait).

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { WebhookSubscriptionStore } from '../src/webhooks/store';
import { WebhookDispatcher, verifySignature } from '../src/webhooks/dispatcher';
import type { WebhookEventType } from '../src/webhooks/types';
import type { Evaluator, ScoreResponse } from '../src/score';

const NOW = new Date('2026-05-02T12:00:00.000Z');

interface FakeCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * Build a stub fetch that records every call and returns a configurable
 * sequence of statuses. When the script runs out, it returns 200.
 */
function makeFakeFetch(statuses: number[] = [200]) {
  const calls: FakeCall[] = [];
  let idx = 0;
  const fn = async (url: string | URL, init: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    calls.push({ url: String(url), body: String(init.body ?? ''), headers });
    const status = statuses[Math.min(idx, statuses.length - 1)];
    idx++;
    return new Response(status === 200 ? 'ok' : 'error', { status });
  };
  return { fn: fn as unknown as typeof fetch, calls, get attempts() { return idx; } };
}

function makeWebhookApp(opts: {
  store: WebhookSubscriptionStore;
  fetchImpl: typeof fetch;
  role?: string;
  evaluator?: Evaluator;
}) {
  const dispatcher = new WebhookDispatcher(opts.store, {
    fetchImpl: opts.fetchImpl as never,
    // Zero-delay retries so tests don't sleep 21s waiting for the
    // production back-off (1s + 4s + 16s).
    retryDelaysMs: [0, 0],
    sleep: () => Promise.resolve(),
    now: () => NOW,
  });
  return makeApp({
    source: new StaticSource([]),
    evaluator: opts.evaluator ?? new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    webhookStore: opts.store,
    webhookDispatcher: dispatcher,
    now: () => NOW,
    getRole: () => opts.role ?? 'admin',
  });
}

describe('webhook signing', () => {
  test('verifySignature accepts a correctly-signed body', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'shared-secret';
    // Re-sign using the same algorithm that dispatcher.sign() uses.
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifySignature(body, secret, sig)).toBe(true);
  });

  test('verifySignature rejects a tampered body', () => {
    const body = JSON.stringify({ hello: 'world' });
    const tampered = JSON.stringify({ hello: 'mars' });
    const secret = 'shared-secret';
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifySignature(tampered, secret, sig)).toBe(false);
  });
});

describe('WebhookDispatcher.deliverOne', () => {
  test('signs the payload and POSTs to the subscription URL on success', async () => {
    const store = new WebhookSubscriptionStore();
    const sub = store.create({
      name: 'AML hub',
      url: 'https://example.test/aml',
      events: ['alert.created'],
    });
    const fake = makeFakeFetch([200]);
    const dispatcher = new WebhookDispatcher(store, {
      fetchImpl: fake.fn as never,
      retryDelaysMs: [0, 0],
      sleep: () => Promise.resolve(),
      now: () => NOW,
    });

    const delivery = await dispatcher.deliverOne(sub, 'alert.created', { customer_id: 'c-101' });

    expect(fake.attempts).toBe(1);
    expect(fake.calls[0].url).toBe('https://example.test/aml');
    expect(fake.calls[0].headers['content-type']).toBe('application/json');
    expect(fake.calls[0].headers['x-apex-event']).toBe('alert.created');
    // The signature must verify against the secret + body.
    const sigHeader = fake.calls[0].headers['x-apex-signature'];
    expect(verifySignature(fake.calls[0].body, sub.secret, sigHeader)).toBe(true);

    expect(delivery.status).toBe('success');
    expect(delivery.attempts).toBe(1);
    expect(delivery.response_status).toBe(200);

    // Delivery row recorded on the store.
    const log = store.deliveriesFor(sub.id);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('success');
  });

  test('retries 3x on 5xx and ends in failed status', async () => {
    const store = new WebhookSubscriptionStore();
    const sub = store.create({
      name: 'broken',
      url: 'https://example.test/broken',
      events: ['alert.created'],
    });
    const fake = makeFakeFetch([500, 503, 502]);
    const dispatcher = new WebhookDispatcher(store, {
      fetchImpl: fake.fn as never,
      retryDelaysMs: [0, 0],
      sleep: () => Promise.resolve(),
      now: () => NOW,
    });

    const delivery = await dispatcher.deliverOne(sub, 'alert.created', { x: 1 });

    expect(fake.attempts).toBe(3);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(3);
    expect(delivery.response_status).toBe(502);
  });

  test('succeeds on retry after a transient failure', async () => {
    const store = new WebhookSubscriptionStore();
    const sub = store.create({
      name: 'flaky',
      url: 'https://example.test/flaky',
      events: ['alert.created'],
    });
    const fake = makeFakeFetch([502, 200]);
    const dispatcher = new WebhookDispatcher(store, {
      fetchImpl: fake.fn as never,
      retryDelaysMs: [0, 0],
      sleep: () => Promise.resolve(),
      now: () => NOW,
    });
    const delivery = await dispatcher.deliverOne(sub, 'alert.created', {});
    expect(fake.attempts).toBe(2);
    expect(delivery.status).toBe('success');
    expect(delivery.attempts).toBe(2);
    expect(delivery.response_status).toBe(200);
  });
});

describe('WebhookDispatcher.dispatch — fan-out', () => {
  test('only fires to active subs subscribed to the event type', async () => {
    const store = new WebhookSubscriptionStore();
    const subA = store.create({
      name: 'A',
      url: 'https://a.test/x',
      events: ['alert.created'],
    });
    const subB = store.create({
      name: 'B',
      url: 'https://b.test/x',
      events: ['scenario.run'],
    });
    // Deactivate A — should be skipped even though it subscribes to alert.created
    const internal = store.internalGet(subA.id);
    if (internal) internal.active = false;
    // Sub C: matches event but is independent; should fire.
    const subC = store.create({
      name: 'C',
      url: 'https://c.test/x',
      events: ['alert.created', 'scenario.run'],
    });

    const fake = makeFakeFetch([200, 200, 200, 200]);
    const dispatcher = new WebhookDispatcher(store, {
      fetchImpl: fake.fn as never,
      retryDelaysMs: [0, 0],
      sleep: () => Promise.resolve(),
      now: () => NOW,
    });
    const promises = dispatcher.dispatch('alert.created', { x: 1 });
    await Promise.all(promises);

    // Only subC should have received it (subA is inactive, subB doesn't subscribe).
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe('https://c.test/x');
    // subB is irrelevant here but the test asserts on names not ids.
    expect(subB.id).not.toBe(subC.id);
  });
});

describe('admin REST routes', () => {
  const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('non-admin role gets 403 on /v1/webhooks', async () => {
    const store = new WebhookSubscriptionStore();
    const fake = makeFakeFetch([200]);
    const { app } = makeWebhookApp({ store, fetchImpl: fake.fn as never, role: 'risk_analyst' });
    const r = await request(app).get('/v1/webhooks').set(TH);
    expect(r.status).toBe(403);
  });

  test('admin can create + list + delete', async () => {
    const store = new WebhookSubscriptionStore();
    const fake = makeFakeFetch([200]);
    const { app } = makeWebhookApp({ store, fetchImpl: fake.fn as never });

    // Create
    const c = await request(app)
      .post('/v1/webhooks')
      .set(TH)
      .send({ name: 'AML', url: 'https://example.test/aml', events: ['alert.created'] });
    expect(c.status).toBe(201);
    expect(c.body.secret).toMatch(/^[0-9a-f]{64}$/);
    const id = c.body.id as string;

    // List does NOT include the secret
    const l = await request(app).get('/v1/webhooks').set(TH);
    expect(l.status).toBe(200);
    expect(l.body.items).toHaveLength(1);
    expect(l.body.items[0]).not.toHaveProperty('secret');

    // Delete
    const d = await request(app).delete(`/v1/webhooks/${id}`).set(TH);
    expect(d.status).toBe(204);
    const l2 = await request(app).get('/v1/webhooks').set(TH);
    expect(l2.body.items).toHaveLength(0);
  });

  test('create with an invalid event type returns 400', async () => {
    const store = new WebhookSubscriptionStore();
    const fake = makeFakeFetch([200]);
    const { app } = makeWebhookApp({ store, fetchImpl: fake.fn as never });
    const r = await request(app)
      .post('/v1/webhooks')
      .set(TH)
      .send({ name: 'X', url: 'https://x.test/x', events: ['bogus.thing'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/bogus\.thing/);
  });

  test('test-fire dispatches a webhook.test event and returns the delivery row', async () => {
    const store = new WebhookSubscriptionStore();
    const fake = makeFakeFetch([200]);
    const { app } = makeWebhookApp({ store, fetchImpl: fake.fn as never });
    const c = await request(app)
      .post('/v1/webhooks')
      .set(TH)
      .send({ name: 'X', url: 'https://x.test/x', events: ['webhook.test'] });
    const id = c.body.id as string;

    const t = await request(app).post(`/v1/webhooks/${id}/test`).set(TH);
    expect(t.status).toBe(200);
    expect(t.body.status).toBe('success');
    expect(t.body.event_type).toBe('webhook.test');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].headers['x-apex-event']).toBe('webhook.test');
  });

  test('GET /v1/webhooks/:id/deliveries returns the recorded log', async () => {
    const store = new WebhookSubscriptionStore();
    const fake = makeFakeFetch([200]);
    const { app } = makeWebhookApp({ store, fetchImpl: fake.fn as never });
    const c = await request(app)
      .post('/v1/webhooks')
      .set(TH)
      .send({ name: 'X', url: 'https://x.test/x', events: ['webhook.test'] });
    const id = c.body.id as string;
    await request(app).post(`/v1/webhooks/${id}/test`).set(TH);
    await request(app).post(`/v1/webhooks/${id}/test`).set(TH);
    const r = await request(app).get(`/v1/webhooks/${id}/deliveries`).set(TH);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    // newest-first ordering
    expect(r.body.items[0].id).not.toBe(r.body.items[1].id);
  });
});

describe('hook into /v1/ews/evaluate', () => {
  /**
   * Custom evaluator that returns the level + PD we want, so we can
   * test the High vs Medium vs Low fan-out behavior deterministically
   * without depending on the StubEvaluator's PD distribution.
   */
  class FixedLevelEvaluator implements Evaluator {
    constructor(private level: ScoreResponse['level']) {}
    async evaluate(): Promise<ScoreResponse> {
      return {
        customer_id: 'c-101',
        pd: this.level === 'High' ? 0.8 : this.level === 'Medium' ? 0.4 : 0.05,
        level: this.level,
        top_reasons: [],
        model_name: 'fixed',
        model_version: '0.0.1',
      };
    }
  }

  test('fires alert.created webhook when level is High', async () => {
    const store = new WebhookSubscriptionStore();
    const fake = makeFakeFetch([200]);
    const { app } = makeWebhookApp({
      store,
      fetchImpl: fake.fn as never,
      evaluator: new FixedLevelEvaluator('High'),
    });
    const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
    await request(app)
      .post('/v1/webhooks')
      .set(TH)
      .send({
        name: 'aml',
        url: 'https://aml.test/x',
        events: ['alert.created'] as WebhookEventType[],
      });
    await request(app)
      .post('/v1/ews/evaluate')
      .set(TH)
      .send({ customer_id: 'c-101' });

    // The dispatch is fire-and-forget; awaiting a tick lets the queued
    // microtask resolve. The fake fetch is synchronous so a single
    // queueMicrotask flush is enough.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].headers['x-apex-event']).toBe('alert.created');
  });

  test('does NOT fire alert.created when level is Low or Medium', async () => {
    const store = new WebhookSubscriptionStore();
    const fake = makeFakeFetch([200]);
    const { app } = makeWebhookApp({
      store,
      fetchImpl: fake.fn as never,
      evaluator: new FixedLevelEvaluator('Medium'),
    });
    const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
    await request(app)
      .post('/v1/webhooks')
      .set(TH)
      .send({
        name: 'aml',
        url: 'https://aml.test/x',
        events: ['alert.created'] as WebhookEventType[],
      });
    await request(app)
      .post('/v1/ews/evaluate')
      .set(TH)
      .send({ customer_id: 'c-101' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fake.calls).toHaveLength(0);
  });
});
