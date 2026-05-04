"""Tests for the BACKWARD-compatibility checker (T3.8).

Strategy: write small synthetic v1 + v2 schemas to a tmp dir, run
``check_registry``, assert the expected breaks (or absence). Plus one
test that exercises the real registry to guard against regressions when
agent-* land new schema versions.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Any

import pytest

# The script lives one directory up.
import sys
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from check_compat import (  # type: ignore[import-not-found]
    CompatBreak,
    check_pair,
    check_registry,
    load_schemas,
)


# ---------- helpers ----------

def _write(dir: Path, name: str, body: Dict[str, Any]) -> None:
    (dir / name).write_text(json.dumps(body, indent=2), encoding="utf-8")


def _v1(title: str = "apex.test.events", **overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://apex-ews/schemas/{title}.v1.json",
        "title": title,
        "version": "1.0.0",
        "compatibility": "BACKWARD",
        "type": "object",
        "required": ["id", "ts"],
        "properties": {
            "id": {"type": "string"},
            "ts": {"type": "string", "format": "date-time"},
            "severity": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
            "loan_id": {"type": ["string", "null"]},
        },
        "additionalProperties": False,
    }
    base.update(overrides)
    return base


def _v2(**overrides: Any) -> Dict[str, Any]:
    return _v1(**overrides) | {"version": "2.0.0", "$id": "https://apex-ews/schemas/apex.test.events.v2.json"}


# ---------- tests on the real registry ----------

def test_real_registry_passes() -> None:
    registry = HERE.parent
    breaks = check_registry(registry)
    assert breaks == [], "\n".join(b.render() for b in breaks)


def test_real_registry_loads_seven_schemas() -> None:
    schemas = load_schemas(HERE.parent)
    assert len(schemas) == 7
    titles = {s.title for s in schemas}
    assert "apex.regulatory.events" in titles
    # Two versions of the regulatory topic.
    versions = sorted(s.version_str for s in schemas if s.title == "apex.regulatory.events")
    assert versions == ["1.0.0", "2.0.0"]


# ---------- positive: BACKWARD-compatible changes ----------

def test_v2_adding_optional_field_is_compatible(tmp_path: Path) -> None:
    _write(tmp_path, "apex.test.events.v1.json", _v1())
    v2 = _v2(properties={
        "id": {"type": "string"},
        "ts": {"type": "string", "format": "date-time"},
        "severity": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
        "loan_id": {"type": ["string", "null"]},
        "trace_id": {"type": "string"},
    })
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert breaks == []


def test_v2_widening_enum_is_compatible(tmp_path: Path) -> None:
    v1 = _v1()
    v2 = _v2()
    v2["properties"]["severity"]["enum"] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    assert check_registry(tmp_path) == []


def test_v2_widening_type_is_compatible(tmp_path: Path) -> None:
    v1 = _v1()
    v2 = _v2()
    v2["properties"]["id"]["type"] = ["string", "null"]
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    assert check_registry(tmp_path) == []


def test_demoting_required_to_optional_is_compatible(tmp_path: Path) -> None:
    v1 = _v1()
    v2 = _v2()
    v2["required"] = ["id"]   # ts becomes optional
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    # Old payloads still carry `ts`, so they still validate against v2.
    assert check_registry(tmp_path) == []


# ---------- negative: BACKWARD-incompatible changes ----------

def test_required_addition_is_a_break(tmp_path: Path) -> None:
    v1 = _v1()
    v2 = _v2()
    v2["required"] = ["id", "ts", "trace_id"]
    v2["properties"]["trace_id"] = {"type": "string"}
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert any(b.rule == "required-added" and "trace_id" in b.detail for b in breaks)


def test_property_removal_is_a_break(tmp_path: Path) -> None:
    v1 = _v1()
    v2 = _v2()
    del v2["properties"]["loan_id"]
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert any(b.rule == "property-removed" and "loan_id" in b.detail for b in breaks)


def test_type_narrowing_is_a_break(tmp_path: Path) -> None:
    v1 = _v1()
    v2 = _v2()
    v2["properties"]["loan_id"]["type"] = "string"  # was ["string", "null"]
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert any(b.rule == "type-narrowed" and "loan_id" in b.pointer for b in breaks)


def test_enum_value_removal_is_a_break(tmp_path: Path) -> None:
    v1 = _v1()
    v2 = _v2()
    v2["properties"]["severity"]["enum"] = ["LOW", "MEDIUM"]  # HIGH removed
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert any(b.rule == "enum-removed" and "severity" in b.pointer for b in breaks)
    assert any("'HIGH'" in b.detail for b in breaks)


def test_closing_additional_properties_is_a_break(tmp_path: Path) -> None:
    v1 = _v1()
    v1["additionalProperties"] = True   # open in v1
    v2 = _v2()
    v2["additionalProperties"] = False  # closed in v2
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert any(b.rule == "additional-properties-closed" for b in breaks)


# ---------- recursion into nested objects + arrays ----------

def test_break_inside_array_items_is_detected(tmp_path: Path) -> None:
    v1 = _v1()
    v1["properties"]["events"] = {
        "type": "array",
        "items": {
            "type": "object",
            "required": ["kind"],
            "properties": {"kind": {"type": "string", "enum": ["call", "visit"]}},
        },
    }
    v2 = _v2()
    v2["properties"]["events"] = {
        "type": "array",
        "items": {
            "type": "object",
            "required": ["kind"],
            "properties": {"kind": {"type": "string", "enum": ["call"]}},  # visit removed
        },
    }
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert any(b.rule == "enum-removed" and "events/items/properties/kind" in b.pointer for b in breaks)


def test_break_inside_nested_object_is_detected(tmp_path: Path) -> None:
    v1 = _v1()
    v1["properties"]["scoring"] = {
        "type": "object",
        "properties": {"pd": {"type": ["number", "null"]}},
    }
    v2 = _v2()
    v2["properties"]["scoring"] = {
        "type": "object",
        "properties": {"pd": {"type": "number"}},  # narrowed
    }
    _write(tmp_path, "apex.test.events.v1.json", v1)
    _write(tmp_path, "apex.test.events.v2.json", v2)
    breaks = check_registry(tmp_path)
    assert any(b.rule == "type-narrowed" and "scoring/properties/pd" in b.pointer for b in breaks)


# ---------- malformed schema input ----------

def test_malformed_schema_raises(tmp_path: Path) -> None:
    bad = {"title": "x", "version": "1.0.0", "type": "not-a-type"}
    _write(tmp_path, "x.v1.json", bad)
    with pytest.raises(Exception):
        load_schemas(tmp_path)


def test_missing_version_raises(tmp_path: Path) -> None:
    _write(tmp_path, "x.v1.json", {"title": "x", "type": "object"})
    with pytest.raises(ValueError):
        load_schemas(tmp_path)


# ---------- direct check_pair API ----------

def test_check_pair_returns_typed_break_records() -> None:
    schemas = load_schemas(HERE.parent)
    pairs = [(a, b) for a in schemas for b in schemas
             if a.title == b.title and a.version < b.version]
    # apex.regulatory.events v1 → v2 is the only real pair.
    assert len(pairs) == 1
    breaks = check_pair(pairs[0][0], pairs[0][1])
    assert all(isinstance(b, CompatBreak) for b in breaks)
    # And the registry pair is clean:
    assert breaks == []
