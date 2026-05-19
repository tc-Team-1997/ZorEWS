// services/bff/src/recovery/archive_client.ts
//
// RecoveryArchiveClient — thin, dep-free TS wrapper around the
// cross-service archive endpoint shipped in Phase 2a:
//
//   POST /v1/svc/recovery/archive
//
// Lives in BFF next to the contract it wraps so the types stay in
// sync. Non-BFF services (auth-svc / cases-svc / alerts-svc /
// rules-svc) either:
//   - copy this file into their own src tree (simplest path for the
//     prototype — ~120 LOC, zero deps beyond global fetch + crypto)
//   - or import from a future shared @apex-ews/recovery-client workspace
//     package (out of scope for this commit; the codebase doesn't yet
//     have a shared TS workspace pattern for service-shared code)
//
// Why a client at all (vs. raw fetch)?
//   - One place for error mapping (401 invalid_key / 403 missing_scope
//     / 400 invalid_input / 5xx → typed exceptions adopters catch)
//   - One place for the request-envelope details (the BFF accepts both
//     raw + {header, body} shapes; we pick one and stay consistent)
//   - Auto-retry on 502/503/504 with a small back-off, since the BFF
//     might be rolling
//   - Type-safe ArchiveInput so adopters can't misspell field names
//
// What this DOESN'T do:
//   - Restore. That's Phase 2b — different scope, different endpoint,
//     different direction of the auth flow.
//   - Manage the api-key secret. Callers pass the bearer token; key
//     storage / rotation is the source service's responsibility.

import type { ArchiveInput, DeletedRecord, RecoveryModule } from './types';

/** Input shape — same as ArchiveInput minus tenant_id (the BFF binds
 *  tenant from the verified key — callers cannot override). */
export interface ArchiveRequest {
  module: Exclude<RecoveryModule, 'bff'>;
  entity_type: string;
  original_id: string;
  original_table: string;
  payload: Record<string, unknown>;
  deleted_by: string;
  deletion_reason?: string | null;
  source_action?: string | null;
  prior_status?: string | null;
}

/** Success response from POST /v1/svc/recovery/archive. */
export interface ArchiveResponse {
  recovery_id: string;
  archived: DeletedRecord;
}

/** Typed error subtypes — adopters pattern-match on `.code`. */
export class RecoveryArchiveError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'invalid_api_key'
      | 'missing_scope'
      | 'server_error'
      | 'network_error',
    message: string,
    public readonly httpStatus?: number,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RecoveryArchiveError';
  }
}

export interface RecoveryArchiveClientOptions {
  /** Base URL of the BFF, no trailing slash. e.g. 'https://bff.bil.local'. */
  baseUrl: string;
  /** Plaintext api-key bearer token (the apex_<prefix>.<secret> string
   *  returned ONCE from POST /v1/admin/api-keys). Read at construction
   *  time; if the source service rotates keys, build a new client. */
  apiKey: string;
  /** Optional override — defaults to globalThis.fetch (Node 18+). Tests
   *  inject a stub to assert wire shape. */
  fetchImpl?: typeof fetch;
  /** Retry policy. Defaults: 2 retries on 502/503/504 + network errors,
   *  back-off 100ms / 400ms. */
  maxRetries?: number;
  retryDelays?: number[];
  /** Per-request timeout in ms. Default 5_000. AbortController wires
   *  this to fetch. */
  timeoutMs?: number;
}

const DEFAULT_RETRY_DELAYS = [100, 400];
const DEFAULT_TIMEOUT_MS = 5_000;

