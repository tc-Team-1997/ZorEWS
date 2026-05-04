// services/bff/src/api_key_auth.ts
//
// T6 M1.3 — API key auth middleware.
//
// M1.2 ships the API key store + verify primitive. M1.3 wires the
// Express middleware that accepts an `Authorization: Bearer apex_…`
// header, resolves the caller to (tenant_id, scopes), populates
// `req.apiKey` + `req.tenant`, and touches the key's last_used_at.
//
// Two middlewares + one helper:
//
//   optionalApiKeyAuth(store, now)  — try to authenticate. If a Bearer
//     header is present and verifies, populate req.apiKey + req.tenant
//     and call next(). If a Bearer header is present but FAILS to
//     verify, respond 401. If no Bearer header at all, fall through
//     silently to next() — letting downstream middleware (eg the
//     human-auth requireTenantMw) handle the request.
//
//   requireApiKey(now)  — fails the request 401 if req.apiKey isn't
//     set. Use AFTER optionalApiKeyAuth to enforce machine-only
//     surface (eg /v1/svc/*).
//
//   requireScope(scope)  — fails the request 403 if req.apiKey is
//     present but doesn't carry the required scope. Use AFTER
//     requireApiKey.
//
// Design notes:
//   - The middleware does NOT touch X-Tenant-ID or X-Channel — when
//     api-key auth succeeds, those headers are ignored. This is the
//     correct security stance: a service account's tenant binding is
//     baked into the key itself; a presented X-Tenant-ID can't override.
//   - touch() is best-effort. If it fails (eg key was revoked between
//     verify and touch in a race), we still let the request through
//     for THIS turn — the next request will be re-verified.
//   - 401 envelope shape matches the rest of the BFF (T4.24 envelope).

import type { NextFunction, Request, Response } from 'express';
import { wrapError, extractCtx, type ErrorSeverity } from './envelope';
import { type ApiKeyStore, type ApiKeyEntry, type ApiKeyScope } from './api_keys';

// ─── Public types ──────────────────────────────────────────────────────

export interface ApiKeyAuthContext {
  /** The verified entry — same redacted shape as `GET /v1/admin/api-keys/:id`. */
  entry: ApiKeyEntry;
  /** Convenience flat copy of entry.scopes — what `requireScope` checks. */
  scopes: readonly ApiKeyScope[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyAuthContext;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

const BEARER_RE = /^Bearer\s+(apex_[a-z0-9]{12}\.[0-9a-f]{48})$/;

function extractBearer(req: Request): string | null {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string') return null;
  const m = BEARER_RE.exec(raw);
  return m ? m[1]! : null;
}

function unauthenticated(
  req: Request,
  res: Response,
  now: () => Date,
  message: string,
  severity: ErrorSeverity = 'MEDIUM',
): Response {
  const ctx = extractCtx(req, now);
  return res.status(401).json(
    wrapError({ code: 'EWS_401_invalid_api_key', message, severity }, ctx),
  );
}

// ─── Middlewares ──────────────────────────────────────────────────────

/**
 * Try to authenticate via Authorization: Bearer apex_…
 *  - no header              → fall through to next() (req.apiKey undefined)
 *  - header present, valid  → set req.apiKey + req.tenant, touch, next()
 *  - header present, bad    → 401 EWS_401_invalid_api_key
 */
export function optionalApiKeyAuth(store: ApiKeyStore, now: () => Date) {
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    const raw = req.headers['authorization'];
    if (typeof raw !== 'string' || raw.length === 0) {
      // No header at all — let downstream middleware handle.
      return next();
    }
    if (!raw.toLowerCase().startsWith('bearer ')) {
      // Some other auth scheme (Basic, etc.) — not ours, leave alone.
      return next();
    }
    const presented = extractBearer(req);
    if (!presented) {
      return unauthenticated(req, res, now, 'Authorization header is malformed');
    }
    const verified = store.verify(presented, now());
    if (!verified) {
      return unauthenticated(
        req,
        res,
        now,
        'API key is invalid, revoked, or expired',
      );
    }
    // Populate context.
    req.apiKey = {
      entry: verified.entry,
      scopes: verified.entry.scopes,
    };
    req.tenant = {
      tenant_id: verified.tenant_id,
      // The Tenant interface requires name/vertical/channels_allowed/active
      // — for the service-account path we don't have those at hand, so fill
      // in safe defaults. Routes downstream that genuinely need the rich
      // tenant record can re-resolve via tenantLookup.
      name: verified.tenant_id,
      vertical: 'banking',
      channels_allowed: ['API'],
      active: true,
    };
    req.channel = 'API';
    // Best-effort touch — don't block the request if this races a revoke.
    try {
      store.touch(verified.tenant_id, verified.entry.key_id, now());
    } catch {
      // swallow
    }
    return next();
  };
}

/**
 * Require api-key auth. Use AFTER optionalApiKeyAuth.
 */
export function requireApiKey(now: () => Date) {
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    if (!req.apiKey) {
      return unauthenticated(
        req,
        res,
        now,
        'API key required (Authorization: Bearer apex_…)',
      );
    }
    return next();
  };
}

/**
 * Require a specific scope on the verified api key. Use AFTER
 * requireApiKey. Returns 403 + EWS_403_missing_scope when the
 * caller is authenticated but lacks the scope.
 */
export function requireScope(scope: ApiKeyScope, now: () => Date) {
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    if (!req.apiKey) {
      // Defensive: this middleware should follow requireApiKey.
      return unauthenticated(req, res, now, 'API key required');
    }
    if (!req.apiKey.scopes.includes(scope)) {
      const ctx = extractCtx(req, now);
      return res.status(403).json(
        wrapError(
          {
            code: 'EWS_403_missing_scope',
            message: `API key does not carry scope: ${scope}`,
            severity: 'MEDIUM',
          },
          ctx,
        ),
      );
    }
    return next();
  };
}
