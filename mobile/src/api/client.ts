// mobile/src/api/client.ts
//
// Shared API client. Wraps fetch with:
//   - JWT bearer + tenant + channel + actor headers (M1.3 contract)
//   - T4.24 envelope unwrapping
//   - Code-routed error class so screen-layer can branch on EWS_4xx
//   - Configurable base URL via MOBILE_BFF_BASE_URL env (Expo /
//     react-native-dotenv)

import type { Envelope } from '../types';

export interface ApiClientConfig {
  baseUrl: string;
  /** Token getter — invoked on every call. */
  getAccessToken: () => Promise<string | null>;
  /** Tenant id resolver — typically reads JWT claim. */
  getTenantId: () => Promise<string | null>;
  /** Operator username — sent as X-APEX-USER. */
  getActor: () => Promise<string | null>;
  /** Channel marker — defaults to MOBILE; field officers use FIELD_APP. */
  channel?: string;
  /** Hook called on every 401 — typically clears the secure store + redirects to login. */
  onUnauthorised?: () => Promise<void> | void;
  /** Fetch impl override — for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM',
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private readonly cfg: Required<ApiClientConfig>;
  constructor(cfg: ApiClientConfig) {
    this.cfg = {
      ...cfg,
      channel: cfg.channel ?? 'MOBILE',
      onUnauthorised: cfg.onUnauthorised ?? (async () => {}),
      fetchImpl: cfg.fetchImpl ?? (globalThis.fetch as typeof fetch),
    };
  }

  /** GET request. Returns the unwrapped body or throws ApiError. */
  async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);
    const headers = await this.buildHeaders();
    const res = await this.cfg.fetchImpl(url, { method: 'GET', headers });
    return this.handle<T>(res);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const headers = await this.buildHeaders({ 'Content-Type': 'application/json' });
    const res = await this.cfg.fetchImpl(url, {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handle<T>(res);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const headers = await this.buildHeaders({ 'Content-Type': 'application/json' });
    const res = await this.cfg.fetchImpl(url, {
      method: 'PATCH',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handle<T>(res);
  }

  async delete(path: string): Promise<void> {
    const url = this.buildUrl(path);
    const headers = await this.buildHeaders();
    const res = await this.cfg.fetchImpl(url, { method: 'DELETE', headers });
    if (res.status === 204) return;
    if (res.status === 401) {
      await this.cfg.onUnauthorised();
      throw new ApiError('EWS_401', 401, 'unauthorised', 'HIGH');
    }
    // DELETE may still return JSON body on error.
    await this.handle<void>(res);
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    let url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (query) {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') sp.set(k, v);
      }
      const s = sp.toString();
      if (s) url += `?${s}`;
    }
    return url;
  }

  private async buildHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Channel': this.cfg.channel,
      ...extra,
    };
    const token = await this.cfg.getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const tenant = await this.cfg.getTenantId();
    if (tenant) headers['X-Tenant-ID'] = tenant;
    const actor = await this.cfg.getActor();
    if (actor) headers['X-APEX-USER'] = actor;
    return headers;
  }

  private async handle<T>(res: Response): Promise<T> {
    if (res.status === 401) {
      await this.cfg.onUnauthorised();
      throw new ApiError('EWS_401', 401, 'unauthorised', 'HIGH');
    }
    let payload: Envelope<T> | null = null;
    try {
      payload = (await res.json()) as Envelope<T>;
    } catch {
      // Non-JSON body — surface as a generic ApiError.
      throw new ApiError('EWS_500', res.status, `non-JSON response (status ${res.status})`, 'HIGH');
    }
    if (res.status >= 200 && res.status < 300 && payload && payload.body !== undefined) {
      return payload.body;
    }
    // 204 with no body: T = void; caller handles.
    if (res.status === 204) {
      return undefined as unknown as T;
    }
    const err = payload?.error;
    throw new ApiError(
      err?.code ?? `EWS_${res.status}`,
      res.status,
      err?.message ?? `request failed with ${res.status}`,
      err?.severity ?? (res.status >= 500 ? 'HIGH' : 'MEDIUM'),
      err?.detail,
    );
  }
}
