// services/bff/src/integrations/ifrs9_http_adapter.ts
//
// T3.2 — production HTTP impl of the Ifrs9Adapter contract from ifrs9.ts.
// Wraps the bank's IFRS9 REST API (or the local OpenAPI mock at
// integrations/ifrs9/openapi.yaml).
//
// External blocker: actual bank IFRS9 source URL + auth credentials are
// populated via env vars at runtime (Secrets Manager). Contract is testable
// today against the OpenAPI mock with no code change.

import type {
  Ifrs9Adapter,
  Ifrs9Stage,
  Ifrs9StageListPage,
  Ifrs9StageNum,
} from "./ifrs9";

export interface HttpIfrs9AdapterOptions {
  /** Base URL of the bank IFRS9 endpoint. Falls back to `${IFRS9_BASE_URL}`. */
  baseUrl?: string;
  /** Bearer token loader (called per request). */
  authToken?: () => Promise<string> | string;
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpIfrs9Adapter implements Ifrs9Adapter {
  private readonly baseUrl: string;
  private readonly authToken: () => Promise<string> | string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpIfrs9AdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.IFRS9_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "HttpIfrs9Adapter requires baseUrl (or IFRS9_BASE_URL env). Set to the bank's IFRS9 endpoint or the local mock URL.",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authToken = options.authToken ?? (() => process.env.IFRS9_BEARER_TOKEN ?? "");
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const token = await this.authToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "apex-ews-bff/1.0 (IFRS9-integration)",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);

    try {
      const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });

      if (resp.status === 404) return null;
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`IFRS9 ${method} ${path} returned ${resp.status}: ${text.slice(0, 200)}`);
      }

      const text = await resp.text();
      return text ? (JSON.parse(text) as T) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getStage(
    _tenant_id: string,
    customer_id: string,
    _asOf: Date,
  ): Promise<Ifrs9Stage | null> {
    // Bank IFRS9 source ignores client-supplied asOf and returns latest.
    // For point-in-time queries production swaps to a separate /stages/history
    // endpoint when available. tenant_id is enforced by the bank-side
    // VPN gateway (per-tenant subnet routing), not via the IFRS9 wire format.
    const path = `/ifrs9/stages/${encodeURIComponent(customer_id)}`;
    const response = await this.request<Partial<Ifrs9Stage>>(
      "GET",
      path,
    );
    if (!response) return null;

    return this.normalise(response);
  }

  async listStages(
    _tenant_id: string,
    opts: { stage?: Ifrs9StageNum; page?: number; page_size?: number },
    _asOf: Date,
  ): Promise<Ifrs9StageListPage> {
    const qs = new URLSearchParams();
    if (opts.stage != null) qs.set("stage", String(opts.stage));
    if (opts.page != null) qs.set("page", String(opts.page));
    if (opts.page_size != null) qs.set("page_size", String(opts.page_size));
    const q = qs.toString();
    const path = q ? `/ifrs9/inputs?${q}` : "/ifrs9/inputs";

    const response = await this.request<{
      items?: Partial<Ifrs9Stage>[];
      total?: number;
      page?: number;
      page_size?: number;
    }>("GET", path);

    if (!response) {
      return { items: [], total: 0, page: opts.page ?? 1, page_size: opts.page_size ?? 50, stage_filter: opts.stage ?? null };
    }

    return {
      items: (response.items ?? []).map((r) => this.normalise(r)),
      total: response.total ?? 0,
      page: response.page ?? opts.page ?? 1,
      page_size: response.page_size ?? opts.page_size ?? 50,
      stage_filter: opts.stage ?? null,
    };
  }

  /** Reconcile bank-side response shape to the canonical Ifrs9Stage.
   *  Defensive: missing fields default to safe values matching the stub. */
  private normalise(raw: Partial<Ifrs9Stage>): Ifrs9Stage {
    const stage = (raw.stage ?? 1) as Ifrs9StageNum;
    const pd_12m = clampUnit(raw.pd_12m ?? 0.01);
    const pd_lifetime = clampUnit(Math.max(raw.pd_lifetime ?? pd_12m, pd_12m));
    const lgd = clampUnit(raw.lgd ?? 0.4);
    const ead_kes = Math.max(0, Math.round(raw.ead_kes ?? 0));
    const driverPd = stage === 1 ? pd_12m : pd_lifetime;
    const ecl_kes = Math.round(driverPd * lgd * ead_kes);

    return {
      customer_id: raw.customer_id ?? "",
      stage,
      pd_12m,
      pd_lifetime,
      lgd,
      ead_kes,
      ecl_kes,
      dpd_days: Math.max(0, Math.floor(raw.dpd_days ?? 0)),
      stage_reason: raw.stage_reason ?? "from-bank-ifrs9",
      evaluation_date: raw.evaluation_date ?? new Date().toISOString(),
    };
  }
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Factory selecting the right Ifrs9 adapter based on env:
 *   - `IFRS9_BASE_URL` set → HttpIfrs9Adapter (production)
 *   - else → throws (caller must explicitly opt into stub)
 */
export function makeIfrs9Adapter(env: NodeJS.ProcessEnv = process.env): Ifrs9Adapter {
  if (env.IFRS9_BASE_URL) {
    return new HttpIfrs9Adapter({ baseUrl: env.IFRS9_BASE_URL });
  }
  throw new Error(
    "IFRS9_BASE_URL not set. Provide via env or inject StubIfrs9Adapter explicitly for dev/test.",
  );
}