export class RecoveryArchiveClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelays: number[];
  private readonly timeoutMs: number;

  constructor(opts: RecoveryArchiveClientOptions) {
    if (!opts.baseUrl) throw new Error('RecoveryArchiveClient: baseUrl required');
    if (!opts.apiKey) throw new Error('RecoveryArchiveClient: apiKey required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    // globalThis.fetch is the Node 18+ built-in. Tests pass fetchImpl.
    this.fetchImpl =
      opts.fetchImpl ??
      (globalThis as { fetch?: typeof fetch }).fetch ??
      ((): never => {
        throw new RecoveryArchiveError(
          'network_error',
          'no fetch available — pass fetchImpl or run on Node 18+',
        );
      });
    this.retryDelays = opts.retryDelays ?? DEFAULT_RETRY_DELAYS;
    this.maxRetries = opts.maxRetries ?? this.retryDelays.length;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Archive a row into the central app_recovery.deleted_records
   *  table BEFORE the source service deletes it from its own table.
   *
   *  Throws RecoveryArchiveError on any non-2xx response. Callers MAY
   *  choose to proceed with the local delete on archive failure (the
   *  doc-recommended best-effort posture) — wrap with try/catch and
   *  log accordingly.
   *
   *  @example
   *    const client = new RecoveryArchiveClient({
   *      baseUrl: process.env.BFF_BASE_URL!,
   *      apiKey:  process.env.BFF_RECOVERY_API_KEY!,
   *    });
   *    try {
   *      await client.archive({
   *        module: 'auth-svc',
   *        entity_type: 'user_team',
   *        original_id: team.team_id,
   *        original_table: 'app_iam.user_teams',
   *        payload: team,
   *        deleted_by: actor,
   *        source_action: 'user_initiated',
   *      });
   *    } catch (err) {
   *      console.warn('[teams] archive failed; proceeding with delete', err);
   *    }
   *    await teamStore.delete(team.team_id);
   */
  async archive(req: ArchiveRequest): Promise<ArchiveResponse> {
    // Client-side validation: catches typos before the round-trip. The
    // BFF will re-validate (it has to — never trust the wire), so this
    // is purely a friendly-error layer.
    if (!req.module || (req.module as string) === 'bff') {
      throw new RecoveryArchiveError(
        'invalid_input',
        "module must be one of 'auth-svc' | 'cases-svc' | 'alerts-svc' | 'rules-svc' ('bff' is rejected — call recoveryStore.archive() directly)",
      );
    }
    if (!req.entity_type?.trim()) {
      throw new RecoveryArchiveError('invalid_input', 'entity_type required');
    }
    if (!req.original_id?.trim()) {
      throw new RecoveryArchiveError('invalid_input', 'original_id required');
    }
    if (!req.original_table?.trim()) {
      throw new RecoveryArchiveError('invalid_input', 'original_table required');
    }
    if (!req.deleted_by?.trim()) {
      throw new RecoveryArchiveError('invalid_input', 'deleted_by required');
    }
    if (!req.payload || typeof req.payload !== 'object' || Array.isArray(req.payload)) {
      throw new RecoveryArchiveError('invalid_input', 'payload must be an object');
    }

    const url = `${this.baseUrl}/v1/svc/recovery/archive`;
    const body = JSON.stringify({
      module: req.module,
      entity_type: req.entity_type,
      original_id: req.original_id,
      original_table: req.original_table,
      payload: req.payload,
      deleted_by: req.deleted_by,
      ...(req.deletion_reason !== undefined && { deletion_reason: req.deletion_reason }),
      ...(req.source_action !== undefined && { source_action: req.source_action }),
      ...(req.prior_status !== undefined && { prior_status: req.prior_status }),
    });

    let lastErr: unknown;
    // attempt = 0 is the first try; subsequent attempts use retryDelays.
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelays[attempt - 1] ?? this.retryDelays[this.retryDelays.length - 1] ?? 0;
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await this.attemptOnce(url, body);
      } catch (err) {
        lastErr = err;
        // Only retry transient failures — 5xx (other than 500 which is
        // typically a programming bug not a transient hiccup) +
        // network errors. 4xx and 500 surface immediately.
        if (err instanceof RecoveryArchiveError) {
          const status = err.httpStatus ?? 0;
          const transient = err.code === 'network_error' || [502, 503, 504].includes(status);
          if (!transient) throw err;
        } else {
          // Unknown shape — surface as network error and retry.
          lastErr = new RecoveryArchiveError(
            'network_error',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new RecoveryArchiveError('network_error', 'archive failed after retries');
  }

  private async attemptOnce(url: string, body: string): Promise<ArchiveResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // X-Channel marker for the BFF tenant middleware; api-key auth
          // doesn't require X-Tenant-ID but downstream logging picks
          // this up to distinguish machine traffic from operator UI.
          'X-Channel': 'API',
          'X-Source-System': 'recovery-archive-client',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new RecoveryArchiveError(
        'network_error',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      // Some 5xx + body-parser errors return HTML. Treat as transient.
      throw new RecoveryArchiveError(
        res.status >= 500 ? 'server_error' : 'invalid_input',
        `non-JSON response (status ${res.status})`,
        res.status,
      );
    }

    if (res.status === 201 || res.status === 200) {
      const body = (parsed as { body?: ArchiveResponse }).body;
      if (!body || !body.recovery_id) {
        throw new RecoveryArchiveError(
          'server_error',
          'envelope missing body.recovery_id',
          res.status,
        );
      }
      return body;
    }

    // Error envelope: {header, error: {code, message, severity}}
    const err = (parsed as { error?: { code?: string; message?: string } }).error;
    const code = err?.code ?? '';
    const message = err?.message ?? `archive failed (status ${res.status})`;

    if (res.status === 401) {
      throw new RecoveryArchiveError('invalid_api_key', message, 401);
    }
    if (res.status === 403) {
      throw new RecoveryArchiveError('missing_scope', message, 403, { code });
    }
    if (res.status === 400) {
      throw new RecoveryArchiveError('invalid_input', message, 400, { code });
    }
    if (res.status >= 500) {
      throw new RecoveryArchiveError('server_error', message, res.status, { code });
    }
    throw new RecoveryArchiveError(
      'server_error',
      `unexpected status ${res.status}: ${message}`,
      res.status,
      { code },
    );
  }
}

/** Re-export the input type so adopters don't need a separate import. */
export type { ArchiveInput };
