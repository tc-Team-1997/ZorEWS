// infra/load-test/scenarios/feature_snapshot.js
//
// T4.5.1 — GET /v1/feature-store/customers/:id/snapshot at 25 r/s
// (5× pilot 5 r/s). Read-only point-in-time fetch — should be cheap.
// Validates Aurora reader cache hit rate under sustained sampling.

import http from 'k6/http';
import { check } from 'k6';
import { baseUrl, defaultHeaders, defaultThresholds, pickCustomerId } from './_common.js';

export const options = {
  scenarios: {
    feature_snapshot_5x: {
      executor: 'constant-arrival-rate',
      rate: 25,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 20,
      maxVUs: 60,
    },
  },
  thresholds: defaultThresholds(),
};

export default function () {
  const cid = pickCustomerId(__VU, __ITER);
  const r = http.get(`${baseUrl()}/v1/feature-store/customers/${cid}/snapshot`, {
    headers: defaultHeaders(),
    tags: { endpoint: 'feature_snapshot' },
  });
  check(r, {
    'status 200': (res) => res.status === 200,
    'has features map': (res) => {
      try {
        return JSON.parse(res.body)?.body?.features !== undefined;
      } catch {
        return false;
      }
    },
  });
}
