# logs/ai.md — ai agent

> Append entries chronologically. Each entry: task id, files touched, decisions, hand-offs, blockers.

## 2026-04-26 — Initialised

- Log file created. Awaiting first task.

## 2026-04-26 — Phase 2 scaffolding (T2.2, T2.3, T2.4, T2.5, T2.6, T2.10)

### Files touched

Synthetic data (placeholder for `mart.customer_360`):
- `ml/data/generate_synthetic.py`
- `ml/data/load_from_mart.py` (stub for the swap)
- `ml/data/README.md`

Training + features:
- `ml/__init__.py`
- `ml/pipelines/__init__.py`
- `ml/pipelines/features.py`
- `ml/pipelines/train_pd.py`

Registry:
- `ml/registry/__init__.py`
- `ml/registry/registry.py`
- `ml/registry/cli.py`
- `ml/registry/registry.json` (empty initial state)

Drift monitoring:
- `ml/monitoring/__init__.py`
- `ml/monitoring/drift.py`
- `ml/monitoring/perturb_for_test.py`

ai-copilot-svc (FastAPI):
- `services/ai-copilot-svc/app/__init__.py`
- `services/ai-copilot-svc/app/main.py`
- `services/ai-copilot-svc/app/scoring.py`
- `services/ai-copilot-svc/tests/__init__.py`
- `services/ai-copilot-svc/tests/conftest.py`
- `services/ai-copilot-svc/tests/test_api.py`
- `services/ai-copilot-svc/requirements.txt`
- `services/ai-copilot-svc/Dockerfile`
- `services/ai-copilot-svc/pytest.ini`
- `services/ai-copilot-svc/README.md`

MRM + index:
- `ml/docs/model-risk-management.md`
- `ml/README.md`

### Decisions

- **Synthetic data design.** 5,000 rows, 6% positive prevalence, latent risk
  built from a monotone blend of utilization, dpd_max_90d, balance_drop,
  bureau_score, repayment_delay_streak, plus a non-linear interaction
  between utilization and bureau_score so a tree-based learner has signal
  to learn. Random label noise added so AUC ~0.85 (not 1.0). Calibrated
  intercept by bisection so empirical prevalence matches the target.
- **Algorithm.** XGBoost binary classifier (`hist`, max_depth=5, lr=0.07,
  500 trees, regularised, 5-fold CV). Modest depth + small lr + lambda=1.5
  to keep generalisation honest on the synthetic set.
- **Calibration.** Isotonic via `CalibratedClassifierCV` on top of XGB.
  Picked over Platt because tree-based scores show non-monotonic
  miscalibration at the tails on this kind of synthetic mixture.
- **SHAP.** `TreeExplainer` is built on the *uncalibrated* booster (SHAP
  on calibrated wrappers is not supported); the calibrated model still
  drives the PD value returned to callers. This is documented in the MRM
  doc, §3.
- **Level bands.** Configurable via env (`APEX_LEVEL_LOW_MAX=0.05`,
  `APEX_LEVEL_HIGH_MIN=0.20`). Defaults match REQUIREMENTS FR-AI-2 spirit
  ("configurable") and the prevalence (~6%) so the bands are meaningfully
  separated for the typical population.
- **Training-time DoD.** `train_pd.py` exits non-zero if holdout AUC
  drops below 0.78 — guardrail against silent regressions when we swap
  in real `mart.customer_360`.
- **Registry.** JSON file + atomic write-then-rename. Single-champion
  invariant enforced; promoting auto-archives the previous champion.
  Shape ready for a future swap to DynamoDB / Glue catalog without
  changing call sites.
- **Champion/challenger.** Service loads both at startup. Champion serves
  the response; challenger is shadow-scored and the divergence logged.
  No traffic is routed to the challenger.
- **Drift CLI.** PSI for both numeric (quantile bins) and categorical
  features. Industry-standard severity bands (0.10 / 0.25). KS for
  prediction drift implemented in pure NumPy (no scipy dependency).
  Performance drift requires labels — it activates only when the
  current snapshot carries `defaulted_within_60d`.
- **Service tests.** A throwaway model is trained inside the pytest
  fixture (~1s) and registered to a tmp registry, so the suite is
  hermetic and does not depend on `ml/models/pd/v0.1.0/` having been
  trained.

### Status of execution-bound DoD steps

I could not execute commands in this run (Bash tool denied). The static
deliverables (code, tests, docs) are all in place. The user must run, in
order, to flip the execution-bound DoD checkboxes:

