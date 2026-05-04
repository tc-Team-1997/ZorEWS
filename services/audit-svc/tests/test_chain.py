"""Hash-chain integrity + tamper-detection tests."""

from __future__ import annotations

import json
from pathlib import Path

from audit_svc.chain import AuditChain


def _sample(audit_id: str, action: str = "rule.publish") -> dict:
    return {
        "audit_id": audit_id,
        "service": "regulatory-svc",
        "actor": {"id": "u-001", "type": "USER", "role": "admin"},
        "action": action,
        "resource": {"type": "rule", "id": "RUL-CRD-001"},
        "outcome": "SUCCESS",
        "occurred_at": "2026-04-26T10:00:00Z",
    }


def test_append_and_verify_clean_chain(tmp_path: Path) -> None:
    chain = AuditChain(tmp_path / "audit.ndjson")
    for i in range(5):
        chain.append(_sample(f"a-{i:03d}"))
    result = chain.verify()
    assert result.ok is True
    assert result.records_checked == 5
    assert result.first_break_index is None


def test_genesis_record_has_zero_prev_hash(tmp_path: Path) -> None:
    chain = AuditChain(tmp_path / "audit.ndjson")
    rec = chain.append(_sample("a-000"))
    assert rec["prev_hash"] == "0" * 64
    assert len(rec["hash"]) == 64


def test_tampered_payload_is_detected(tmp_path: Path) -> None:
    store = tmp_path / "audit.ndjson"
    chain = AuditChain(store)
    chain.append(_sample("a-000", action="login"))
    chain.append(_sample("a-001", action="rule.publish"))
    chain.append(_sample("a-002", action="case.close"))

    # Tamper: rewrite the action of record index 1, keep its declared hash.
    lines = store.read_text(encoding="utf-8").splitlines()
    rec1 = json.loads(lines[1])
    rec1["action"] = "rule.retire"  # mutate without recomputing hash
    lines[1] = json.dumps(rec1, sort_keys=True, separators=(",", ":"))
    store.write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = chain.verify()
    assert result.ok is False
    assert result.first_break_index == 1
    assert "hash mismatch" in (result.reason or "")
