// services/bff/src/integrations/cbs_http_client.ts
//
// T3.1 — production HTTP impl of the CbsClient contract from cbs_production.ts.
// Wraps the bank's CBS REST API (or the local OpenAPI mock at
// integrations/cbs/openapi.yaml). Designed to be wrapped by ResilientCbsClient
// for retry + circuit-breaker + audit; this client itself is stateless.
//
// External blocker: the actual bank-side endpoint URL + auth credentials
// are populated via env vars at runtime (Secrets Manager). The contract
// is testable today against the OpenAPI mock with no code change.

import type { CbsClient, CbsRequest, CbsResponse } from "./cbs_production";

export interface HttpCbsClientOptions {
  /** Base URL of the bank CBS endpoint, e.g. `https://cbs.bank.internal/api/v1`.
   *  Falls back to `${CBS_BASE_URL}` env var. */
  baseUrl?: string;
  /** OAuth2 / Bearer token loader (called per request to support rotation). */
  authToken?: () => Promise<string> | string;
  /** Per-request timeout (default 8000ms — fits inside the ResilientCbsClient
   *  retry window of 30s).  */
  timeoutMs?: number;
  /** Optional fetch implementation (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Maps the `CbsRequest.operation` to the HTTP method + path of the bank's
 * CBS REST endpoint. Mirrors `integrations/cbs/openapi.yaml`.
 *
 * Production bank API surface (per `integrations/cbs/contract.md`):
 *
 *   getCustomer        GET    /cbs/customers/{customer_id}
 *   getLoan            GET    /cbs/loans/{loan_id}
 *   listLoans          GET    /cbs/loans?customer_id=&page=&page_size=
 *   replayEvents       POST   /cbs/replay
 *
 * Any other operation name is rejected at the route layer.
 */
const OPERATION_MAP: Record<string, { method: string; pathFn: (payload: Record<string, unknown>) => string }> = {
  getCustomer: {
    method: "GET",
    pathFn: (p) => `/cbs/customers/${encodeURIComponent(String(p.customer_id))}`,
  },
  getLoan: {
    method: "GET",
    pathFn: (p) => `/cbs/loans/${encodeURIComponent(String(p.loan_id))}`,
  },
  listLoans: {
    method: "GET",
    pathFn: (p) => {
      const qs = new URLSearchParams();
      if (p.customer_id) qs.set("customer_id", String(p.customer_id));
      if (p.page) qs.set("page", String(p.page));
      if (p.page_size) qs.set("page_size", String(p.page_size));
      const q = qs.toString();
      return q ? `/cbs/loans?${q}` : "/cbs/loans";
    },
  },
  replayEvents: {
    method: "POST",
    pathFn: () => "/cbs/replay",
  },
};

export class HttpCbsClient implements CbsClient {
  private readonly baseUrl: string;
  private readonly authToken: () => Promise<string> | string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpCbsClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.CBS_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "HttpCbsClient requires baseUrl (or CBS_BASE_URL env). Set to the bank's CBS endpoint or the local mock URL.",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken ?? (() => process.env.CBS_BEARER_TOKEN ?? "");
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call<T = unknown>(req: CbsRequest): Promise<CbsResponse<T>> {
    const map = OPERATION_MAP[req.operation];
    if (!map) {
      return {
        ok: false,
        status: 400,
        body: undefined,
        error: `unknown CBS operation: ${req.operation}`,
      } as CbsResponse<T>;
    }

    const payload = (req.payload as Record<string, unknown>) ?? {};
    const url = `${this.baseUrl}${map.pathFn(payload)}`;

    // Resolve auth token lazily — supports rotation by Secrets Manager.
    const token = await this.authToken();
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "User-Agent": "apex-ews-bff/1.0 (CBS-integration)",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (req.idempotency_key) {
      headers["Idempotency-Key"] = req.idempotency_key;
    }

    let body: string | undefined;
    if (map.method !== "GET" && map.method !== "DELETE") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    }

    // AbortController for per-request timeout
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchImpl(url, {
        method: map.method,
        headers,
        body,
        signal: ac.signal,
      });

      let parsed: unknown;
      const text = await resp.text();
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }

      // Bank CBS returns 202 + Location header for async ops (e.g. replay)
      const pending = resp.status === 202;

      if (!resp.ok && !pending) {
        return {
          ok: false,
          status: resp.status,
          body: parsed as T,
          error: typeof parsed === "object" && parsed && "message" in (parsed as Record<string, unknown>)
            ? String((parsed as Record<string, unknown>).message)
            : `CBS ${map.method} ${url} returned ${resp.status}`,
        };
      }

      return {
        ok: true,
        status: resp.status,
        body: parsed as T,
        pending,
      };
    } catch (err) {
      // AbortError or network failure → reported as non-ok so ResilientCbsClient
      // can decide whether to retry. We surface it as a 599 sentinel so the
      // RetryPolicy.retryable_statuses set distinguishes it from a real 5xx.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 599,
        body: undefined as unknown as T,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Factory selecting the right CBS client based on env:
 *   - `CBS_BASE_URL` set → HttpCbsClient (production)
 *   - else → throws; callers must explicitly opt into mock via integration tests
 */
export function makeCbsClient(env: NodeJS.ProcessEnv = process.env): CbsClient {
  if (env.CBS_BASE_URL) {
    return new HttpCbsClient({ baseUrl: env.CBS_BASE_URL });
  }
  throw new Error(
    "CBS_BASE_URL not set. Set to the bank's CBS endpoint or override via injection (see ResilientCbsClient wrapping).",
  );
}
