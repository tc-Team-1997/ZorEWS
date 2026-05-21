// infra/load-test/scenarios/scenario_run.js
//
// T4.5.1 — POST /v1/scenario/run at 10 r/s (5× pilot 2 r/s).
// Heavier compute path (portfolio re-pricing) — wider p95 budget.

import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, defaultHeaders, defaultThresholds } from './_common.js';

export const options = {
  scenarios: {
    scenario_run_5x: {
      executor: 'constant-arrival-rate',
      rate: 10,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 30,
      maxVUs: 80,
    },
  },
  thresholds: {
    ...defaultThresholds(),
    // Scenario engine re-prices the portfolio — heavier than a read.
    'http_req_duration{endpoint:scenario_run}': ['p(95)<3000', 'p(99)<5000'],
  },
};

export default function () {
  const body = JSON.stringify({
    gdp: -2.0,
    rate: 100,
    fx: 5.0,
  });
  const r = http.post(`${baseUrl()}/v1/scenario/run`, body, {
    headers: defaultHeaders(),
    tags: { endpoint: 'scenario_run' },
  });
  check(r, {
    'status 200': (res) => res.status === 200,
    'body has portfolio_pd': (res) => {
      try {
        const env = JSON.parse(res.body);
        return env?.body?.stressed_portfolio_pd !== undefined;
      } catch {
        return false;
      }
    },
  });
}
