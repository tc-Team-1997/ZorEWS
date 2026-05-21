// services/bff/src/integrations/cbs_production.ts
//
// T3.1.1 — Production CBS adapter resilience framework.
//
// Layered ON TOP of the existing CBS surface (cbs_sync.ts + the OpenAPI
// mock at integrations/cbs) — adds the patterns a real bank-CBS adapter
// needs in production: retry with exponential back-off, circuit
// breaker, request-level audit-trail wiring, observability hooks.
//
// Additive only:
//   - cbs_sync.ts unchanged (ledger + reconciliation surface stable)
//   - Pure wrapper — `ResilientCbsClient` decorates any underlying
//     CBS impl with the production patterns
//   - Hooks into the existing M15.1 AuditTrailStore for action logging
//   - No new schema; no new BFF routes (works through the existing
//     /v1/integrations/cbs/* surface)

import { setTimeout as delay } from 'node:timers/promises';

// ─── Underlying client contract ──────────────────────────────────────
//
// Any concrete CBS impl (HTTP REST, SOAP gateway, file drop, test
// stub) satisfies this minimal contract. ResilientCbsClient wraps it.

export interface CbsRequest {
  /** Logical operation name — used in retry / audit metadata. */
  operation: string;
  /** Idempotency key — same key + same payload returns cached receipt. */
  idempotency_key?: string;
  /** Caller-supplied payload (passed through unchanged to the impl). */
  payload?: unknown;
}

export interface CbsResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T;
  /** True when the CBS gateway accepted but the operation is async-
   *  processed downstream. The caller polls via a follow-up request. */
  pending?: boolean;
  /** Surfaced when ok=false. Carries the bank-side error message or a
   *  local diagnostic (timeout / unknown operation). Not consumed by
   *  ResilientCbsClient's retry decision logic — purely audit + logs.
   *  Optional + additive vs the v1 contract. */
  error?: string;
}

export interface CbsClient {
  call<T = unknown>(req: CbsRequest): Promise<CbsResponse<T>>;
}

// ─── Retry policy ────────────────────────────────────────────────────

export interface RetryPolicy {
  /** Max attempts INCLUDING the initial. 1 = no retries. */
  max_attempts: number;
  /** Base back-off in ms; doubled per attempt up to max_backoff_ms. */
  initial_backoff_ms: number;
  max_backoff_ms: number;
  /** ±jitter percentage applied to each back-off. */
  jitter: number;
  /** HTTP statuses that should trigger a retry. 5xx + 429 by default. */
  retryable_statuses: ReadonlySet<number>;
  /** Operations explicitly NON-retryable regardless of status. */
  non_retryable_operations?: ReadonlySet<string>;
}

export const DEFAULT_CBS_RETRY_POLICY: RetryPolicy = {
  max_attempts: 4,
  initial_backoff_ms: 250,
  max_backoff_ms: 8_000,
  jitter: 0.2,
  retryable_statuses: new Set([429, 500, 502, 503, 504]),
};

/** Pure backoff computation — exposed for tests. */
export function computeBackoffMs(
  attempt: number, // 1-indexed (1 = first failure → backoff before attempt 2)
  policy: RetryPolicy,
  randomFn: () => number = Math.random,
): number {
  const base = Math.min(policy.max_backoff_ms, policy.initial_backoff_ms * 2 ** (attempt - 1));
  const jitterMs = base * policy.jitter * (randomFn() * 2 - 1); // ±jitter
  return Math.max(0, Math.round(base + jitterMs));
}

