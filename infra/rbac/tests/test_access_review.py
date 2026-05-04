"""Tests for the RBAC matrix loader + roster validator + review script (T3.9)."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

from access_review import (  # type: ignore[import-not-found]
    Matrix,
    load_matrix,
    load_roster,
    main,
    render_report,
    validate_roster,
)


REPO_ROOT = HERE.parent.parent.parent
MATRIX = REPO_ROOT / "infra" / "rbac" / "matrix.json"
ROSTER = REPO_ROOT / "infra" / "rbac" / "scripts" / "sample_roster.json"


# ---------- helpers ----------

def _write(p: Path, body: Dict[str, Any]) -> None:
    p.write_text(json.dumps(body, indent=2), encoding="utf-8")


def _good_matrix() -> Dict[str, Any]:
    return {
        "version": "1.0.0",
        "roles": ["admin", "user"],
        "operations": {
            "things:read": ["admin", "user"],
            "things:write": ["admin"],
        },
        "role_descriptions": {"admin": "ad", "user": "us"},
    }


# ---------- real artefacts ----------

def test_real_matrix_loads_and_is_consistent() -> None:
    m = load_matrix(MATRIX)
    assert "admin" in m.roles
    assert "field_officer" in m.roles
    assert m.version == "1.0.0"
    # Every role mentioned in any operation must be in roles[].
    role_set = set(m.roles)
    for op, allowed in m.operations.items():
        assert set(allowed) <= role_set, f"unknown role in {op}"


def test_real_roster_passes_validation() -> None:
    m = load_matrix(MATRIX)
    roster = load_roster(ROSTER)
    assert validate_roster(m, roster) == []


def test_render_report_against_real_artefacts_smoke() -> None:
    m = load_matrix(MATRIX)
    roster = load_roster(ROSTER)
    now = datetime(2026, 4, 27, 12, 0, tzinfo=timezone.utc)
    report = render_report(m, roster, now=now)
    assert "# APEX EWS — quarterly access review" in report
    assert "alice.admin" in report
    assert "Role distribution" in report
    assert "Dormant accounts" in report
    # No dormant users in the seed roster.
    assert "_None — every active user logged in within 90 days._" in report


# ---------- matrix loader ----------

def test_unknown_role_in_operations_raises(tmp_path: Path) -> None:
    bad = _good_matrix()
    bad["operations"]["things:write"] = ["admin", "ghost"]
    _write(tmp_path / "m.json", bad)
    with pytest.raises(ValueError, match="ghost"):
        load_matrix(tmp_path / "m.json")


def test_roles_must_be_list_of_strings(tmp_path: Path) -> None:
    bad = _good_matrix()
    bad["roles"] = "admin,user"  # wrong type
    _write(tmp_path / "m.json", bad)
    with pytest.raises(ValueError, match="must be a list"):
        load_matrix(tmp_path / "m.json")


# ---------- roster validator ----------

def test_roster_unknown_role_is_flagged(tmp_path: Path) -> None:
    _write(tmp_path / "m.json", _good_matrix())
    matrix = load_matrix(tmp_path / "m.json")
    roster = [
        type("U", (), dict(
            id="u-1", username="x", display_name="x", role="ghost",
            active=True, last_login=None,
        ))(),
    ]
    errors = validate_roster(matrix, roster)  # type: ignore[arg-type]
    assert len(errors) == 1
    assert errors[0].rule == "unknown-role"


def test_duplicate_id_or_username_is_flagged(tmp_path: Path) -> None:
    _write(tmp_path / "m.json", _good_matrix())
    matrix = load_matrix(tmp_path / "m.json")

    def U(**k: Any) -> Any:
        return type("U", (), k)()

    roster = [
        U(id="u-1", username="a", display_name="A", role="admin", active=True, last_login=None),
        U(id="u-1", username="b", display_name="B", role="user", active=True, last_login=None),
        U(id="u-2", username="a", display_name="A2", role="user", active=True, last_login=None),
    ]
    errors = validate_roster(matrix, roster)
    rules = sorted(e.rule for e in errors)
    assert "duplicate-id" in rules
    assert "duplicate-username" in rules


# ---------- dormant detection in render_report ----------

def test_dormant_users_surface_in_report(tmp_path: Path) -> None:
    _write(tmp_path / "m.json", _good_matrix())
    matrix = load_matrix(tmp_path / "m.json")
    roster_obj = {
        "users": [
            {
                "id": "u-1",
                "username": "stale.bob",
                "display_name": "Stale Bob",
                "role": "user",
                "active": True,
                "last_login": "2025-12-01T10:00:00Z",  # old
            },
            {
                "id": "u-2",
                "username": "fresh.eve",
                "display_name": "Fresh Eve",
                "role": "admin",
                "active": True,
                "last_login": "2026-04-26T10:00:00Z",
            },
        ]
    }
    _write(tmp_path / "r.json", roster_obj)
    roster = load_roster(tmp_path / "r.json")
    now = datetime(2026, 4, 27, 12, 0, tzinfo=timezone.utc)
    report = render_report(matrix, roster, now=now)
    assert "stale.bob" in report
    # Eve must NOT be in the dormant section. She'll appear in the user table,
    # but only Bob should appear in the dormant block.
    dormant_block = report.split("## Dormant accounts")[1].split("## Users")[0]
    assert "stale.bob" in dormant_block
    assert "fresh.eve" not in dormant_block


# ---------- CLI ----------

def test_cli_validate_only_succeeds_on_clean_matrix() -> None:
    rc = main(["access_review.py", "--matrix", str(MATRIX), "--validate-only"])
    assert rc == 0


def test_cli_emits_report_to_stdout(capsys: "pytest.CaptureFixture[str]") -> None:
    rc = main([
        "access_review.py",
        "--matrix", str(MATRIX),
        "--roster", str(ROSTER),
        "--report-out", "-",
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "quarterly access review" in out
    assert "alice.admin" in out


def test_cli_returns_1_on_bad_matrix(tmp_path: Path) -> None:
    _write(tmp_path / "m.json", {"roles": "wrong", "operations": {}})
    rc = main(["access_review.py", "--matrix", str(tmp_path / "m.json"), "--validate-only"])
    assert rc == 1
