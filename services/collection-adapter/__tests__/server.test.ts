import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { makeApp } from '../src/server';
import {
  CasesClientError,
  HttpCasesClient,
  UnavailableCasesClient,
  type CasesClient,
} from '../src/cases_client';
import { InMemoryCollectionSink, OutboxCollectionSink } from '../src/sink';
import { StaticCaseEventSource } from '../src/source';
import type { CaseEvent, Outcome } from '../src/types';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function caseCreated(case_id: string, severity: string): CaseEvent {
  return {
    event_id: `evt-${case_id}`,
    event_type: 'case.created',
    ts: '2026-04-27T10:00:00Z',
    case_id,
    alert_id: `alert-${case_id}`,
    customer_id: `cust-${case_id}`,
    prior_state: null,
    new_state: 'open',
    payload: { severity },
  };
}

describe('GET /healthz', () => {
  test('returns ok', async () => {
    const { app } = makeApp({
      source: new StaticCaseEventSource([]),
      sink: new InMemoryCollectionSink(),
      casesClient: new UnavailableCasesClient(),
      getRole: () => 'admin',
    });
    const r = await request(app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});

describe('POST /process', () => {
  test('routes eligible case events from the source', async () => {
    const events = [
      caseCreated('c-1', 'critical'),
      caseCreated('c-2', 'low'),
    ];
    const sink = new InMemoryCollectionSink();
    const { app } = makeApp({
      source: new StaticCaseEventSource(events),
      sink,
      casesClient: new UnavailableCasesClient(),
      getRole: () => 'admin',
    });
    const r = await request(app).post('/process').send({});
    expect(r.status).toBe(200);
    expect(r.body.scanned).toBe(2);
    expect(r.body.routed).toBe(1);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].case_id).toBe('c-1');
  });
});

describe('POST /collection/callback', () => {
  test('proxies status=cured to cases /close', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ id: 'case-501', state: 'closed', outcome: 'cured' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const cases = new HttpCasesClient('http://cases:8083', fakeFetch as never);
    const { app } = makeApp({
      source: new StaticCaseEventSource([]),
      sink: new InMemoryCollectionSink(),
      casesClient: cases,
      getRole: () => 'admin',
    });
    const r = await request(app)
      .post('/collection/callback')
      .send({ case_id: 'case-501', status: 'cured', note: 'paid in full' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.case.state).toBe('closed');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://cases:8083/cases/case-501/close');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toEqual({ outcome: 'cured', note: 'paid in full' });
  });

  test('400 when case_id or status missing or invalid', async () => {
    const { app } = makeApp({
      source: new StaticCaseEventSource([]),
      sink: new InMemoryCollectionSink(),
      casesClient: new UnavailableCasesClient(),
      getRole: () => 'admin',
    });
    const a = await request(app).post('/collection/callback').send({});
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/case_id is required/);
    expect(a.body.error).toMatch(/status/);

    const b = await request(app)
      .post('/collection/callback')
      .send({ case_id: 'c', status: 'recovered' });
    expect(b.status).toBe(400);
    expect(b.body.error).toMatch(/status/);
  });

  test('forwards cases-svc 409 (already-closed) verbatim', async () => {
    const failing: CasesClient = {
      close: async () => {
        throw new CasesClientError(409, 'cannot close a case in state closed', {
          current_state: 'closed',
          attempted: 'close',
        });
      },
    };
    const { app } = makeApp({
      source: new StaticCaseEventSource([]),
      sink: new InMemoryCollectionSink(),
      casesClient: failing,
      getRole: () => 'admin',
    });
    const r = await request(app)
      .post('/collection/callback')
      .send({ case_id: 'case-x', status: 'defaulted' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cannot close/);
    expect(r.body.body.current_state).toBe('closed');
  });

  test('returns 503 when cases service is unavailable', async () => {
    const { app } = makeApp({
      source: new StaticCaseEventSource([]),
      sink: new InMemoryCollectionSink(),
      casesClient: new UnavailableCasesClient(),
      getRole: () => 'admin',
    });
    const r = await request(app)
      .post('/collection/callback')
      .send({ case_id: 'c-1', status: 'cured' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/APEX_CASES_URL/);
  });

  test('accepts each valid outcome (cured, cured_temp, defaulted)', async () => {
    const sent: Outcome[] = [];
    const fakeFetch = async (_url: string, init: RequestInit): Promise<Response> => {
      sent.push(JSON.parse(init.body as string).outcome);
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const cases = new HttpCasesClient('http://cases', fakeFetch as never);
    const { app } = makeApp({
      source: new StaticCaseEventSource([]),
      sink: new InMemoryCollectionSink(),
      casesClient: cases,
      getRole: () => 'admin',
    });
    for (const status of ['cured', 'cured_temp', 'defaulted'] as Outcome[]) {
      const r = await request(app).post('/collection/callback').send({ case_id: 'c-1', status });
      expect(r.status).toBe(200);
    }
    expect(sent).toEqual(['cured', 'cured_temp', 'defaulted']);
  });
});

describe('OutboxCollectionSink — persistence + idempotency replay', () => {
  test('rebuilds the seen-set from disk on construction', async () => {
    const dir = tmpDir('apex-collection-');
    const sink1 = new OutboxCollectionSink(dir);
    await sink1.emit({
      route_id: 'r-1',
      case_id: 'c-1',
      alert_id: 'a-1',
      customer_id: 'u-1',
      severity: 'high',
      loan_id: null,
      routed_at: '2026-04-27T10:00:00Z',
      reason: 'severity',
      source_event_id: 'e-1',
    });
    expect(sink1.hasRouted('c-1')).toBe(true);
    // Fresh sink should still know c-1 is routed.
    const sink2 = new OutboxCollectionSink(dir);
    expect(sink2.hasRouted('c-1')).toBe(true);
    expect(sink2.readAll()).toHaveLength(1);
  });
});