// ─── Circuit breaker ─────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Consecutive failures that flip closed → open. */
  failure_threshold: number;
  /** Time in ms before open → half_open. */
  recovery_timeout_ms: number;
  /** Successes in half_open required to close. */
  half_open_success_threshold: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerConfig = {
  failure_threshold: 5,
  recovery_timeout_ms: 30_000,
  half_open_success_threshold: 2,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private openedAt: number | null = null;

  constructor(private readonly cfg: CircuitBreakerConfig, private readonly clock: () => number = Date.now) {}

  /** Inspect the current state — recomputes open→half_open if the
   *  recovery window has elapsed. */
  currentState(): CircuitState {
    if (this.state === 'open' && this.openedAt !== null) {
      if (this.clock() - this.openedAt >= this.cfg.recovery_timeout_ms) {
        this.state = 'half_open';
        this.halfOpenSuccesses = 0;
      }
    }
    return this.state;
  }

  /** True iff a request may proceed. */
  allow(): boolean {
    const s = this.currentState();
    return s !== 'open';
  }

  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.cfg.half_open_success_threshold) {
        this.state = 'closed';
        this.consecutiveFailures = 0;
        this.openedAt = null;
      }
    } else if (this.state === 'closed') {
      this.consecutiveFailures = 0;
    }
  }

  recordFailure(): void {
    if (this.state === 'half_open') {
      // Any failure in half_open reopens immediately.
      this.state = 'open';
      this.openedAt = this.clock();
      this.consecutiveFailures = this.cfg.failure_threshold;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.cfg.failure_threshold) {
      this.state = 'open';
      this.openedAt = this.clock();
    }
  }

  /** Snapshot for observability + tests. */
  snapshot(): {
    state: CircuitState;
    consecutive_failures: number;
    opened_at: number | null;
  } {
    return {
      state: this.currentState(),
      consecutive_failures: this.consecutiveFailures,
      opened_at: this.openedAt,
    };
  }
}

// ─── Audit-trail hook ────────────────────────────────────────────────
//
// Pluggable so production can wire the existing M15.1 AuditTrailStore
// without forcing a hard import dependency here.

export interface CbsAuditSink {
  record(event: {
    tenant_id: string;
    actor_username: string;
    action: string; // e.g. 'cbs.call.loan_pull'
    outcome: 'success' | 'failure' | 'denied';
    severity: 'info' | 'warning' | 'critical';
    metadata: Record<string, unknown>;
  }): void;
}

/** No-op sink used in tests + when audit isn't wired. */
export class NoopCbsAuditSink implements CbsAuditSink {
  record(_event: Parameters<CbsAuditSink['record']>[0]): void {
    void _event;
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export class CbsCircuitOpenError extends Error {
  override name = 'CbsCircuitOpenError';
  constructor(public operation: string) {
    super(`CBS circuit is OPEN for ${operation} — request rejected without dispatch`);
  }
}

export class CbsRetryExhaustedError extends Error {
  override name = 'CbsRetryExhaustedError';
  constructor(
    public operation: string,
    public attempts: number,
    public lastStatus: number | null,
    public cause: Error | null,
  ) {
    super(
      `CBS ${operation} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}` +
        (lastStatus !== null ? ` (last status ${lastStatus})` : ''),
    );
  }
}

// ─── ResilientCbsClient ──────────────────────────────────────────────

export interface ResilientCbsOptions {
  retryPolicy?: Partial<RetryPolicy>;
  circuit?: CircuitBreaker;
  audit?: CbsAuditSink;
  /** Caller actor for audit events (default 'system:cbs-adapter'). */
  actor?: string;
  /** Deterministic clock for tests. */
  clock?: () => number;
  /** Deterministic random for tests. */
  randomFn?: () => number;
  /** Optional sleep override for tests (avoid real timers). */
  sleepMs?: (ms: number) => Promise<void>;
}

export interface DispatchOutcome<T = unknown> {
  response: CbsResponse<T>;
  attempts: number;
  total_latency_ms: number;
  circuit_state: CircuitState;
}

const RESILIENCE_DEFAULT_SLEEP = (ms: number) => delay(ms);

export class ResilientCbsClient {
  private readonly retry: RetryPolicy;
  private readonly circuit: CircuitBreaker;
  private readonly audit: CbsAuditSink;
  private readonly actor: string;
  private readonly clock: () => number;
  private readonly randomFn: () => number;
  private readonly sleepMs: (ms: number) => Promise<void>;

