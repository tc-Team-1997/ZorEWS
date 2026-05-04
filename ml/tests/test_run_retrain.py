"""Tests for ml.scripts.run_retrain and ml.scripts.notify.

We don't actually retrain a model here — train_pd takes seconds and pulls
in pandas/sklearn/xgboost. Instead we stub `train_pd.train` + the drift
helper to keep the suite focused on the orchestrator's branching logic
(gate pass/fail, drift severity, prior-champion comparison, notification
drafting).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

# Allow `import ml.scripts.run_retrain` when running pytest from repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ml.scripts import notify, run_retrain  # noqa: E402


# ─── Helpers ──────────────────────────────────────────────────────────


def _make_model_dir(tmp_path: Path, version: str) -> Path:
    d = tmp_path / "models" / "pd" / f"v{version}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "metrics.json").write_text(
        json.dumps({"auc_holdout": 0.85, "ks": 0.6, "gini": 0.7})
    )
    return d


def _stub_train(metrics: dict, target_dir: Path):
    """Returns a callable that mirrors train_pd.train() — writes a metrics.json
    + returns the same dict, without actually fitting an XGBoost model."""

    def _fake(**_kwargs):
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "metrics.json").write_text(json.dumps(metrics))
        return metrics

    return _fake


# ─── _draft_notification — pure mapping ───────────────────────────────


def _summary(**overrides) -> run_retrain.RetrainSummary:
    base = dict(
        started_at=datetime.now(timezone.utc).isoformat(),
        finished_at=datetime.now(timezone.utc).isoformat(),
        new_version="0.2.0",
        auc_holdout=0.84,
        auc_gate=0.78,
        gate_passed=True,
        drift_band="stable",
    )
    base.update(overrides)
    return run_retrain.RetrainSummary(**base)


def test_draft_notification_success_when_all_clear():
    n = run_retrain._draft_notification(_summary())
    assert n["level"] == "success"
    assert "0.2.0" in n["title"]
    assert "0.840" in n["title"] or "0.84" in n["title"]


def test_draft_notification_danger_when_gate_failed():
    n = run_retrain._draft_notification(_summary(auc_holdout=0.7, gate_passed=False))
    assert n["level"] == "danger"
    assert "BELOW gate" in n["title"]


def test_draft_notification_warning_on_drift():
    n = run_retrain._draft_notification(_summary(drift_band="drift"))
    assert n["level"] == "warning"
    assert "DRIFT" in n["title"]


def test_draft_notification_warning_on_auc_regression():
    n = run_retrain._draft_notification(
        _summary(auc_holdout=0.81, prior_champion_auc=0.86, auc_delta=-0.05)
    )
    assert n["level"] == "warning"
    assert "regressed" in n["title"]


def test_draft_notification_includes_prior_champion_in_body():
    n = run_retrain._draft_notification(
        _summary(prior_champion_version="0.1.0", prior_champion_auc=0.82)
    )
    assert "0.1.0" in n["body"]
    assert "0.820" in n["body"]


# ─── _prior_champion ───────────────────────────────────────────────────


def test_prior_champion_returns_latest_promoted(tmp_path: Path):
    reg = tmp_path / "registry.json"
    reg.write_text(
        json.dumps(
            [
                {
                    "name": "pd_xgboost",
                    "version": "0.1.0",
                    "status": "champion",
                    "promoted_at": "2026-02-01T00:00:00Z",
                    "metrics": {"auc_holdout": 0.81},
                },
                {
                    "name": "pd_xgboost",
                    "version": "0.2.0",
                    "status": "champion",
                    "promoted_at": "2026-04-01T00:00:00Z",
                    "metrics": {"auc_holdout": 0.85},
                },
                {"name": "pd_xgboost", "version": "0.3.0", "status": "challenger"},
            ]
        )
    )
    out = run_retrain._prior_champion(reg, "pd_xgboost")
    assert out is not None
    assert out["version"] == "0.2.0"
    assert out["metrics"]["auc_holdout"] == 0.85


def test_prior_champion_returns_none_when_no_registry(tmp_path: Path):
    assert run_retrain._prior_champion(tmp_path / "missing.json", "pd_xgboost") is None


def test_prior_champion_returns_none_when_only_challengers(tmp_path: Path):
    reg = tmp_path / "registry.json"
    reg.write_text(
        json.dumps([{"name": "pd_xgboost", "version": "0.1.0", "status": "challenger"}])
    )
    assert run_retrain._prior_champion(reg, "pd_xgboost") is None


# ─── run_retrain — happy path with stubbed train ──────────────────────


def test_run_retrain_writes_summary_file_and_passes_gate(tmp_path: Path):
    out_dir = tmp_path / "models" / "pd"
    out_dir.mkdir(parents=True)
    target = out_dir / "v0.1.0"
    fake_train = _stub_train(
        {"auc_holdout": 0.85, "ks": 0.6, "gini": 0.7}, target
    )

    train_path = tmp_path / "train.parquet"
    holdout_path = tmp_path / "holdout.parquet"
    train_path.touch()
    holdout_path.touch()

    with patch("ml.pipelines.train_pd.train", side_effect=fake_train):
        s = run_retrain.run_retrain(
            train_path=str(train_path),
            holdout_path=str(holdout_path),
            out_dir=str(out_dir),
            registry_path=tmp_path / "registry.json",  # missing → no prior champion
        )
    assert s.gate_passed
    assert s.auc_holdout == 0.85
    assert s.new_version == "0.1.0"
    assert s.drift_band == "skipped_no_reference"  # no prior champion
    summary_file = Path(s.artifact_dir) / "retrain_summary.json"
    assert summary_file.exists()
    parsed = json.loads(summary_file.read_text())
    assert parsed["gate_passed"] is True


def test_run_retrain_marks_gate_failed_when_auc_below_threshold(tmp_path: Path):
    out_dir = tmp_path / "models" / "pd"
    out_dir.mkdir(parents=True)
    target = out_dir / "v0.1.0"
    fake_train = _stub_train({"auc_holdout": 0.65}, target)

    train_path = tmp_path / "train.parquet"
    train_path.touch()
    holdout_path = tmp_path / "holdout.parquet"
    holdout_path.touch()

    with patch("ml.pipelines.train_pd.train", side_effect=fake_train):
        s = run_retrain.run_retrain(
            train_path=str(train_path),
            holdout_path=str(holdout_path),
            out_dir=str(out_dir),
            auc_gate=0.78,
            registry_path=tmp_path / "registry.json",
        )
    assert not s.gate_passed
    assert s.auc_holdout == 0.65


def test_run_retrain_picks_up_prior_champion_metrics(tmp_path: Path):
    out_dir = tmp_path / "models" / "pd"
    (out_dir / "v0.1.0").mkdir(parents=True)
    (out_dir / "v0.1.0" / "metrics.json").write_text(
        json.dumps({"auc_holdout": 0.82})
    )
    reg = tmp_path / "registry.json"
    reg.write_text(
        json.dumps(
            [
                {
                    "name": "pd_xgboost",
                    "version": "0.1.0",
                    "status": "champion",
                    "promoted_at": "2026-03-01T00:00:00Z",
                    "metrics": {"auc_holdout": 0.82},
                }
            ]
        )
    )
    target = out_dir / "v0.2.0"
    fake_train = _stub_train({"auc_holdout": 0.86}, target)

    train_path = tmp_path / "train.parquet"
    train_path.touch()
    holdout_path = tmp_path / "holdout.parquet"
    holdout_path.touch()

    # Stub the drift call so we don't actually load pandas + the model.
    with patch("ml.pipelines.train_pd.train", side_effect=fake_train), patch(
        "ml.scripts.run_retrain._drift_band", return_value="stable"
    ):
        s = run_retrain.run_retrain(
            train_path=str(train_path),
            holdout_path=str(holdout_path),
            out_dir=str(out_dir),
            registry_path=reg,
        )
    assert s.prior_champion_version == "0.1.0"
    assert s.prior_champion_auc == 0.82
    assert s.auc_delta == pytest.approx(0.04)
    assert s.drift_band == "stable"


# ─── notify.post_notification ──────────────────────────────────────────


def test_post_notification_sends_correct_body_and_headers(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout):  # noqa: ARG001
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        captured["body"] = req.data

        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"ok": true}'

        return FakeResp()

    monkeypatch.setattr(notify.urllib.request, "urlopen", fake_urlopen)
    out = notify.post_notification(
        level="warning",
        title="hi",
        body="b",
        href="/x",
        bff_url="http://test:9999",
        role="admin",
    )
    assert out == {"ok": True}
    assert captured["url"] == "http://test:9999/v1/notifications/publish"
    payload = json.loads(captured["body"].decode("utf-8"))
    assert payload == {"level": "warning", "title": "hi", "body": "b", "href": "/x"}
    # Header keys are normalised to Title-Case by urllib.
    norm = {k.lower(): v for k, v in captured["headers"].items()}
    assert norm["x-apex-role"] == "admin"
    assert norm["content-type"] == "application/json"


def test_post_notification_omits_optional_fields_when_unset(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout):  # noqa: ARG001
        captured["body"] = req.data

        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{}'

        return FakeResp()

    monkeypatch.setattr(notify.urllib.request, "urlopen", fake_urlopen)
    notify.post_notification(level="info", title="t", bff_url="http://test")
    payload = json.loads(captured["body"].decode("utf-8"))
    assert "body" not in payload
    assert "href" not in payload
    assert payload == {"level": "info", "title": "t"}
