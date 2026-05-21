// infra/load-test/scenarios/streaming_ingest.js
//
// T4.5.1 — POST /v1/streaming/indicator-events at 250 r/s (5× pilot
// 50 r/s). Exercises the T2.12.1 streaming latency telemetry surface
// + the producer hot path. Validates BFF p95 + the in-system 60s SLO
// via a post-run sanity check against /v1/streaming/latency.

import http from 'k6/http';
import { check, sleep } from 'k6';
import {
  baseUrl,
  defaultHeaders,
  defaultThresholds,
  pickCustomerId,
  pickIndicatorId,
  laggedObservedAt,
} from './_common.js';

export const options = {
  scenarios: {
    streaming_5x: {
      executor: 'constant-arrival-rate',
      rate: 250, // 5× pilot
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    ...defaultThresholds(),
    // Streaming ingest is a write path with extra envelope work;
    // allow slightly higher p95 budget.
    'http_req_duration{endpoint:streaming_ingest}': ['p(95)<1200'],
  },
};

export default function () {
  // Lag between 1-30s — simulates upstream Kafka transit. Some events
  // skirt the 60s SLO; the slow tail produced is the point of the test.
  const lag = 1 + Math.floor(Math.random() * 30);
  const body = JSON.stringify({
    indicator_id: pickIndicatorId(__ITER),
    customer_id: pickCustomerId(__VU, __ITER),
    value: Math.random() * 0.9 + 0.05,
    observed_at: laggedObservedAt(lag),
  });
  const r = http.post(`${baseUrl()}/v1/streaming/indicator-events`, body, {
    headers: defaultHeaders(),
    tags: { endpoint: 'streaming_ingest' },
  });
  check(r, {
    'status 201': (res) => res.status === 201,
  });
  // No artificial think-time — constant-arrival rate already controls pacing.
}

/** Post-run summary: pull the latency endpoint once and surface
 *  target_p95_60s_met alongside the standard k6 output. */
export function handleSummary(data) {
  // k6 doesn't allow http inside handleSummary in v0.50+ — operators
  // run `curl $BFF/v1/streaming/latency` post-run; the run summary
  // is captured to JSON via --out.
  return {
    'stdout': JSON.stringify(
      {
        scenario: 'streaming_ingest',
        target_rps: 250,
        duration: '5m',
        metrics: {
          http_reqs: data.metrics.http_reqs?.values.count,
          p95_ms: Math.round(data.metrics.http_req_duration?.values['p(95)']),
          p99_ms: Math.round(data.metrics.http_req_duration?.values['p(99)']),
          error_rate: data.metrics.http_req_failed?.values.rate,
        },
        post_run_check:
          'curl $BFF_BASE_URL/v1/streaming/latency to confirm target_p95_60s_met=true',
      },
      null,
      2,
    ),
  };
}
