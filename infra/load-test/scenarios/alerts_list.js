// infra/load-test/scenarios/alerts_list.js
//
// T4.5.1 — GET /v1/alerts under 5× pilot volume (100 r/s peak).
//
// Profile: ramp 0→100 r/s over 1 min, hold 5 min, ramp down over 30s.
// Validates p95 < 800ms + p99 < 2s + error rate < 0.5%.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, defaultHeaders, defaultThresholds } from './_common.js';

export const options = {
  scenarios: {
    alerts_list_5x: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      stages: [
        { target: 100, duration: '1m' }, // ramp up
        { target: 100, duration: '5m' }, // hold at 5× pilot
        { target: 0, duration: '30s' }, // graceful ramp-down
      ],
    },
  },
  thresholds: defaultThresholds(),
};

export default function () {
  const r = http.get(`${baseUrl()}/v1/alerts?limit=50`, {
    headers: defaultHeaders(),
    tags: { endpoint: 'alerts_list' },
  });
  check(r, {
    'status 200': (res) => res.status === 200,
    'has alerts body': (res) => {
      try {
        const body = JSON.parse(res.body);
        return Array.isArray(body?.body?.alerts) || Array.isArray(body?.body);
      } catch {
        return false;
      }
    },
  });
  // 200ms think-time between alerts-list polls (SPA query polling).
  sleep(0.2);
}
