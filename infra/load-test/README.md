# T4.5 — Load testing at 5× pilot volume

Production-grade load-test harness for the ZorEWS BFF + downstream
services. Targets the EWS.docx §3.5 / `docs/slos.md` tier-1 SLOs
(public API 99.5%/30d, alert ingest p95 <60s) under **5× the BIL pilot
traffic profile**.

## Pilot volume baseline

Per `docs/charter.md` + the BIL Year-1 capacity plan, the pilot
traffic profile is:

| Endpoint group | Pilot req/s (peak hour) | 5× target |
|---|---|---|
| Alerts list + ack | 20 r/s | **100 r/s** |
| Scenario run | 2 r/s | **10 r/s** |
| Customer 360 drill-through | 8 r/s | **40 r/s** |
| Streaming indicator-events (POST) | 50 r/s | **250 r/s** |
| Feature store snapshot | 5 r/s | **25 r/s** |
| Reports builder run | 1 r/s | **5 r/s** |

Concurrent SPA sessions: pilot ~80, 5× = **400**.

## Toolchain

**k6** by Grafana Labs. Pure JS scenarios; cloud or local runner;
produces a Prometheus-compatible output + a Grafana dashboard via
`k6 run --out experimental-prometheus-rw=...`.

Local install:

```
brew install k6
# or
docker pull grafana/k6
```

## Running

Each scenario in `scenarios/` is self-contained.

```bash
# Single scenario — uses BFF_BASE_URL + JWT (set via env).
BFF_BASE_URL=https://bff.staging.apex-ews.example \
APEX_JWT=$(./scripts/issue-load-test-jwt.sh) \
APEX_TENANT_ID=BANK_DEMO \
k6 run infra/load-test/scenarios/alerts_list.js

# Full 5× pilot mix (all scenarios composed; runs ~15 min).
k6 run infra/load-test/scenarios/pilot_5x_mix.js
```

JSON output:

```bash
k6 run --out json=infra/load-test/reports/$(date +%Y-%m-%d).json \
  infra/load-test/scenarios/alerts_list.js
```

## Scenarios

| Scenario file | Endpoint | Target req/s | Profile |
|---|---|---|---|
| `alerts_list.js` | `GET /v1/alerts` | 100 r/s | ramp 0→100 over 1m, hold 5m |
| `scenario_run.js` | `POST /v1/scenarios/run` | 10 r/s | constant-arrival 10 r/s × 5m |
| `customer_360.js` | `GET /v1/customers/:id/360` | 40 r/s | per-vu 200ms think-time |
| `streaming_ingest.js` | `POST /v1/streaming/indicator-events` | 250 r/s | burst arrival 50/s spikes |
| `feature_snapshot.js` | `GET /v1/feature-store/customers/:id/snapshot` | 25 r/s | flat 25 r/s × 5m |
| `reports_run.js` | `POST /v1/reports/builder/run` | 5 r/s | flat 5 r/s × 10m (slow path) |
| `pilot_5x_mix.js` | composed | sum of above | 15-min mixed profile |

## Pass / fail thresholds

Each scenario declares `thresholds`:

- `http_req_duration{status:200}` p95 < 800ms (tier-1 envelope)
- `http_req_duration{status:200}` p99 < 2000ms
- `http_req_failed` rate < 0.5%
- streaming-specific: BFF latency telemetry `target_p95_60s_met=true`
  via post-run GET on `/v1/streaming/latency`

A scenario exits non-zero when any threshold is violated; CI gates
release on a passing `pilot_5x_mix.js` run against the staging env.

## Report template

After each run, capture `reports/YYYY-MM-DD-summary.md` with:

- scenario file + ramp profile
- duration + total requests
- per-scenario p50 / p95 / p99 latency
- error rate
- pass/fail per threshold
- top-5 slow endpoints
- any DB / Kafka / EKS pod metrics from Grafana side
- recommendations

Template at `reports/template.md`.

## Calibration runbook

1. Run each scenario in isolation against staging — confirm thresholds
   are reasonable; tune SLOs in `docs/slos.md` if observed p95 < 800ms
   isn't realistic for the route.
2. Run `pilot_5x_mix.js` for 15 minutes — this is the green-light gate.
3. Capture Grafana dashboards: CPU/mem per pod, Aurora reader CPU + IO,
   MSK broker disk pressure, EKS HPA scaling events.
4. Run 10× and 20× as stretch tests to identify the saturation point.

## Year-2 follow-up

- CI integration: a nightly k6 cloud run against staging that compares
  p95 against the previous 7-day baseline and posts a Slack alert on
  >20% regression.
- Synthetic data prep: `scripts/seed-load-test-tenant.sh` provisions a
  LOAD_TEST tenant + 50k customers + 200k alerts before the run starts.
