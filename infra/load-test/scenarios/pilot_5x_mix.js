// infra/load-test/scenarios/pilot_5x_mix.js
//
// T4.5.1 — composed 5× pilot traffic mix. Runs the full BFF hot-path
// at 5× pilot volume for 15 minutes. This is the GREEN-LIGHT GATE
// before release.
//
// Mix profile per docs/charter.md Year-1 capacity plan × 5:
//   alerts list           — 100 r/s (5× of 20)
//   streaming ingest      — 250 r/s (5× of 50)
//   customer 360          — 40 vus  (5× of 8 concurrent)
//   feature snapshot      — 25 r/s  (5× of 5)
//   scenario run          — 10 r/s  (5× of 2)
//   reports run           — 5 r/s   (5× of 1)

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
    alerts_list: {
      executor: 'constant-arrival-rate',
      exec: 'alertsList',
      rate: 100,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 50,
      maxVUs: 150,
    },
    streaming_ingest: {
      executor: 'constant-arrival-rate',
      exec: 'streamingIngest',
      rate: 250,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 100,
      maxVUs: 350,
    },
    customer_360: {
      executor: 'constant-vus',
      exec: 'customer360',
      vus: 40,
      duration: '15m',
    },
    feature_snapshot: {
      executor: 'constant-arrival-rate',
      exec: 'featureSnapshot',
      rate: 25,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 20,
      maxVUs: 80,
    },
    scenario_run: {
      executor: 'constant-arrival-rate',
      exec: 'scenarioRun',
      rate: 10,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 10,
      maxVUs: 40,
    },
    reports_run: {
      executor: 'constant-arrival-rate',
      exec: 'reportsRun',
      rate: 5,
      timeUnit: '1s',
      duration: '15m',
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: {
    ...defaultThresholds(),
    // Per-endpoint envelope budgets — generous for heavy paths.
    'http_req_duration{endpoint:streaming_ingest}': ['p(95)<1200'],
    'http_req_duration{endpoint:customer_360}': ['p(95)<1500', 'p(99)<3000'],
    'http_req_duration{endpoint:scenario_run}': ['p(95)<2500'],
    'http_req_duration{endpoint:reports_run}': ['p(95)<3000'],
  },
};

// ─── Per-scenario exec functions ─────────────────────────────────────

export function alertsList() {
  const r = http.get(`${baseUrl()}/v1/alerts?limit=50`, {
    headers: defaultHeaders(),
    tags: { endpoint: 'alerts_list' },
  });
  check(r, { 'alerts 200': (res) => res.status === 200 });
  sleep(0.1);
}

export function streamingIngest() {
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
  check(r, { 'stream 201': (res) => res.status === 201 });
}

export function customer360() {
  const cid = pickCustomerId(__VU, __ITER);
  const r = http.get(`${baseUrl()}/v1/customers/${cid}/360`, {
    headers: defaultHeaders(),
    tags: { endpoint: 'customer_360' },
  });
  check(r, { '360 200': (res) => res.status === 200 });
  sleep(0.5);
}

export function featureSnapshot() {
  const cid = pickCustomerId(__VU, __ITER);
  const r = http.get(`${baseUrl()}/v1/feature-store/customers/${cid}/snapshot`, {
    headers: defaultHeaders(),
    tags: { endpoint: 'feature_snapshot' },
  });
  check(r, { 'snap 200': (res) => res.status === 200 });
}

export function scenarioRun() {
  const body = JSON.stringify({
    gdp: -0.02,
    rate: 0.0125,
    fx: -0.05,
  });
  const r = http.post(`${baseUrl()}/v1/scenario/run`, body, {
    headers: defaultHeaders(),
    tags: { endpoint: 'scenario_run' },
  });
  check(r, { 'scenario 200': (res) => res.status === 200 });
}

export function reportsRun() {
  const body = JSON.stringify({
    source_id: 'mart.customer_360',
    limit: 100,
  });
  const r = http.post(`${baseUrl()}/v1/reports/builder/run`, body, {
    headers: defaultHeaders(),
    tags: { endpoint: 'reports_run' },
  });
  check(r, { 'reports 200': (res) => res.status === 200 });
}

export function handleSummary(data) {
  return {
    'stdout': JSON.stringify(
      {
        gate: 'pilot_5x_mix',
        duration: '15m',
        total_requests: data.metrics.http_reqs?.values.count,
        overall_p95_ms: Math.round(data.metrics.http_req_duration?.values['p(95)']),
        overall_p99_ms: Math.round(data.metrics.http_req_duration?.values['p(99)']),
        error_rate: data.metrics.http_req_failed?.values.rate,
        thresholds_passed: Object.keys(data.metrics).every(
          (k) => !data.metrics[k]?.thresholds || Object.values(data.metrics[k].thresholds).every((t) => !t.fails),
        ),
        post_run_checks: [
          'curl $BFF/v1/streaming/latency → assert target_p95_60s_met=true',
          'kubectl top pods → check no pod >80% CPU',
          'grafana dashboard "Aurora reader" → verify CPU avg <60%',
        ],
      },
      null,
      2,
    ),
  };
}
