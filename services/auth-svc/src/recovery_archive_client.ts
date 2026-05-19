// services/auth-svc/src/recovery_archive_client.ts
//
// Self-contained copy of services/bff/src/recovery/archive_client.ts —
// the typed wrapper around the central Recovery Center cross-service
// archive endpoint shipped in Phase 2a:
//
//   POST <BFF>/v1/svc/recovery/archive
//
// Adopted here for auth-svc's team-deletion paths (Phase 2c, first
// cross-service adopter). When the source service deletes a row
// (DELETE /auth/teams/:id or .../members/:user_id), it archives a
// full snapshot to the BFF FIRST, so admins can restore via the SPA
// Recycle Bin if the delete turns out to be a mistake.
//
// Adoption pattern (per docs/recovery-center.md §"Cross-service adoption"):
// each non-BFF service copies this file into its own src/. Types are
// inlined here so the file has zero cross-service imports — when
// services/event-bus-style shared workspace ships, this can move to
// a package.
//
// Differences vs. the BFF original:
//   - inlined ArchiveInput / DeletedRecord / RecoveryModule types
//   - exports a RecoveryArchiver interface so route handlers depend on
//     a one-method contract (easy to stub in tests)
//   - same wire format, same retry policy, same error mapping

// ─── Inlined recovery types (keep in sync with services/bff/src/recovery/types.ts) ──

export type RecoveryStatus = "archived" | "restored" | "purged";

export type RecoveryModule =
  | "bff"
  | "auth-svc"
  | "cases-svc"
  | "alerts-svc"
  | "rules-svc";

export interface DeletedRecord {
  recovery_id: string;
  tenant_id: string;
  module: RecoveryModule;
  entity_type: string;
  original_id: string;
  original_table: string;
  payload: Record<string, unknown>;
  deleted_by: string;
  deleted_at: string;
  deletion_reason: string | null;
  source_action: string | null;
  prior_status: string | null;
  restored_at: string | null;
  restored_by: string | null;
  purged_at: string | null;
  purged_by: string | null;
  status: RecoveryStatus;
}

/** Input shape — same as the BFF's ArchiveInput minus tenant_id (the
 *  BFF binds tenant from the verified api-key — callers cannot override). */
export interface ArchiveRequest {
  module: Exclude<RecoveryModule, "bff">;
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

/** Minimal interface route handlers depend on — lets tests inject a
 *  stub that records calls instead of doing real HTTP. */
export interface RecoveryArchiver {
  archive(req: ArchiveRequest): Promise<ArchiveResponse>;
}

/** Typed error subtypes — callers pattern-match on `.code`. */
export class RecoveryArchiveError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "invalid_api_key"
      | "missing_scope"
      | "server_error"
      | "network_error",
    message: string,
    public readonly httpStatus?: number,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
    this.name = "RecoveryArchiveError";
  }
}

export interface RecoveryArchiveClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelays?: number[];
  timeoutMs?: number;
}

const DEFAULT_RETRY_DELAYS = [100, 400];
const DEFAULT_TIMEOUT_MS = 5_000;

export class RecoveryArchiveClient implements RecoveryArchiver {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelays: number[];
  private readonly timeoutMs: number;

  constructor(opts: RecoveryArchiveClientOptions) {
    if (!opts.baseUrl) throw new Error("RecoveryArchiveClient: baseUrl required");
    if (!opts.apiKey) throw new Error("RecoveryArchiveClient: apiKey required");
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl =
      opts.fetchImpl ??
      (globalThis as { fetch?: typeof fetch }).fetch ??
      ((): never => {
        throw new RecoveryArchiveError(
          "network_error",
          "no fetch available — pass fetchImpl or run on Node 18+",
        );
      });
    this.retryDelays = opts.retryDelays ?? DEFAULT_RETRY_DELAYS;
    this.maxRetries = opts.maxRetries ?? this.retryDelays.length;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async archive(req: ArchiveRequest): Promise<ArchiveResponse> {
    if (!req.module || (req.module as string) === "bff") {
      throw new RecoveryArchiveError(
        "invalid_input",
        "module must be one of 'auth-svc' | 'cases-svc' | 'alerts-svc' | 'rules-svc' ('bff' is rejected — call recoveryStore.archive() directly)",
      );
    }
    if (!req.entity_type?.trim()) {
      throw new RecoveryArchiveError("invalid_input", "entity_type required");
    }
    if (!req.original_id?.trim()) {
      throw new RecoveryArchiveError("invalid_input", "original_id required");
    }
    if (!req.original_table?.trim()) {
      throw new RecoveryArchiveError("invalid_input", "original_table required");
    }
    if (!req.deleted_by?.trim()) {
      throw new RecoveryArchiveError("invalid_input", "deleted_by required");
    }
    if (!req.payload || typeof req.payload !== "object" || Array.isArray(req.payload)) {
      throw new RecoveryArchiveError("invalid_input", "payload must be an object");
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
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay =
          this.retryDelays[attempt - 1] ??
          this.retryDelays[this.retryDelays.length - 1] ??
          0;
        await new Promise((r) => setTimeout(r, delay));
      }
      try {
        return await this.attemptOnce(url, body);
      } catch (err) {
        lastErr = err;
        if (err instanceof RecoveryArchiveError) {
          const status = err.httpStatus ?? 0;
          const transient = err.code === "network_error" || [502, 503, 504].includes(status);
          if (!transient) throw err;
        } else {
          lastErr = new RecoveryArchiveError(
            "network_error",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new RecoveryArchiveError("network_error", "archive failed after retries");
  }

  private async attemptOnce(url: string, body: string): Promise<ArchiveResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-Channel": "API",
          "X-Source-System": "auth-svc-recovery",
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new RecoveryArchiveError(
        "network_error",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new RecoveryArchiveError(
        res.status >= 500 ? "server_error" : "invalid_input",
        `non-JSON response (status ${res.status})`,
        res.status,
      );
    }

    if (res.status === 201 || res.status === 200) {
      const respBody = (parsed as { body?: ArchiveResponse }).body;
      if (!respBody || !respBody.recovery_id) {
        throw new RecoveryArchiveError(
          "server_error",
          "envelope missing body.recovery_id",
          res.status,
        );
      }
      return respBody;
    }

    const err = (parsed as { error?: { code?: string; message?: string } }).error;
    const code = err?.code ?? "";
    const message = err?.message ?? `archive failed (status ${res.status})`;

    if (res.status === 401) {
      throw new RecoveryArchiveError("invalid_api_key", message, 401);
    }
    if (res.status === 403) {
      throw new RecoveryArchiveError("missing_scope", message, 403, { code });
    }
    if (res.status === 400) {
      throw new RecoveryArchiveError("invalid_input", message, 400, { code });
    }
    if (res.status >= 500) {
      throw new RecoveryArchiveError("server_error", message, res.status, { code });
    }
    throw new RecoveryArchiveError(
      "server_error",
      `unexpected status ${res.status}: ${message}`,
      res.status,
      { code },
    );
  }
}

/** Factory: returns a RecoveryArchiveClient when both env vars are set,
 *  else null (best-effort posture — archive failures must not block the
 *  user's delete, and absent config is just a no-op). */
export function makeRecoveryArchiverFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RecoveryArchiver | null {
  const baseUrl = env.BFF_BASE_URL;
  const apiKey = env.BFF_RECOVERY_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return new RecoveryArchiveClient({ baseUrl, apiKey });
}
