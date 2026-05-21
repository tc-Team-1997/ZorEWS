// T3.1.1 — CBS production adapter resilience framework tests.

import {
  CbsCircuitOpenError,
  CbsRetryExhaustedError,
  CircuitBreaker,
  DEFAULT_CBS_RETRY_POLICY,
  DEFAULT_CIRCUIT_BREAKER,
  NoopCbsAuditSink,
  ResilientCbsClient,
  computeBackoffMs,
  type CbsClient,
  type CbsAuditSink,
  type CbsRequest,
  type CbsResponse,
} from '../src/integrations/cbs_production';

class TestSink implements CbsAuditSink {
  events: Array<Parameters<CbsAuditSink['record']>[0]> = [];
  record(e: Parameters<CbsAuditSink['record']>[0]): void {
    this.events.push(e);
  }
}

function makeClient(scriptedResponses: Array<CbsResponse | Error>): CbsClient {
  let idx = 0;
  const fn = async (_req: CbsRequest): Promise<CbsResponse> => {
    const r = scriptedResponses[idx++ % scriptedResponses.length];
    if (r instanceof Error) throw r;
    return r;
  };
  return { call: fn as CbsClient['call'] };
}

function mockClient(callImpl: () => Promise<CbsResponse>): CbsClient {
  const fn = async (_req: CbsRequest): Promise<CbsResponse> => callImpl();
  return { call: fn as CbsClient['call'] };
}

describe('computeBackoffMs', () => {
  test('doubles per attempt up to max', () => {
    // Use random=0.5 → 0 jitter (jitter is ±, so 2*0.5-1=0).
    const b1 = computeBackoffMs(1, DEFAULT_CBS_RETRY_POLICY, () => 0.5);
    const b2 = computeBackoffMs(2, DEFAULT_CBS_RETRY_POLICY, () => 0.5);
    const b3 = computeBackoffMs(3, DEFAULT_CBS_RETRY_POLICY, () => 0.5);
    expect(b1).toBe(250);
    expect(b2).toBe(500);
    expect(b3).toBe(1000);
  });

  test('clamps at max_backoff_ms', () => {
    const b = computeBackoffMs(20, DEFAULT_CBS_RETRY_POLICY, () => 0.5);
    expect(b).toBe(DEFAULT_CBS_RETRY_POLICY.max_backoff_ms);
  });

  test('jitter applies ± relative band', () => {
    const lo = computeBackoffMs(2, DEFAULT_CBS_RETRY_POLICY, () => 0); // -jitter
    const hi = computeBackoffMs(2, DEFAULT_CBS_RETRY_POLICY, () => 1); // +jitter
    expect(lo).toBeLessThan(500);
    expect(hi).toBeGreaterThan(500);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});

describe('CircuitBreaker', () => {
  test('starts closed + flips to open after threshold failures', () => {
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER);
    expect(cb.currentState()).toBe('closed');
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.failure_threshold; i++) {
      cb.recordFailure();
    }
    expect(cb.currentState()).toBe('open');
    expect(cb.allow()).toBe(false);
  });

  test('open → half_open after recovery_timeout_ms', () => {
    let now = 1000;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER, () => now);
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.failure_threshold; i++) cb.recordFailure();
    expect(cb.currentState()).toBe('open');
    // Just before timeout.
    now += DEFAULT_CIRCUIT_BREAKER.recovery_timeout_ms - 1;
    expect(cb.currentState()).toBe('open');
    // After timeout.
    now += 2;
    expect(cb.currentState()).toBe('half_open');
  });

  test('half_open closes after half_open_success_threshold successes', () => {
    let now = 1000;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER, () => now);
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.failure_threshold; i++) cb.recordFailure();
    now += DEFAULT_CIRCUIT_BREAKER.recovery_timeout_ms + 1;
    expect(cb.currentState()).toBe('half_open');
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.half_open_success_threshold; i++) {
      cb.recordSuccess();
    }
    expect(cb.currentState()).toBe('closed');
    expect(cb.allow()).toBe(true);
  });

  test('any failure in half_open re-opens', () => {
    let now = 1000;
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER, () => now);
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.failure_threshold; i++) cb.recordFailure();
    now += DEFAULT_CIRCUIT_BREAKER.recovery_timeout_ms + 1;
    expect(cb.currentState()).toBe('half_open');
    cb.recordFailure();
    expect(cb.currentState()).toBe('open');
  });

  test('success in closed state resets consecutive_failures', () => {
    const cb = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.snapshot().consecutive_failures).toBe(2);
    cb.recordSuccess();
    expect(cb.snapshot().consecutive_failures).toBe(0);
  });
});

const NEVER_SLEEP = async () => {};

