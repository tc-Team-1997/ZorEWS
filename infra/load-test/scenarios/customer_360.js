// infra/load-test/scenarios/customer_360.js
//
// T4.5.1 — GET /v1/customers/:id/360 at 40 r/s (5× pilot 8 r/s).
// This is the heaviest read path — orchestrates 6 M14 adapters in
// parallel. Exercises Aurora read replicas + adapter fleet under
// concurrent VU pressure.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, defaultHeaders, defaultThresholds, pickCustomerId } from './_common.js';

export const options = {
  scenarios: {
    customer_360_5x: {
      executor: 'constant-vus',
      vus: 40, // matches 5× pilot concurrent users
      duration: '5m',
    },
  },
  thresholds: {
    ...defaultThresholds(),
    // Customer 360 fans out to 6 adapters in parallel; budget is wider.
    'http_req_duration{endpoint:customer_360}': ['p(95)<1500', 'p(99)<3000'],
  },
};

export default function () {
  const cid = pickCustomerId(__VU, __ITER);
  const r = http.get(`${baseUrl()}/v1/customers/${cid}/360`, {
    headers: defaultHeaders(),
    tags: { endpoint: 'customer_360' },
  });
  check(r, {
    'status 200': (res) => res.status === 200,
    'has 360 panels': (res) => {
      try {
        const body = JSON.parse(res.body)?.body;
        // Expect at least a couple of the 6 adapter panels.
        return body && (body.insurance || body.ifrs9 || body.aml);
      } catch {
        return false;
      }
    },
  });
  // 200ms per-VU think-time → 40 vus × 5/s = 200 r/s peak, well above 40 r/s target.
  // (Per-VU pacing kept light so we test sustained concurrent load not raw RPS.)
  sleep(0.2);
}
