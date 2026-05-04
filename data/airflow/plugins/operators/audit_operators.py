"""Append a row to audit.event_log from inside a DAG.

In production this is a thin wrapper around audit-svc; in the prototype
we simply log to stdout so the DAG runs without a database connection.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

log = logging.getLogger("apex.audit")


def emit_audit_event(*, event_type: str, actor: str,
                     subject_id: str | None = None,
                     payload: dict | None = None) -> dict:
    record = {
        "event_ts":   datetime.now(timezone.utc).isoformat(),
        "event_type": event_type,
        "actor":      actor,
        "subject_id": subject_id,
        "payload":    payload or {},
    }
    log.info("AUDIT %s", json.dumps(record, default=str))
    return record