  constructor(
    private readonly inner: CbsClient,
    opts: ResilientCbsOptions = {},
  ) {
    this.retry = { ...DEFAULT_CBS_RETRY_POLICY, ...opts.retryPolicy };
    this.circuit = opts.circuit ?? new CircuitBreaker(DEFAULT_CIRCUIT_BREAKER);
    this.audit = opts.audit ?? new NoopCbsAuditSink();
    this.actor = opts.actor ?? 'system:cbs-adapter';
    this.clock = opts.clock ?? Date.now;
    this.randomFn = opts.randomFn ?? Math.random;
    this.sleepMs = opts.sleepMs ?? RESILIENCE_DEFAULT_SLEEP;
  }

  async dispatch<T = unknown>(
    req: CbsRequest,
    tenant_id: string,
  ): Promise<DispatchOutcome<T>> {
    if (!tenant_id) {
      throw new Error('tenant_id required for CBS dispatch');
    }
    if (!this.circuit.allow()) {
      this.audit.record({
        tenant_id,
        actor_username: this.actor,
        action: `cbs.call.${req.operation}`,
        outcome: 'denied',
        severity: 'warning',
        metadata: {
          reason: 'circuit_open',
          idempotency_key: req.idempotency_key ?? null,
        },
      });
      throw new CbsCircuitOpenError(req.operation);
    }

    const start = this.clock();
    let lastError: Error | null = null;
    let lastStatus: number | null = null;

    const nonRetryable = this.retry.non_retryable_operations?.has(req.operation) ?? false;
    const effectiveAttempts = nonRetryable ? 1 : this.retry.max_attempts;

    for (let attempt = 1; attempt <= effectiveAttempts; attempt++) {
      try {
        const response = await this.inner.call<T>(req);
        if (response.ok) {
          this.circuit.recordSuccess();
          this.audit.record({
            tenant_id,
            actor_username: this.actor,
            action: `cbs.call.${req.operation}`,
            outcome: 'success',
            severity: 'info',
            metadata: {
              attempts: attempt,
              status: response.status,
              idempotency_key: req.idempotency_key ?? null,
              pending: response.pending ?? false,
            },
          });
          return {
            response,
            attempts: attempt,
            total_latency_ms: this.clock() - start,
            circuit_state: this.circuit.snapshot().state,
          };
        }

        lastStatus = response.status;
        const retryable = this.retry.retryable_statuses.has(response.status);
        if (!retryable || attempt >= effectiveAttempts) {
          this.circuit.recordFailure();
          this.audit.record({
            tenant_id,
            actor_username: this.actor,
            action: `cbs.call.${req.operation}`,
            outcome: 'failure',
            severity: response.status >= 500 ? 'critical' : 'warning',
            metadata: {
              attempts: attempt,
              status: response.status,
              non_retryable: !retryable,
              idempotency_key: req.idempotency_key ?? null,
            },
          });
          throw new CbsRetryExhaustedError(req.operation, attempt, response.status, null);
        }
        // else: fall through to backoff + retry
      } catch (err) {
        // Network exception (not an HTTP-status failure).
        if (err instanceof CbsRetryExhaustedError) {
          throw err;
        }
        lastError = err as Error;
        if (attempt >= effectiveAttempts) {
          this.circuit.recordFailure();
          this.audit.record({
            tenant_id,
            actor_username: this.actor,
            action: `cbs.call.${req.operation}`,
            outcome: 'failure',
            severity: 'critical',
            metadata: {
              attempts: attempt,
              error: lastError.message,
              idempotency_key: req.idempotency_key ?? null,
            },
          });
          throw new CbsRetryExhaustedError(req.operation, attempt, lastStatus, lastError);
        }
      }

      // Back-off before next attempt.
      const wait = computeBackoffMs(attempt, this.retry, this.randomFn);
      await this.sleepMs(wait);
    }

    // Unreachable — defensive.
    throw new CbsRetryExhaustedError(req.operation, effectiveAttempts, lastStatus, lastError);
  }

  /** Read-only snapshot for ops dashboards. */
  circuitSnapshot(): ReturnType<CircuitBreaker['snapshot']> {
    return this.circuit.snapshot();
  }
}
