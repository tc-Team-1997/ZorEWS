"""BACKWARD-compatibility checker for the APEX EWS schema registry.

Implements **T3.8** (the CI half — Glue resource is the Terraform half).

For every JSON Schema in ``infra/schema-registry/`` the checker:

1. Validates that the file is a well-formed JSON Schema (draft 2020-12).
2. Groups schemas by ``title`` (the topic name) and orders them by ``version``.
3. For each consecutive pair (vN, vN+1), asserts BACKWARD compatibility per
   the rules below.

A schema is **BACKWARD-compatible** with its predecessor when every payload
that validates against vN also validates against vN+1. The rules used here
are a conservative subset that covers the real breakages we'd see on this
repo's contracts:

* No required field may be **added** in vN+1 (vN payloads wouldn't carry it).
* No required field may be **removed** in vN+1 if it was *also a property* of
  vN (that's a rename or drop — same effect for v1 consumers reading v2).
* No property may have its type **narrowed** (e.g. ``["string", "null"] →
  "string"``, or ``"number" → "integer"``).
* No ``enum`` values may be **removed**; additions are fine. ``null`` is
  treated as an enum value for this purpose.
* If vN declared ``additionalProperties: true`` (or omitted it), vN+1 cannot
  flip it to ``false`` (vN payloads might carry extra keys).

Anything else (adding optional fields, widening types, adding enum values,
adding nested schemas) is allowed.

Usage::

    python infra/schema-registry/scripts/check_compat.py
    # exit 0 when all pairs are BACKWARD-compatible; exit 1 otherwise.

Programmatic use::

    from check_compat import check_registry
    breaks = check_registry(Path("infra/schema-registry"))
    assert not breaks
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from jsonschema import Draft202012Validator


# ---------- Data ----------

@dataclass(frozen=True)
class SchemaFile:
    path: Path
    title: str
    version: Tuple[int, int, int]
    raw: Dict[str, Any]

    @property
    def version_str(self) -> str:
        return ".".join(str(p) for p in self.version)


@dataclass(frozen=True)
class CompatBreak:
    topic: str
    from_version: str
    to_version: str
    rule: str  # short rule id, e.g. "required-added"
    pointer: str  # JSON Pointer to the offending field, e.g. "/properties/severity/enum"
    detail: str

    def render(self) -> str:
        return f"[{self.topic}] {self.from_version} -> {self.to_version}  {self.rule}  {self.pointer}\n  {self.detail}"


# ---------- Loading ----------

def _parse_version(v: Any) -> Tuple[int, int, int]:
    if not isinstance(v, str):
        raise ValueError(f"version must be a string, got {type(v).__name__}: {v!r}")
    parts = v.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f"version must be 'MAJOR.MINOR.PATCH', got {v!r}")
    a, b, c = (int(p) for p in parts)
    return (a, b, c)


def load_schemas(registry_dir: Path) -> List[SchemaFile]:
    """Read every ``*.json`` file in the directory, validate it as draft 2020-12,
    and return them sorted by (title, version)."""
    out: List[SchemaFile] = []
    for path in sorted(registry_dir.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        # Both wrappers (registry meta) and pure schemas carry `title` + `version`
        # at the top level for our purposes; both are JSON Schema documents we
        # can sanity-check with the meta-schema.
        Draft202012Validator.check_schema(raw)
        title = raw.get("title")
        if not isinstance(title, str):
            raise ValueError(f"{path.name}: missing string `title`")
        version = _parse_version(raw.get("version"))
        out.append(SchemaFile(path=path, title=title, version=version, raw=raw))
    out.sort(key=lambda s: (s.title, s.version))
    return out


def group_versions(schemas: Iterable[SchemaFile]) -> Dict[str, List[SchemaFile]]:
    g: Dict[str, List[SchemaFile]] = {}
    for s in schemas:
        g.setdefault(s.title, []).append(s)
    for vs in g.values():
        vs.sort(key=lambda s: s.version)
    return g


# ---------- Compatibility rules ----------

def _normalise_type(t: Any) -> Tuple[str, ...]:
    """Return type set as a sorted tuple. ``"string"`` -> ``("string",)``;
    ``["string", "null"]`` -> ``("null", "string")``."""
    if t is None:
        return ()
    if isinstance(t, str):
        return (t,)
    if isinstance(t, list):
        return tuple(sorted({str(x) for x in t}))
    return ()


def _is_type_narrowed(old_type: Any, new_type: Any) -> bool:
    a = _normalise_type(old_type)
    b = _normalise_type(new_type)
    if not a or not b:
        # Either side unconstrained; treat as compatible.
        return False
    return not set(a).issubset(set(b))


def _enum_set(node: Any) -> Optional[set]:
    if not isinstance(node, dict):
        return None
    if "enum" not in node:
        return None
    return {_freeze(v) for v in node["enum"]}


def _freeze(v: Any) -> Any:
    if isinstance(v, dict):
        return tuple(sorted((k, _freeze(val)) for k, val in v.items()))
    if isinstance(v, list):
        return tuple(_freeze(x) for x in v)
    return v


def _required_set(node: Any) -> set:
    if not isinstance(node, dict):
        return set()
    req = node.get("required") or []
    return set(req) if isinstance(req, list) else set()


def _props(node: Any) -> Dict[str, Any]:
    if not isinstance(node, dict):
        return {}
    p = node.get("properties") or {}
    return p if isinstance(p, dict) else {}


def _additional_properties(node: Any) -> Optional[bool]:
    """Returns True/False if the keyword is set, None if absent.
    ``additionalProperties`` may also be a sub-schema; we treat that as "permissive"
    (i.e. not strictly closed) — same outcome as ``True`` for the closed-vs-open check."""
    if not isinstance(node, dict):
        return None
    if "additionalProperties" not in node:
        return None
    val = node["additionalProperties"]
    if isinstance(val, bool):
        return val
    return True


def _check_node(
    old: Any,
    new: Any,
    pointer: str,
    breaks: List[CompatBreak],
    topic: str,
    from_v: str,
    to_v: str,
) -> None:
    """Recursive comparison of two schema nodes."""
    # required additions / removals (only meaningful at object level)
    old_req = _required_set(old)
    new_req = _required_set(new)
    old_props = _props(old)
    new_props = _props(new)

    added_required = new_req - old_req
    if added_required:
        for f in sorted(added_required):
            breaks.append(
                CompatBreak(
                    topic=topic,
                    from_version=from_v,
                    to_version=to_v,
                    rule="required-added",
                    pointer=f"{pointer}/required",
                    detail=f"field `{f}` is newly required; v{from_v} payloads will not carry it",
                )
            )

    removed_required = old_req - new_req
    for f in sorted(removed_required):
        # If the field still exists as a property (just optional now) it's
        # backward-compatible. If it's gone entirely it's a break — but we'll
        # detect that under property-removed rather than here.
        if f in old_props and f not in new_props:
            # caught below
            continue
        # Demoting required → optional is fine for BACKWARD: existing payloads
        # still validate.

    # Property-level checks
    for name, old_sub in old_props.items():
        if name not in new_props:
            # Property removed entirely.
            breaks.append(
                CompatBreak(
                    topic=topic,
                    from_version=from_v,
                    to_version=to_v,
                    rule="property-removed",
                    pointer=f"{pointer}/properties/{name}",
                    detail=f"property `{name}` was removed",
                )
            )
            continue
        new_sub = new_props[name]

        # Type narrowing
        if _is_type_narrowed(old_sub.get("type") if isinstance(old_sub, dict) else None,
                              new_sub.get("type") if isinstance(new_sub, dict) else None):
            breaks.append(
                CompatBreak(
                    topic=topic,
                    from_version=from_v,
                    to_version=to_v,
                    rule="type-narrowed",
                    pointer=f"{pointer}/properties/{name}/type",
                    detail=(
                        f"type narrowed from {old_sub.get('type')!r} to {new_sub.get('type')!r}"
                    ),
                )
            )

        # Enum removals
        old_enum = _enum_set(old_sub)
        new_enum = _enum_set(new_sub)
        if old_enum is not None and new_enum is not None:
            removed = old_enum - new_enum
            if removed:
                breaks.append(
                    CompatBreak(
                        topic=topic,
                        from_version=from_v,
                        to_version=to_v,
                        rule="enum-removed",
                        pointer=f"{pointer}/properties/{name}/enum",
                        detail=(
                            f"enum value(s) removed: "
                            f"{sorted(repr(v) for v in removed)}"
                        ),
                    )
                )

        # Recurse into nested objects + array items
        if isinstance(old_sub, dict) and isinstance(new_sub, dict):
            if old_sub.get("type") == "object" or "properties" in old_sub:
                _check_node(
                    old_sub, new_sub,
                    pointer=f"{pointer}/properties/{name}",
                    breaks=breaks, topic=topic, from_v=from_v, to_v=to_v,
                )
            old_items = old_sub.get("items") if isinstance(old_sub.get("items"), dict) else None
            new_items = new_sub.get("items") if isinstance(new_sub.get("items"), dict) else None
            if old_items is not None and new_items is not None:
                _check_node(
                    old_items, new_items,
                    pointer=f"{pointer}/properties/{name}/items",
                    breaks=breaks, topic=topic, from_v=from_v, to_v=to_v,
                )

    # additionalProperties: open -> closed is a break
    old_ap = _additional_properties(old)
    new_ap = _additional_properties(new)
    if old_ap in (None, True) and new_ap is False:
        breaks.append(
            CompatBreak(
                topic=topic,
                from_version=from_v,
                to_version=to_v,
                rule="additional-properties-closed",
                pointer=f"{pointer}/additionalProperties",
                detail=(
                    "additionalProperties tightened from open/unspecified to false; "
                    "v{old} payloads with extra keys will fail v{new}"
                    .format(old=from_v, new=to_v)
                ),
            )
        )


def check_pair(old: SchemaFile, new: SchemaFile) -> List[CompatBreak]:
    breaks: List[CompatBreak] = []
    _check_node(
        old.raw, new.raw,
        pointer="",
        breaks=breaks,
        topic=old.title,
        from_v=old.version_str,
        to_v=new.version_str,
    )
    return breaks


# ---------- Public entry ----------

def check_registry(registry_dir: Path) -> List[CompatBreak]:
    schemas = load_schemas(registry_dir)
    grouped = group_versions(schemas)
    all_breaks: List[CompatBreak] = []
    for _topic, vs in grouped.items():
        for old, new in zip(vs, vs[1:]):
            all_breaks.extend(check_pair(old, new))
    return all_breaks


def main(argv: List[str]) -> int:
    here = Path(__file__).resolve().parent
    registry = (here / "..").resolve() if argv[1:2] == [] else Path(argv[1])
    breaks = check_registry(registry)
    if not breaks:
        schemas = load_schemas(registry)
        grouped = group_versions(schemas)
        topics = len(grouped)
        pairs = sum(max(0, len(vs) - 1) for vs in grouped.values())
        print(
            f"BACKWARD-compat OK — {len(schemas)} schema(s) across {topics} topic(s); "
            f"{pairs} version-pair(s) checked."
        )
        return 0
    print(f"BACKWARD-compat FAIL — {len(breaks)} break(s):", file=sys.stderr)
    for b in breaks:
        print("  " + b.render(), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
