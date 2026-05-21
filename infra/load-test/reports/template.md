# Load-test run — YYYY-MM-DD

**Target env:** staging | production-shadow
**Operator:** _name_
**k6 version:** _e.g. v0.50.0_
**BFF commit:** _git sha at run start_

## Scenario

- File: `scenarios/<scenario>.js`
- Profile: _e.g. ramp 0→100 r/s over 1m, hold 5m_
- Duration: _e.g. 6m_
- Total requests: _from k6 summary_

## Results

| Metric | Threshold | Observed | Status |
|---|---|---|---|
| http_req_duration p95 | < 800ms | _Xms_ | ✓ / ✕ |
| http_req_duration p99 | < 2000ms | _Xms_ | ✓ / ✕ |
| http_req_failed rate | < 0.5% | _X.X%_ | ✓ / ✕ |
| streaming target_p95_60s_met (post-run) | true | true / false | ✓ / ✕ |

### Per-endpoint p95 (from `--out json`)

| endpoint | requests | p50 | p95 | p99 | error rate |
|---|---|---|---|---|---|
| alerts_list | _N_ | _Xms_ | _Xms_ | _Xms_ | _X%_ |
| streaming_ingest | _N_ | _Xms_ | _Xms_ | _Xms_ | _X%_ |
| customer_360 | _N_ | _Xms_ | _Xms_ | _Xms_ | _X%_ |
| feature_snapshot | _N_ | _Xms_ | _Xms_ | _Xms_ | _X%_ |
| scenario_run | _N_ | _Xms_ | _Xms_ | _Xms_ | _X%_ |
| reports_run | _N_ | _Xms_ | _Xms_ | _Xms_ | _X%_ |

## Infrastructure metrics

(Pulled from Grafana during the run.)

- Aurora writer CPU avg: _X%_
- Aurora reader CPU avg: _X%_  (target: <60% — HPA threshold)
- MSK broker disk pressure: _X%_  (target: <70%)
- BFF pod count at peak: _N_  (initial: _M_)
- BFF pod CPU p95: _X%_  (target: <70%)
- EKS HPA scaling events: _e.g. 2× scale-up on alerts-svc at T+3m_

## Top-5 slow endpoints

1. `<endpoint>` — p95 _Xms_ — _root cause hypothesis_
2. ...

## Issues / regressions

- _e.g. p99 on customer_360 hit 3500ms at peak; bureau-adapter cold-start delay; mitigation = warm pool._

## Recommendations

- _e.g. scale Aurora reader from t4g.medium → t4g.large_
- _e.g. add HPA min-replicas=3 on regulatory-svc/alerts_

## Gate

- 5× pilot mix gate: PASSED / FAILED
- Reason: _summary_
