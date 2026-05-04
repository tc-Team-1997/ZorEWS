// services/bff/src/integrations/health.ts
//
// Integration health pinger. For each upstream (CBS, AML, IFRS9,
// Collection) the BFF probes a representative endpoint and reports
// status + measured latency. Used by the SPA Integrations page so
// operators can see at-a-glance which upstreams are healthy.
//
// In production this would surface to a monitoring dashboard (Grafana
// + AlertManager). For the prototype it pings the integration-mocks
// service started on port 8091 by default.

export type UpstreamId = 'cbs' | 'aml' | 'ifrs9' | 'collection';

export interface IntegrationStatus {
  id: UpstreamId;
  label: string;
  /** Probe URL (relative to the mock base) — for diagnostics. */
  probe_url: string;
  /** Wall-clock latency in ms for the probe. */
  latency_ms: number;
  /** "up" if the probe returned 2xx; "down" if any error or non-2xx. */
  status: 'up' | 'down';
  /** HTTP status code returned by the probe (or 0 on network failure). */
  http_status: number;
  /** Optional message — set on degraded responses (4xx/5xx) or network error. */
  message?: string;
}

export interface HealthReport {
  base_url: string;
  generated_at: string;
  integrations: IntegrationStatus[];
}

/** Probe definitions — one representative GET per upstream. */
const PROBES: Array<{ id: UpstreamId; label: string; path: string }> = [
  { id: 'cbs', label: 'Core Banking System', path: '/cbs/loans?page=1&page_size=1' },
  { id: 'aml', label: 'AML Hub', path: '/aml/outbound?limit=1' },
  { id: 'ifrs9', label: 'IFRS 9 Engine', path: '/ifrs9/stages/c-1001' },
  { id: 'collection', label: 'Collection System', path: '/healthz' },
];

/** Override-friendly fetch surface — tests inject a stub. */
export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

const REAL_FETCH: Fetcher = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status };
};

export interface PingDeps {
  baseUrl?: string;
  fetcher?: Fetcher;
  now?: () => Date;
  /** Per-probe timeout in ms. Default 2000. */
  timeoutMs?: number;
}

/**
 * Probe every upstream in parallel and return a HealthReport. Failures
 * are caught individually so a single down upstream doesn't poison the
 * whole report.
 */
export async function pingIntegrations(deps: PingDeps = {}): Promise<HealthReport> {
  const baseUrl = deps.baseUrl ?? process.env.MOCKS_BASE_URL ?? 'http://localhost:8091';
  const fetcher = deps.fetcher ?? REAL_FETCH;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 2000;

  const results = await Promise.all(
    PROBES.map(async (probe): Promise<IntegrationStatus> => {
      const start = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetcher(`${baseUrl}${probe.path}`, { signal: ac.signal });
        const latency_ms = Date.now() - start;
        const status = r.status >= 200 && r.status < 300 ? 'up' : 'down';
        return {
          id: probe.id,
          label: probe.label,
          probe_url: probe.path,
          latency_ms,
          status,
          http_status: r.status,
          message: status === 'down' ? `upstream returned ${r.status}` : undefined,
        };
      } catch (e) {
        const latency_ms = Date.now() - start;
        return {
          id: probe.id,
          label: probe.label,
          probe_url: probe.path,
          latency_ms,
          status: 'down',
          http_status: 0,
          message: e instanceof Error ? e.message : 'unknown network error',
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return {
    base_url: baseUrl,
    generated_at: now().toISOString(),
    integrations: results,
  };
}