describe('ResilientCbsClient', () => {
  const REQ: CbsRequest = { operation: 'loan_pull', payload: { customer_id: 'C-1' } };

  test('happy path returns response + audit success', async () => {
    const audit = new TestSink();
    const client = new ResilientCbsClient(
      makeClient([{ ok: true, status: 200, body: { ok: true } }]),
      { audit, sleepMs: NEVER_SLEEP },
    );
    const out = await client.dispatch(REQ, 'BIL');
    expect(out.response.ok).toBe(true);
    expect(out.attempts).toBe(1);
    expect(audit.events.length).toBe(1);
    expect(audit.events[0].outcome).toBe('success');
  });

  test('retries on 503 then succeeds', async () => {
    const audit = new TestSink();
    const client = new ResilientCbsClient(
      makeClient([
        { ok: false, status: 503, body: {} },
        { ok: false, status: 503, body: {} },
        { ok: true, status: 200, body: { ok: true } },
      ]),
      { audit, sleepMs: NEVER_SLEEP },
    );
    const out = await client.dispatch(REQ, 'BIL');
    expect(out.attempts).toBe(3);
    expect(out.response.ok).toBe(true);
    expect(audit.events.length).toBe(1); // success at end
    expect(audit.events[0].metadata.attempts).toBe(3);
  });

  test('exhausts retries on persistent 503 → CbsRetryExhaustedError', async () => {
    const client = new ResilientCbsClient(
      makeClient([
        { ok: false, status: 503, body: {} },
        { ok: false, status: 503, body: {} },
        { ok: false, status: 503, body: {} },
        { ok: false, status: 503, body: {} },
      ]),
      { sleepMs: NEVER_SLEEP },
    );
    await expect(client.dispatch(REQ, 'BIL')).rejects.toBeInstanceOf(CbsRetryExhaustedError);
  });

  test('non-retryable 400 fails immediately', async () => {
    const audit = new TestSink();
    const client = new ResilientCbsClient(
      makeClient([{ ok: false, status: 400, body: { error: 'bad request' } }]),
      { audit, sleepMs: NEVER_SLEEP },
    );
    await expect(client.dispatch(REQ, 'BIL')).rejects.toBeInstanceOf(CbsRetryExhaustedError);
    expect(audit.events[0].outcome).toBe('failure');
    expect(audit.events[0].metadata.non_retryable).toBe(true);
  });

  test('non_retryable_operations enforces single-shot', async () => {
    let calls = 0;
    const client = new ResilientCbsClient(
      mockClient(async () => {
        calls++;
        return { ok: false, status: 503, body: {} };
      }),
      {
        retryPolicy: { non_retryable_operations: new Set(['loan_pull']) },
        sleepMs: NEVER_SLEEP,
      },
    );
    await expect(client.dispatch(REQ, 'BIL')).rejects.toBeInstanceOf(CbsRetryExhaustedError);
    expect(calls).toBe(1);
  });

  test('circuit OPEN rejects request without dispatch + audits denied', async () => {
    const audit = new TestSink();
    const circuit = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER);
    // Force open.
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.failure_threshold; i++) circuit.recordFailure();
    let calls = 0;
    const client = new ResilientCbsClient(
      mockClient(async () => {
        calls++;
        return { ok: true, status: 200, body: {} };
      }),
      { circuit, audit, sleepMs: NEVER_SLEEP },
    );
    await expect(client.dispatch(REQ, 'BIL')).rejects.toBeInstanceOf(CbsCircuitOpenError);
    expect(calls).toBe(0);
    expect(audit.events[0].outcome).toBe('denied');
    expect(audit.events[0].metadata.reason).toBe('circuit_open');
  });

  test('persistent failures trip the circuit breaker', async () => {
    const circuit = new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER);
    const client = new ResilientCbsClient(
      mockClient(async () => ({ ok: false, status: 500, body: {} })),
      { circuit, retryPolicy: { max_attempts: 1 }, sleepMs: NEVER_SLEEP },
    );
    for (let i = 0; i < DEFAULT_CIRCUIT_BREAKER.failure_threshold; i++) {
      await expect(client.dispatch(REQ, 'BIL')).rejects.toBeInstanceOf(CbsRetryExhaustedError);
    }
    expect(client.circuitSnapshot().state).toBe('open');
  });

  test('network exception retries within policy', async () => {
    let calls = 0;
    const client = new ResilientCbsClient(
      mockClient(async () => {
        calls++;
        if (calls < 3) throw new Error('ECONNRESET');
        return { ok: true, status: 200, body: { ok: true } };
      }),
      { sleepMs: NEVER_SLEEP },
    );
    const out = await client.dispatch(REQ, 'BIL');
    expect(out.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  test('empty tenant_id throws before dispatch', async () => {
    const client = new ResilientCbsClient(makeClient([]), { sleepMs: NEVER_SLEEP });
    await expect(client.dispatch(REQ, '')).rejects.toThrow(/tenant_id/);
  });

  test('NoopCbsAuditSink is a valid sink', () => {
    const sink = new NoopCbsAuditSink();
    expect(() =>
      sink.record({
        tenant_id: 'BIL',
        actor_username: 'system',
        action: 'cbs.call.test',
        outcome: 'success',
        severity: 'info',
        metadata: {},
      }),
    ).not.toThrow();
  });
});
