import axios, { AxiosError, type AxiosInstance } from 'axios';

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export const http: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

// Inject access token + RBAC role if present. The role is read from the
// auth store snapshot in localStorage (`apex.ews.user`) and sent as
// `x-apex-role`. This is the prototype's role-extraction strategy that
// matches `defaultGetRole` in services/regulatory-svc/{cases,alerts},
// services/bff, and services/collection-adapter. Production swaps both for
// JWT-claim extraction once auth-svc issues real tokens in dev.
http.interceptors.request.use((config) => {
  const token = localStorage.getItem('apex.ews.token');
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  const userRaw = localStorage.getItem('apex.ews.user');
  if (userRaw) {
    try {
      const user = JSON.parse(userRaw) as {
        roles?: string[]; username?: string; display_name?: string; tenant_id?: string;
      };
      const role = user?.roles?.[0];
      if (role) config.headers.set('x-apex-role', role);
      // Surface the operator name to the BFF so PDF/Excel exports can
      // stamp it in the footer / metadata sheet for leak traceability.
      const operator = user?.display_name || user?.username;
      if (operator) config.headers.set('x-apex-user', operator);
      // Public /v1 routes require tenant + channel context (T4.24 envelope).
      // /api/* internal routes don't, but it's harmless to send everywhere.
      const tenant = user?.tenant_id ?? 'BANK_DEMO';
      config.headers.set('X-Tenant-ID', tenant);
      config.headers.set('x-tenant-id', tenant);   // alerts/cases-svc lower-cases
      config.headers.set('X-Channel', 'API');
      config.headers.set('X-Source-System', 'apex-ews-spa');
    } catch {
      // ignore malformed user blob; auth store will re-hydrate on next login
    }
  }
  return config;
});

// Auto-unwrap the {header, body} envelope from /v1/* routes so call sites
// that did `r.data.items` keep working when the BFF wraps responses.
http.interceptors.response.use(
  (r) => {
    const d = r.data as { header?: { status?: string }; body?: unknown } | undefined;
    if (d && typeof d === 'object' && 'header' in d && 'body' in d) {
      r.data = d.body;
    }
    return r;
  },
  (err: AxiosError) => {
    const data = err.response?.data as
      | { error?: { code?: string; message?: string }; message?: string }
      | undefined;
    const status = err.response?.status ?? 0;
    const message =
      data?.error?.message ?? data?.message ?? err.message ?? 'Request failed';
    return Promise.reject(new HttpError(status, message, err.response?.data));
  },
);
