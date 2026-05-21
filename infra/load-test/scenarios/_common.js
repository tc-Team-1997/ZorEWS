// infra/load-test/scenarios/_common.js
//
// T4.5.1 — shared helpers across the k6 load-test scenarios.
// k6 doesn't have a module resolver like Node — we use plain JS
// imports relative to the scenario file.

const __DEFAULT_BASE_URL = 'http://localhost:3001';

export function baseUrl() {
  return __ENV.BFF_BASE_URL || __DEFAULT_BASE_URL;
}

export function defaultHeaders() {
  const tenant = __ENV.APEX_TENANT_ID || 'BANK_DEMO';
  const token = __ENV.APEX_JWT || '';
  const user = __ENV.APEX_USER || 'load.test';
  const headers = {
    'Content-Type': 'application/json',
    'X-Tenant-ID': tenant,
    'X-Channel': 'LOAD_TEST',
    'X-APEX-USER': user,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/** Common tier-1 thresholds matching docs/slos.md. Scenario-specific
 *  scripts can override individual entries by spreading these into
 *  their own `thresholds` block. */
export function defaultThresholds(opts = {}) {
  return {
    // Tier-1 SLO: public API p95 < 800ms (envelope dispatch path).
    http_req_duration: ['p(95)<800', 'p(99)<2000'],
    http_req_failed: ['rate<0.005'],
    ...opts,
  };
}

/** Pure helper: deterministic customer-id rotation over a 50k pool —
 *  exercises read paths without hot-keying one row. */
export function pickCustomerId(vu, iter) {
  const idx = ((vu * 997) + (iter * 31)) % 50_000;
  return `CUST-${100_000 + idx}`;
}

/** Pure helper: deterministic indicator id rotation. */
const INDICATOR_IDS = [
  'FIN-001',
  'FIN-002',
  'BEH-001',
  'BEH-002',
  'TXN-001',
  'TXN-002',
  'CRD-001',
  'CRD-002',
];

export function pickIndicatorId(iter) {
  return INDICATOR_IDS[iter % INDICATOR_IDS.length];
}

/** Past-observed-at timestamp lagged 5-45s behind now. Used by the
 *  streaming ingest scenario to simulate realistic producer→BFF
 *  transit latency. */
export function laggedObservedAt(lagSec) {
  const ms = Date.now() - (lagSec * 1000);
  return new Date(ms).toISOString();
}
