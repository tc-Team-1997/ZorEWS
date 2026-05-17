"""Monthly PD retrain orchestrator.

Sequence:
    1. (optional) refresh marts via dbt — skipped if --skip-dbt
    2. train a fresh PD model with auto-bumped patch version
    3. compute drift between the prior champion's training data + the new
       training set (data drift only — we don't yet have prod predictions
       to compare against)
    4. compare new model AUC vs the champion's last metric and the hard
       gate (default 0.78)
    5. write a structured summary JSON to <out_dir>/<version>/retrain_summary.json
    6. POST a notification to the BFF (best-effort)

The DAG's BashOperator just runs ``python -m ml.scripts.run_retrain`` —
keeps the DAG file thin so the orchestration logic is unit-testable
without standing up Airflow.

Promotion is intentionally NOT automatic. A risk-modelling lead reviews
the summary + drift report and runs ``python -m ml.registry.cli promote``
manually. This matches the model-risk-management policy at
docs/model-risk-management.md.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess  # noqa: S404
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Allow running as a module from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


@dataclass
class RetrainSummary:
    """Structured outcome — written to disk and used to draft the notification."""

    started_at: str
    finished_at: str
    new_version: str
    auc_holdout: float
    auc_gate: float
    gate_passed: bool
    drift_band: str = "unknown"
    prior_champion_version: Optional[str] = None
    prior_champion_auc: Optional[float] = None
    auc_delta: Optional[float] = None
    notes: list[str] = field(default_factory=list)
    registered: bool = False
    artifact_dir: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)


def _dbt(project_dir: Path, profiles_dir: Path) -> None:
    """Refresh the dbt mart. Hard-failed via subprocess.check_call."""
    if shutil.which("dbt") is None:
        raise RuntimeError("dbt not on PATH — install dbt-postgres or use --skip-dbt")
    env = {**os.environ, "DBT_PROFILES_DIR": str(profiles_dir)}
    for cmd in (["dbt", "deps"], ["dbt", "run"], ["dbt", "test"]):
        subprocess.check_call(cmd, cwd=str(project_dir), env=env)  # noqa: S603


def _read_metrics(model_dir: Path) -> dict:
    metrics_path = model_dir / "metrics.json"
    if not metrics_path.exists():
        raise FileNotFoundError(f"metrics.json missing at {metrics_path}")
    return json.loads(metrics_path.read_text())


def _drift_band(
    *,
    reference_path: Path,
    current_path: Path,
    model_dir: Path,
) -> str:
    """Wraps ml.monitoring.drift.run() — returns just the rolled-up band.

    Imported lazily so unit tests that don't exercise drift don't need
    pandas/sklearn loaded.
    """
    from ml.monitoring.drift import run as drift_run  # type: ignore  # noqa: PLC0415

    if not reference_path.exists() or not current_path.exists():
        return "skipped_no_reference"
    report = drift_run(reference_path, current_path, model_dir=model_dir)
    return str(report.get("overall_band", "unknown"))


def _prior_champion(registry_path: Path, name: str) -> Optional[dict]:
    """Read the registry without instantiating the full Registry class —
    keeps run_retrain testable in environments where the registry hasn't
    been written yet."""
    if not registry_path.exists():
        return None
    try:
        items = json.loads(registry_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    champions = [it for it in items if it.get("name") == name and it.get("status") == "champion"]
    if not champions:
        return None
    # Latest by promoted_at if available, else by version.
    champions.sort(key=lambda it: (it.get("promoted_at", ""), it.get("version", "")), reverse=True)
    return champions[0]


def run_retrain(
    *,
    train_path: str,
    holdout_path: str,
    out_dir: str,
    auc_gate: float = 0.78,
    skip_dbt: bool = True,
    dbt_project_dir: Optional[Path] = None,
    dbt_profiles_dir: Optional[Path] = None,
    registry_path: Optional[Path] = None,
    model_name: str = "pd_xgboost",
) -> RetrainSummary:
    """Execute the retrain pipeline. Returns a populated RetrainSummary.

    Steps that fail hard (training, missing artifacts) raise. Soft failures
    (drift, notification) get appended to summary.notes.
    """
    started = datetime.now(timezone.utc).isoformat()
    notes: list[str] = []

    if not skip_dbt:
        if dbt_project_dir is None or dbt_profiles_dir is None:
            raise ValueError("dbt_project_dir + dbt_profiles_dir required when --no-skip-dbt")
        _dbt(dbt_project_dir, dbt_profiles_dir)

    # Train — defer the import so the module loads quickly under pytest.
    from ml.pipelines.train_pd import __VERSION__ as BASE_VERSION  # noqa: PLC0415
    from ml.pipelines.train_pd import train as train_pd  # noqa: PLC0415

    metrics = train_pd(
        train_path=train_path,
        holdout_path=holdout_path,
        out_dir=out_dir,
        version=BASE_VERSION,  # train_pd auto-bumps if it would clobber an existing dir
        register=True,
        overwrite=False,
    )
    # train_pd writes the model to <out_dir>/v<version>/. Discover the latest
    # by mtime so we don't have to mirror the bump logic here.
    out_dir_path = Path(out_dir)
    versions = sorted(
        (p for p in out_dir_path.glob("v*") if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
    )
    if not versions:
        raise RuntimeError(f"train_pd produced no versions under {out_dir}")
    new_dir = versions[-1]
    new_version = new_dir.name.lstrip("v")

    auc = float(metrics.get("auc_holdout", 0.0))
    gate_passed = auc >= auc_gate

    prior = _prior_champion(registry_path or out_dir_path.parents[1] / "registry" / "registry.json", model_name)
    prior_auc = float(prior["metrics"]["auc_holdout"]) if prior and "metrics" in prior else None
    auc_delta = (auc - prior_auc) if prior_auc is not None else None
    prior_version = prior["version"] if prior else None

    drift_band = "skipped_no_reference"
    if prior_version:
        prior_dir = out_dir_path / f"v{prior_version}"
        try:
            drift_band = _drift_band(
                reference_path=Path(train_path),
                current_path=Path(holdout_path),
                model_dir=prior_dir if prior_dir.exists() else new_dir,
            )
        except Exception as exc:  # noqa: BLE001
            notes.append(f"drift_check_failed: {exc!s}")
            drift_band = "error"

    summary = RetrainSummary(
        started_at=started,
        finished_at=datetime.now(timezone.utc).isoformat(),
        new_version=new_version,
        auc_holdout=auc,
        auc_gate=auc_gate,
        gate_passed=gate_passed,
        drift_band=drift_band,
        prior_champion_version=prior_version,
        prior_champion_auc=prior_auc,
        auc_delta=auc_delta,
        notes=notes,
        registered=True,
        artifact_dir=str(new_dir),
    )
    (new_dir / "retrain_summary.json").write_text(json.dumps(summary.to_dict(), indent=2))
    return summary


def _draft_notification(s: RetrainSummary) -> dict:
    """Map the summary to a {level, title, body} notification payload."""
    if not s.gate_passed:
        level = "danger"
        title = f"PD retrain BELOW gate (AUC {s.auc_holdout:.3f} < {s.auc_gate})"
    elif s.drift_band == "drift":
        level = "warning"
        title = f"PD retrain v{s.new_version} — DATA DRIFT detected"
    elif s.auc_delta is not None and s.auc_delta < -0.02:
        level = "warning"
        title = f"PD retrain v{s.new_version} — AUC regressed by {abs(s.auc_delta):.3f}"
    else:
        level = "success"
        title = f"PD retrain v{s.new_version} complete (AUC {s.auc_holdout:.3f})"

    body_parts = [f"AUC {s.auc_holdout:.3f} (gate {s.auc_gate})"]
    if s.prior_champion_version:
        body_parts.append(f"prior champion v{s.prior_champion_version} AUC {s.prior_champion_auc:.3f}")
    body_parts.append(f"drift: {s.drift_band}")
    return {"level": level, "title": title, "body": " · ".join(body_parts)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", default="ml/data/synthetic_train.parquet")
    parser.add_argument("--holdout", default="ml/data/synthetic_holdout.parquet")
    parser.add_argument("--out-dir", default="ml/models/pd")
    parser.add_argument("--auc-gate", type=float, default=0.78)
    parser.add_argument("--skip-dbt", action="store_true", default=True)
    parser.add_argument("--no-skip-dbt", dest="skip_dbt", action="store_false")
    parser.add_argument("--dbt-project-dir", default="data/dbt/zorews")
    parser.add_argument("--dbt-profiles-dir", default="data/dbt")
    parser.add_argument(
        "--notify",
        action="store_true",
        help="POST the outcome to the BFF /v1/notifications/publish endpoint.",
    )
    args = parser.parse_args()

    summary = run_retrain(
        train_path=args.train,
        holdout_path=args.holdout,
        out_dir=args.out_dir,
        auc_gate=args.auc_gate,
        skip_dbt=args.skip_dbt,
        dbt_project_dir=Path(args.dbt_project_dir),
        dbt_profiles_dir=Path(args.dbt_profiles_dir),
    )
    print(json.dumps(summary.to_dict(), indent=2))

    if args.notify:
        from ml.scripts.notify import post_notification  # noqa: PLC0415

        n = _draft_notification(summary)
        try:
            post_notification(**n, href="/admin/integrations")
        except Exception as exc:  # noqa: BLE001
            print(f"[run_retrain] notification failed: {exc}", file=sys.stderr)
            # Don't fail the DAG task — the bell is best-effort.

    # Exit code: 0 if gate passed, 2 if it didn't (so the DAG marks failed).
    return 0 if summary.gate_passed else 2


if __name__ == "__main__":
    sys.exit(main())
