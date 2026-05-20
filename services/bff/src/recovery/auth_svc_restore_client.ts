// services/bff/src/recovery/auth_svc_restore_client.ts
//
// Recovery Center Phase 2d — BFF → auth-svc restore callback.
//
// When a SPA admin clicks "Restore" on a Recycle Bin row whose
// entity_type belongs to auth-svc (`user_team`, `user_team_member`,
// future: `dashboard_widget` / `service_client` / `user`), the BFF
// recovery route looks up the registered adapter, which calls this
// client to HTTP-POST the payload back to auth-svc's restore
// endpoint.
//
// Direction is BFF → auth-svc (reverse of Phase 2a archive flow
// which went source-service → BFF). Different auth model: this
// path uses a shared-secret env var (`AUTH_SVC_RECOVERY_RESTORE_KEY`)
// because auth-svc would otherwise need to mint+verify a BFF api-key
// of its own, which would loop back to BFF — too much ceremony for
// a trusted service-to-service call.
//
// Best-effort posture does NOT apply here: restore failures MUST
// surface to the operator as a typed error so the SPA Recycle Bin
// can show "restore failed" and the operator can retry or escalate.
// The route caller catches RestoreConflictError + the generic
// RecoveryError class and maps to the right HTTP status.

import { RecoveryError, RestoreConflictError } from './types';

/** Subset of error codes this client can produce. The BFF recovery
 *  route's catch block already understands these via RecoveryError. */
export type AuthSvcRestoreErrorCode =
  | 'auth_svc_unreachable'      // fetch threw
  | 'auth_svc_misconfigured'    // env vars unset
  | 'auth_svc_unauthorized'     // 401 from auth-svc (shared key wrong)
  | 'auth_svc_disabled'         // 503 from auth-svc (AUTH_SVC_RECOVERY_RESTORE_KEY unset there)
  | 'auth_svc_bad_payload'      // 400 from auth-svc (payload validation failed)
  | 'auth_svc_unknown_entity'   // 400 from auth-svc (entity_type not handled)
  | 'auth_svc_parent_missing'   // 404 (member restore when team is gone — operator must restore team first)
  | 'auth_svc_server_error';    // 5xx from auth-svc

export interface AuthSvcRestoreClientOptions {
  baseUrl: string;
  restoreKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export interface AuthSvcRestoreRequest {
  entity_type: 'user_team' | 'user_team_member';
  original_id: string;
  payload: Record<string, unknown>;
}

export class AuthSvcRestoreClient {
  private readonly baseUrl: string;
  private readonly restoreKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AuthSvcRestoreClientOptions) {
    if (!opts.baseUrl) throw new Error('AuthSvcRestoreClient: baseUrl required');
    if (!opts.restoreKey) throw new Error('AuthSvcRestoreClient: restoreKey required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.restoreKey = opts.restoreKey;
    this.fetchImpl =
      opts.fetchImpl ??
      (globalThis as { fetch?: typeof fetch }).fetch ??
      ((): never => {
        throw new RecoveryError(
          'invalid_input',
          'no fetch available — pass fetchImpl or run on Node 18+',
        );
      });
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** POST /auth/recovery/restore. Throws a RecoveryError subclass on
   *  any non-2xx response so the BFF recovery route's catch maps to
   *  the right HTTP status (409 / 404 / 503 / 500). No retries — the
   *  operator's "Restore" click is one shot; the SPA shows the error
   *  and asks them to try again. */
  async restore(req: AuthSvcRestoreRequest): Promise<void> {
    const url = `${this.baseUrl}/auth/recovery/restore`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Recovery-Restore-Key': this.restoreKey,
          'X-Source-System': 'bff-recovery-restore',
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
    } catch (err) {
      throw new RecoveryError(
        'invalid_input',
        `auth-svc unreachable: ${err instanceof Error ? err.message : String(err)}`,
        { adapter_code: 'auth_svc_unreachable' as AuthSvcRestoreErrorCode },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 201 || res.status === 200) return;

    // Try to parse the JSON error envelope; fall back to status-only
    // if the body isn't JSON (auth-svc body-parser may have rejected).
    let body: { error?: string; message?: string; team_id?: string } = {};
    try {
      body = (await res.json()) as { error?: string; message?: string; team_id?: string };
    } catch {
      // ignore
    }

    if (res.status === 401) {
      throw new RecoveryError(
        'invalid_input',
        `auth-svc rejected the shared-secret restore key`,
        { adapter_code: 'auth_svc_unauthorized' as AuthSvcRestoreErrorCode, status: 401 },
      );
    }
    if (res.status === 503) {
      throw new RecoveryError(
        'invalid_input',
        `auth-svc restore endpoint is disabled (AUTH_SVC_RECOVERY_RESTORE_KEY not configured)`,
        { adapter_code: 'auth_svc_disabled' as AuthSvcRestoreErrorCode, status: 503 },
      );
    }
    if (res.status === 409) {
      // Maps to the BFF route's 409 already_restored / restore_conflict path.
      throw new RestoreConflictError(req.entity_type, req.original_id);
    }
    if (res.status === 404) {
      // Member restore when team is gone — operator must restore team first.
      throw new RecoveryError(
        'restore_conflict',
        body.message ?? `auth-svc could not find the parent record for ${req.original_id}`,
        {
          adapter_code: 'auth_svc_parent_missing' as AuthSvcRestoreErrorCode,
          status: 404,
          ...(body.team_id && { parent_team_id: body.team_id }),
        },
      );
    }
    if (res.status === 400) {
      if (body.error === 'unknown_entity_type') {
        throw new RecoveryError(
          'no_adapter',
          body.message ?? `auth-svc cannot restore entity_type "${req.entity_type}"`,
          { adapter_code: 'auth_svc_unknown_entity' as AuthSvcRestoreErrorCode },
        );
      }
      throw new RecoveryError(
        'invalid_input',
        body.message ?? `auth-svc rejected payload (${body.error ?? 'no error code'})`,
        { adapter_code: 'auth_svc_bad_payload' as AuthSvcRestoreErrorCode, status: 400 },
      );
    }

    // 5xx + everything else.
    throw new RecoveryError(
      'invalid_input',
      `auth-svc returned ${res.status}: ${body.error ?? body.message ?? 'unknown error'}`,
      { adapter_code: 'auth_svc_server_error' as AuthSvcRestoreErrorCode, status: res.status },
    );
  }
}

/** Factory: returns a client if both env vars are set, else null.
 *  When null, the BFF adapter registration for auth-svc entity_types
 *  is skipped — clicking Restore on an auth-svc row will return 501
 *  no_adapter, which is the correct fail-closed posture. */
export function makeAuthSvcRestoreClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuthSvcRestoreClient | null {
  const baseUrl = env.AUTH_SVC_BASE_URL;
  const restoreKey = env.AUTH_SVC_RECOVERY_RESTORE_KEY;
  if (!baseUrl || !restoreKey) return null;
  return new AuthSvcRestoreClient({ baseUrl, restoreKey });
}