```bash
python ml/data/generate_synthetic.py --out ml/data --n 5000 --seed 42
python ml/pipelines/train_pd.py
python -m ml.registry.cli promote --name pd_xgboost --version 0.1.0
python -m ml.registry.cli list

python -m ml.monitoring.perturb_for_test \
    --in  ml/data/synthetic_train.parquet \
    --out ml/data/synthetic_train_perturbed.parquet \
    --feature utilization --shift 0.25
python -m ml.monitoring.drift \
    --reference ml/data/synthetic_train.parquet \
    --current   ml/data/synthetic_train_perturbed.parquet \
    --model-dir ml/models/pd/v0.1.0 \
    --out ml/monitoring/drift_smoke.json

cd services/ai-copilot-svc && pytest -q
```

The training script is **engineered to land AUC ~0.85 on holdout** with
the seed=42, n=5000 generator config — comfortably above the 0.78 floor.

### Hand-offs

- **agent-data:** when `mart.customer_360` is ready, run
  `python ml/data/load_from_mart.py --start <YYYY-MM-DD> --end <YYYY-MM-DD>`
  (set `APEX_MART_URL`) and re-train. Expected schema is documented in
  `ml/data/README.md` and `ml/data/load_from_mart.py`. The training
  pipeline reads parquet at fixed paths so no other code changes.
- **agent-alert:** score endpoint at `POST /score` returns
  `{pd, level, top_reasons, model_name, model_version}`; consume
  `level` for severity merge (FR-ALERT-2: `severity = max(rule, score-band)`).
  Level bands are configurable via env (`APEX_LEVEL_LOW_MAX`,
  `APEX_LEVEL_HIGH_MIN`) — defaults Low<0.05, Medium 0.05–0.20, High>=0.20.
- **agent-ui:** `top_reasons` is a list of
  `{feature, value, shap_value, direction}` where
  `direction == "positive"` means the feature **increases** PD.
  Render as the Top-5 panel on the Customer Risk Profile screen
  (T2.8); use DMS semantic tokens — `direction=positive` -> danger,
  `direction=negative` -> success.

### Blockers

- None code-side. Execution-bound DoD steps (above) require the user to
  run Python locally; flagged in the Phase 2 hand-off summary.

## 2026-05-14 — T6 M7.6 — Printable model performance summary

### Tasks ticked
- T6 sub-phase M7.6 — printable model performance summary export. T6 sub-phase tally 111 → 112.

### Files touched
- `services/bff/src/model_performance_summary.ts` (new) — pure `renderPerformanceSummary(summary, ctx)` returns plain-text mirroring M15.4 `renderEvidenceSummary` style. Fixed-width monospace; header section (tenant, model, generated_at, generated_by, entry_count, window) + per-metric blocks (latest@ts, mean, min/p50/p95/max line) + tail "Not observed: …" listing absent metrics. Trims trailing zeros via `fmtNum` for readability. `PerformanceSummaryRenderContext` carries `generated_at`, `generated_by`, optional `range: {since?, until?}`.
- `services/bff/__tests__/model_performance_summary.test.ts` (new) — 12 jest tests: 6 unit (empty shell, "full ledger" window when no range, range → since→until format, single-metric format with absent-metric tail, all-5-metrics no "Not observed" line, integer-value trailing-zero trim) + 6 route (empty ledger 200 text/plain + Content-Disposition, recorded metric surfaces, unknown_model → 404 JSON not text, ?since reflected on Window line, 403 wrong role, M7.5 /summary still returns JSON envelope).
- `services/bff/src/server.ts` — new route `GET /v1/ai/models/:model_id/performance/summary.txt` mounted BEFORE `/performance/summary` so the literal `.txt` suffix isn't swallowed by the parent wildcard. Same `customers:read_risk_profile` RBAC as M7.5. Returns `text/plain; charset=utf-8` with `Content-Disposition: inline`. 404 unknown_model returned as JSON envelope.

### Decisions
- **Mirror M15.4 exactly.** Same separators, formatting, response posture. SPA reuses the same print-to-PDF UI for both audit + model summaries.
- **Window line surfaces filter context.** Auditors reading the printed page know what subset is shown.
- **Trim trailing zeros.** `0.85` not `0.8500`. Cleaner monospace look.
- **404 returned as JSON, not text.** Consistent error shape with the rest of `/v1/*` even on a text-flavored route.

### Hand-offs
- **agent-ui** — model registry page can render a "Print performance summary" button → opens `/v1/ai/models/:model_id/performance/summary.txt?since=...` in a new tab → browser print preview attaches it to model cards / regulator filings.

### Verification
- `npx jest __tests__/model_performance_summary.test.ts` — 12/12 pass.
- `npx jest` (full BFF suite) — 4257 pass / 58 skipped / 4317 total. Intermittent cross-suite singleton flakiness in `report_schedules` / `scenario_custom` — both pass when run alone (210/210); pre-existing pattern unrelated to M7.6.
- `npx tsc --noEmit` — clean.
