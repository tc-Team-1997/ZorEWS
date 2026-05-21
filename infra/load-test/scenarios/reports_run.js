// infra/load-test/scenarios/reports_run.js
//
// T4.5.1 — POST /v1/reports/builder/run at 5 r/s (5× pilot 1 r/s).
// Slow-path: T4.6.4 report engine runs deterministic synthesis +
// filter eval + aggregation. Wider p95 budget; lower target volume.

import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, defaultHeaders, defaultThresholds } from './_common.js';

export const options = {
  scenarios: {
    reports_run_5x: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 10,
      maxVUs: 30,
    },
  },
  thresholds: {
    ...defaultThresholds(),
    'http_req_duration{endpoint:reports_run}': ['p(95)<3000', 'p(99)<6000'],
  },
};

const REPORT_DEFINITIONS = [
  { source_id: 'mart.customer_360', limit: 100 },
  { source_id: 'mart.loan_360', limit: 200 },
  { source_id: 'app_alerts.alerts', limit: 100 },
  { source_id: 'app_cases.cases', limit: 100 },
];

export default function () {
  const def = REPORT_DEFINITIONS[__ITER % REPORT_DEFINITIONS.length];
  const r = http.post(`${baseUrl()}/v1/reports/builder/run`, JSON.stringify(def), {
    headers: defaultHeaders(),
    tags: { endpoint: 'reports_run' },
  });
  check(r, {
    'status 200': (res) => res.status === 200,
    'has rows array': (res) => {
      try {
        return Array.isArray(JSON.parse(res.body)?.body?.rows);
      } catch {
        return false;
      }
    },
  });
}
