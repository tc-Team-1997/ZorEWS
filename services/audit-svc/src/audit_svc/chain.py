"""Hash-chain implementation for immutable audit log.

Each record commits to the previous record's hash. The chain is appended to a
local NDJSON file — one JSON object per line — to keep the on-disk form
unambiguous and trivially streamable. In production this same NDJSON stream
is uploaded to S3 with Object Lock COMPLIANCE 7y (see
`infra/terraform/30-data/main.tf` -> `aws_s3_bucket_object_lock_configuration.audit`).

Canonicalisation: keys sorted, separators tight, ensure_ascii=False. Hash =
SHA-256 hex over UTF-8 of the canonical string.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

GENESIS_PREV_HASH = "0" * 64


def _canonical(record: dict[str, Any]) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_hash(prev_hash: str, record_without_hash: dict[str, Any]) -> str:
    payload = prev_hash + "|" + _canonical(record_without_hash)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass
class VerifyResult:
    ok: bool
    records_checked: int
    first_break_index: int | None
    reason: str | None = None


class AuditChain:
    """Append-only hash-chain backed by a single NDJSON file."""

    def __init__(self, store_path: str | os.PathLike[str]) -> None:
        self._path = Path(store_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)

    @property
    def path(self) -> Path:
        return self._path

    def _last_hash(self) -> str:
        if not self._path.exists():
            return GENESIS_PREV_HASH
        last = GENESIS_PREV_HASH
        with self._path.open("r", encoding="utf-8") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                last = json.loads(line)["hash"]
        return last

    def append(self, event: dict[str, Any]) -> dict[str, Any]:
        """Append an audit event; returns the persisted record (with prev_hash + hash set)."""
        prev_hash = self._last_hash()
        record = dict(event)
        record["prev_hash"] = prev_hash
        # Strip caller-supplied hash; we always compute it.
        record.pop("hash", None)
        record_hash = compute_hash(prev_hash, record)
        record["hash"] = record_hash
        with self._path.open("a", encoding="utf-8") as fp:
            fp.write(_canonical(record))
            fp.write("\n")
        return record

    def iter_records(self) -> Iterable[dict[str, Any]]:
        if not self._path.exists():
            return
        with self._path.open("r", encoding="utf-8") as fp:
            for line in fp:
                line = line.strip()
                if not line:
                    continue
                yield json.loads(line)

    def verify(self) -> VerifyResult:
        prev = GENESIS_PREV_HASH
        count = 0
        for idx, rec in enumerate(self.iter_records()):
            count += 1
            stored_hash = rec.get("hash")
            stored_prev = rec.get("prev_hash")
            if stored_prev != prev:
                return VerifyResult(False, count, idx, f"prev_hash mismatch at index {idx}")
            without_hash = {k: v for k, v in rec.items() if k != "hash"}
            recomputed = compute_hash(prev, without_hash)
            if recomputed != stored_hash:
                return VerifyResult(False, count, idx, f"hash mismatch at index {idx}")
            prev = stored_hash
        return VerifyResult(True, count, None)
