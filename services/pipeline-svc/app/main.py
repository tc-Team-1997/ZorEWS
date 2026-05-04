"""
pipeline-svc — FastAPI app exposing two endpoints:

    POST /pipeline/run/{dag_id}   — stub trigger (records a simulated run).
    GET  /pipeline/runs           — list recent simulated runs.

The service is intentionally tiny — it stands in for AWS MWAA's REST API
during local development. agent-ui hits these endpoints from the Scenario
Simulation screen.
"""
from __future__ import annotations

import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel, Field

KNOWN_DAGS = {"cbs_ingestion", "bureau_sync", "feature_build"}

app = FastAPI(
    title="APEX EWS — pipeline-svc",
    version="0.1.0",
    description="Stub trigger / status surface in front of MWAA DAGs.",
)

# In-memory ring buffer (last 100 runs).
_RUNS: deque[dict] = deque(maxlen=100)


class TriggerResponse(BaseModel):
    run_id: str
    dag_id: str
    triggered_at: datetime
    state: Literal["queued", "running", "success", "failed"] = "queued"


class RunRecord(BaseModel):
    run_id: str
    dag_id: str
    triggered_at: datetime
    state: Literal["queued", "running", "success", "failed"]
    note: str | None = None


class RunList(BaseModel):
    runs: list[RunRecord] = Field(default_factory=list)


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"status": "ok", "service": "pipeline-svc"}


@app.post(
    "/pipeline/run/{dag_id}",
    response_model=TriggerResponse,
    tags=["pipeline"],
)
def trigger(dag_id: str) -> TriggerResponse:
    if dag_id not in KNOWN_DAGS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"unknown dag_id={dag_id}; expected one of {sorted(KNOWN_DAGS)}",
        )
    run = TriggerResponse(
        run_id=f"manual__{uuid.uuid4().hex[:12]}",
        dag_id=dag_id,
        triggered_at=datetime.now(timezone.utc),
        state="queued",
    )
    _RUNS.appendleft(run.model_dump() | {"note": "stub trigger"})
    return run


@app.get("/pipeline/runs", response_model=RunList, tags=["pipeline"])
def list_runs(limit: int = 20) -> RunList:
    return RunList(runs=list(_RUNS)[: max(1, min(limit, 100))])
