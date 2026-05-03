// services/bff/src/envelope.ts
//
// Bank-grade request/response envelope (Banking API Integration §5, §6, §11).
//
// Existing /v1 endpoints return raw payloads; this module introduces an
// opt-in envelope for endpoints that target external partners — LOS, mobile
// app, regulator integrations — where the doc explicitly mandates:
//
//   request:  { header: { tenantId, channel, requestId, timestamp }, body }
//   response: { header: { status, code, message, requestId, timestamp }, body }
//   error:    { error:  { code, message, severity }, header: { requestId, timestamp } }
//
// The envelope is additive: legacy routes keep their existing shape, new
// routes (and migrated routes flagged in T4.24) use these helpers. Callers
// throw `EnterpriseError` to short-circuit into the standardized error
// shape; uncaught throws bubble to the route's existing 500 handler.

import { randomUUID } from 'node:crypto';

/** Severity per Banking API doc §11 — drives partner alerting + audit triage. */
export type ErrorSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RequestHeader {
  tenantId: string;
  channel: string;
  requestId: string;       // UUID echoed back in the response header
  timestamp: string;       // ISO8601 from the caller
}

export interface RequestEnvelope<T = unknown> {
  header: RequestHeader;
  body: T;
}

export interface ResponseHeader {
  status: 'SUCCESS' | 'FAILURE';
  code: string;            // 'EWS_200', 'EWS_201' on success; 'EWS_400' etc. on error
  message: string;
  requestId: string;
  timestamp: string;
}

export interface ResponseEnvelope<T = unknown> {
  header: ResponseHeader;
  body: T;
}

export interface ErrorPayload {
  code: string;
  message: string;
  severity: ErrorSeverity;
  detail?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  header: { status: 'FAILURE'; requestId: string; timestamp: string };
  error: ErrorPayload;
}

/** Context derived from the request — what the response header echoes back. */
export interface EnvelopeContext {
  /** Mirrors the request `requestId` if present; otherwise a fresh UUID. */
  requestId?: string;
  /** ISO8601; defaults to `now()`. */
  timestamp?: string;
}

function ensureContext(ctx: EnvelopeContext = {}): Required<EnvelopeContext> {
  return {
    requestId: ctx.requestId ?? randomUUID(),
    timestamp: ctx.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Build a success response envelope.
 *   wrapResponse(body, { requestId, timestamp })
 * Defaults code to EWS_200 + message "Processed Successfully" per the doc's
 * §6 reference response. Pass an explicit override for 201/202 etc.
 */
export function wrapResponse<T>(
  body: T,
  ctx: EnvelopeContext = {},
  overrides: Partial<Pick<ResponseHeader, 'code' | 'message'>> = {},
): ResponseEnvelope<T> {
  const { requestId, timestamp } = ensureContext(ctx);
  return {
    header: {
      status: 'SUCCESS',
      code: overrides.code ?? 'EWS_200',
      message: overrides.message ?? 'Processed Successfully',
      requestId,
      timestamp,
    },
    body,
  };
}

/**
 * Build an error response envelope.
 *   wrapError({ code, message, severity, detail }, { requestId, timestamp })
 */
export function wrapError(
  err: ErrorPayload,
  ctx: EnvelopeContext = {},
): ErrorEnvelope {
  const { requestId, timestamp } = ensureContext(ctx);
  return {
    header: { status: 'FAILURE', requestId, timestamp },
    error: err,
  };
}

/**
 * Throw to abort a route handler with a standardized error envelope.
 * The route's catch block converts this to `wrapError(...)` + the http
 * status carried on the instance.
 */
export class EnterpriseError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: ErrorPayload,
  ) {
    super(payload.message);
    this.name = 'EnterpriseError';
  }
}

/** Extract `requestId` from a request envelope, falling back to a new UUID. */
export function readRequestId(envelope: unknown): string | undefined {
  const r = envelope as { header?: { requestId?: unknown } } | null | undefined;
  const v = r?.header?.requestId;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Build an EnvelopeContext from the inbound request — preferring the
 * envelope's `header.requestId`, then the `X-Request-Id` HTTP header,
 * then a fresh UUID inside `wrapResponse` / `wrapError`.
 *
 * Works on both Express and Fastify-shaped requests; only the
 * `headers` and `body` fields are touched.
 */
export function extractCtx(
  req: { headers?: Record<string, string | string[] | undefined>; body?: unknown },
  now: () => Date = () => new Date(),
): Required<EnvelopeContext> {
  const fromBody = readRequestId(req.body);
  const headerVal = req.headers?.['x-request-id'];
  const fromHeader = typeof headerVal === 'string' ? headerVal : undefined;
  return {
    requestId: fromBody ?? fromHeader ?? randomUUID(),
    timestamp: now().toISOString(),
  };
}
