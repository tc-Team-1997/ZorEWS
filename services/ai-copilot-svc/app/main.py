"""FastAPI app for the ai-copilot scoring service.

Endpoints
---------
* ``POST /score``        -- single-customer PD + level + top-5 reasons.
* ``POST /score/batch``  -- list of customers.
* ``GET  /model/info``   -- current champion + metrics + (optional) challenger.
* ``GET  /health``       -- liveness/readiness.

Champion + challenger
---------------------
On startup we look up the registry champion. If a challenger is also present
we shadow-score every request through it and log the result; the response to
the caller always carries the champion score.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path
from typing import List, Optional

# Make the repo root importable so ``ml.*`` resolves whether we run as
# ``uvicorn app.main:app`` from the service dir, or as a Docker entrypoint.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from app.scoring import (  # type: ignore  # noqa: E402
    HIGH_THRESHOLD,
    LOW_THRESHOLD,
    ModelBundle,
    load_bundle,
    score_batch,
    score_record,
)
from ml.registry.registry import Registry  # noqa: E402


logger = logging.getLogger("ai_copilot")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


# ----------------------------------------------------------------------
# Pydantic schemas
# ----------------------------------------------------------------------
class CustomerFeatures(BaseModel):
    customer_id: Optional[str] = None
    utilization: float = Field(..., ge=0.0, le=1.5)
    dpd_max_90d: float = Field(..., ge=0.0)
    balance_drop_30d_pct: float
    bureau_score: float = Field(..., ge=0.0, le=1000.0)
    repayment_delay_streak: int = Field(..., ge=0)
    txn_volume_zscore_90d: float
    tenure_months: int = Field(..., ge=0)
    product_type: str
    income_bucket: str

    def to_record(self) -> dict:
        return self.model_dump()


class ReasonCode(BaseModel):
    feature: str
    value: object
    shap_value: float
    direction: str  # "positive" | "negative"


class ScoreResponse(BaseModel):
    customer_id: Optional[str] = None
    pd: float
    level: str
    top_reasons: List[ReasonCode]
    model_name: str
    model_version: str


class BatchRequest(BaseModel):
    customers: List[CustomerFeatures]


class BatchResponse(BaseModel):
    scores: List[ScoreResponse]


class ModelInfoResponse(BaseModel):
    champion: dict
    challenger: Optional[dict] = None
    level_bands: dict


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_version: Optional[str] = None


# ----------------------------------------------------------------------
# App + state
# ----------------------------------------------------------------------
app = FastAPI(title="APEX EWS — AI Copilot", version="0.1.0")


class _State:
    champion: Optional[ModelBundle] = None
    challenger: Optional[ModelBundle] = None
    registry_path: Optional[str] = None
    model_name: str = "pd_xgboost"


state = _State()


def _load_from_registry(model_name: str, registry_path: Optional[str]) -> None:
    reg = Registry(registry_path)
    champ_entry = reg.get_champion(model_name)
    if champ_entry is None:
        logger.warning("No champion registered for %s; service will return 503 until trained.", model_name)
        state.champion = None
    else:
        state.champion = load_bundle(
            name=champ_entry["name"],
            version=champ_entry["version"],
            artifact_path=champ_entry["artifact_path"],
        )
        logger.info("Loaded champion %s v%s", champ_entry["name"], champ_entry["version"])

    chall_entry = reg.get_challenger(model_name)
    if chall_entry is not None:
        try:
            state.challenger = load_bundle(
                name=chall_entry["name"],
                version=chall_entry["version"],
                artifact_path=chall_entry["artifact_path"],
            )
            logger.info("Loaded challenger %s v%s", chall_entry["name"], chall_entry["version"])
        except Exception as exc:  # noqa: BLE001
            logger.warning("Challenger load failed: %s", exc)
            state.challenger = None
    else:
        state.challenger = None


@app.on_event("startup")
def _on_startup() -> None:
    state.model_name = os.environ.get("APEX_MODEL_NAME", "pd_xgboost")
    state.registry_path = os.environ.get("APEX_REGISTRY_PATH") or None
    try:
        _load_from_registry(state.model_name, state.registry_path)
    except Exception as exc:  # noqa: BLE001
        logger.error("Startup model load failed: %s", exc)


def _require_champion() -> ModelBundle:
    if state.champion is None:
        raise HTTPException(status_code=503, detail="Champion model not loaded")
    return state.champion


def _shadow_score(record: dict, champion_score: dict) -> None:
    """Score the same record through challenger and log divergence."""
    if state.challenger is None:
        return
    try:
        chall = score_record(state.challenger, record, top_k=5)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Shadow score failed: %s", exc)
        return
    delta = chall["pd"] - champion_score["pd"]
    logger.info(
        "shadow_score model=%s/%s vs champion=%s/%s pd=%.4f delta=%.4f level_match=%s",
        chall["model_name"],
        chall["model_version"],
        champion_score["model_name"],
        champion_score["model_version"],
        chall["pd"],
        delta,
        chall["level"] == champion_score["level"],
    )


# ----------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------
@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_loaded=state.champion is not None,
        model_version=state.champion.version if state.champion else None,
    )


@app.get("/model/info", response_model=ModelInfoResponse)
def model_info() -> ModelInfoResponse:
    champ = _require_champion()
    return ModelInfoResponse(
        champion={
            "name": champ.name,
            "version": champ.version,
            "metrics": champ.metrics,
            "artifact_path": str(champ.artifact_path),
        },
        challenger=(
            {
                "name": state.challenger.name,
                "version": state.challenger.version,
                "metrics": state.challenger.metrics,
                "artifact_path": str(state.challenger.artifact_path),
            }
            if state.challenger
            else None
        ),
        level_bands={
            "low_max": LOW_THRESHOLD,
            "high_min": HIGH_THRESHOLD,
            "rule": "Low: pd<low_max; Medium: low_max<=pd<high_min; High: pd>=high_min",
        },
    )


@app.post("/score", response_model=ScoreResponse)
def score(features: CustomerFeatures) -> ScoreResponse:
    champ = _require_champion()
    t0 = time.time()
    result = score_record(champ, features.to_record())
    _shadow_score(features.to_record(), result)
    logger.info(
        "score customer=%s pd=%.4f level=%s ms=%.1f",
        result.get("customer_id"),
        result["pd"],
        result["level"],
        (time.time() - t0) * 1000,
    )
    return ScoreResponse(**result)


@app.post("/score/batch", response_model=BatchResponse)
def score_batch_endpoint(req: BatchRequest) -> BatchResponse:
    champ = _require_champion()
    if not req.customers:
        return BatchResponse(scores=[])
    records = [c.to_record() for c in req.customers]
    t0 = time.time()
    results = score_batch(champ, records)
    if state.challenger is not None:
        # Shadow-score in batch as well.
        try:
            chall_scores = score_batch(state.challenger, records)
            for champ_r, chall_r in zip(results, chall_scores):
                logger.info(
                    "shadow_batch customer=%s champ_pd=%.4f chall_pd=%.4f",
                    champ_r.get("customer_id"),
                    champ_r["pd"],
                    chall_r["pd"],
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Batch shadow score failed: %s", exc)
    logger.info("score_batch n=%d ms=%.1f", len(records), (time.time() - t0) * 1000)
    return BatchResponse(scores=[ScoreResponse(**r) for r in results])
