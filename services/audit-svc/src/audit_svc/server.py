"""HTTP entry-point for audit-svc.

In production this service is also a Kafka consumer subscribed to
`apex.audit.events`. The MSK consumer loop calls `chain.append(event)` for
every record. Locally we expose a `POST /audit/events` endpoint which serves
the same purpose and is what the unit tests drive.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .chain import AuditChain


class AuditEvent(BaseModel):
    audit_id: str = Field(..., min_length=1)
    service: str
    actor: dict[str, Any]
    action: str
    resource: dict[str, Any]
    outcome: str
    occurred_at: str
    ip: str | None = None
    user_agent: str | None = None
    trace_id: str | None = None
    payload: dict[str, Any] | None = None


def build_app(store_path: str | None = None) -> FastAPI:
    path = store_path or os.environ.get("AUDIT_STORE_PATH", "./audit-store/audit.ndjson")
    chain = AuditChain(path)

    app = FastAPI(title="apex-ews/audit-svc", version="0.1.0")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/audit/events", status_code=201)
    def append_event(event: AuditEvent) -> dict[str, Any]:
        record = chain.append(event.model_dump(exclude_none=True))
        return {
            "audit_id": record["audit_id"],
            "hash": record["hash"],
            "prev_hash": record["prev_hash"],
        }

    @app.get("/audit/verify")
    def verify() -> dict[str, Any]:
        result = chain.verify()
        if result.ok:
            return {
                "status": "OK",
                "records_checked": result.records_checked,
                "first_break_index": None,
            }
        # 200 with status=BROKEN — verifier is observability, not auth.
        return {
            "status": "BROKEN",
            "records_checked": result.records_checked,
            "first_break_index": result.first_break_index,
            "reason": result.reason,
        }

    return app


app = build_app()
