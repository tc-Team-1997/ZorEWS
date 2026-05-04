"""Quarterly access review (T3.9).

Reads the canonical RBAC matrix and a user roster, validates each, and emits
a Markdown review report. Exit 1 on any inconsistency so CI can gate the
matrix file on every PR.

Usage::

    python infra/rbac/scripts/access_review.py \\
        --matrix infra/rbac/matrix.json \\
        --roster infra/rbac/scripts/sample_roster.json \\
        --report-out -                # write report to stdout

    # CI / matrix-only validation:
    python infra/rbac/scripts/access_review.py \\
        --matrix infra/rbac/matrix.json --validate-only
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional


# ---------- data ----------

@dataclass
class Matrix:
    version: str
    roles: List[str]
    operations: Dict[str, List[str]]
    role_descriptions: Dict[str, str]


@dataclass
class User:
    id: str
    username: str
    display_name: str
    role: str
    active: bool
    last_login: Optional[str]


# ---------- loaders ----------

def load_matrix(path: Path) -> Matrix:
    raw = json.loads(path.read_text(encoding="utf-8"))
    roles = raw.get("roles") or []
    if not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
        raise ValueError(f"{path}: `roles` must be a list of strings")
    ops = raw.get("operations") or {}
    if not isinstance(ops, dict):
        raise ValueError(f"{path}: `operations` must be an object")
    role_set = set(roles)
    for op, allowed in ops.items():
        if not isinstance(allowed, list):
            raise ValueError(f"{path}: operation `{op}` must list allowed roles")
        unknown = [r for r in allowed if r not in role_set]
        if unknown:
            raise ValueError(
                f"{path}: operation `{op}` references unknown role(s) {unknown}"
            )
    return Matrix(
        version=str(raw.get("version", "")),
        roles=list(roles),
        operations={k: list(v) for k, v in ops.items()},
        role_descriptions=dict(raw.get("role_descriptions") or {}),
    )


def load_roster(path: Path) -> List[User]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    users_raw = raw.get("users") or []
    if not isinstance(users_raw, list):
        raise ValueError(f"{path}: `users` must be a list")
    out: List[User] = []
    for u in users_raw:
        out.append(
            User(
                id=str(u["id"]),
                username=str(u["username"]),
                display_name=str(u.get("display_name", "")),
                role=str(u["role"]),
                active=bool(u.get("active", True)),
                last_login=u.get("last_login"),
            )
        )
    return out


# ---------- validation ----------

@dataclass
class RosterError:
    user_id: str
    rule: str
    detail: str

    def render(self) -> str:
        return f"  - [{self.user_id}] {self.rule}: {self.detail}"


def validate_roster(matrix: Matrix, roster: List[User]) -> List[RosterError]:
    errors: List[RosterError] = []
    seen_ids: Dict[str, str] = {}
    seen_usernames: Dict[str, str] = {}
    for u in roster:
        if u.role not in matrix.roles:
            errors.append(
                RosterError(u.id, "unknown-role", f"role `{u.role}` not in matrix")
            )
        if u.id in seen_ids:
            errors.append(
                RosterError(u.id, "duplicate-id", f"id collides with `{seen_ids[u.id]}`")
            )
        seen_ids[u.id] = u.username
        if u.username in seen_usernames:
            errors.append(
                RosterError(
                    u.id,
                    "duplicate-username",
                    f"username `{u.username}` already used by `{seen_usernames[u.username]}`",
                )
            )
        seen_usernames[u.username] = u.id
    return errors


# ---------- report ----------

def _ops_for_role(matrix: Matrix, role: str) -> List[str]:
    return [op for op, allowed in matrix.operations.items() if role in allowed]


def _is_dormant(last_login: Optional[str], now: datetime, threshold_days: int = 90) -> bool:
    if not last_login:
        return True
    try:
        ts = datetime.fromisoformat(last_login.replace("Z", "+00:00"))
    except ValueError:
        return True
    return (now - ts) > timedelta(days=threshold_days)


def render_report(
    matrix: Matrix,
    roster: List[User],
    *,
    now: Optional[datetime] = None,
) -> str:
    now = now or datetime.now(tz=timezone.utc)
    lines: List[str] = []
    lines.append(f"# APEX EWS — quarterly access review")
    lines.append("")
    lines.append(f"- Generated: `{now.isoformat()}`")
    lines.append(f"- Matrix version: `{matrix.version}`")
    lines.append(f"- Users in roster: **{len(roster)}**")
    lines.append("")

    # Per-role counts.
    counts: Dict[str, int] = {r: 0 for r in matrix.roles}
    for u in roster:
        if u.role in counts:
            counts[u.role] += 1
    lines.append("## Role distribution")
    lines.append("")
    lines.append("| Role | Active users | Operations granted |")
    lines.append("|------|-------------:|-------------------:|")
    for role in matrix.roles:
        lines.append(f"| `{role}` | {counts[role]} | {len(_ops_for_role(matrix, role))} |")
    lines.append("")

    # Dormant users.
    dormant = [u for u in roster if u.active and _is_dormant(u.last_login, now)]
    lines.append("## Dormant accounts (last login > 90 days, or never)")
    lines.append("")
    if not dormant:
        lines.append("_None — every active user logged in within 90 days._")
    else:
        lines.append("| User | Role | Last login |")
        lines.append("|------|------|------------|")
        for u in dormant:
            lines.append(f"| `{u.username}` ({u.display_name}) | `{u.role}` | {u.last_login or 'never'} |")
    lines.append("")

    # User-by-user table.
    lines.append("## Users")
    lines.append("")
    lines.append("| User | Role | Active | Last login | Operations |")
    lines.append("|------|------|:------:|------------|-----------:|")
    for u in sorted(roster, key=lambda x: (x.role, x.username)):
        ops_count = len(_ops_for_role(matrix, u.role)) if u.role in matrix.roles else 0
        lines.append(
            f"| `{u.username}` ({u.display_name}) | `{u.role}` | "
            f"{'✓' if u.active else '✗'} | {u.last_login or '—'} | {ops_count} |"
        )
    lines.append("")
    lines.append(
        "## Sign-off\n\n"
        "- [ ] HR rep — roster matches active-employee list\n"
        "- [ ] Risk-Ops manager — no role drift in matrix\n"
        "- [ ] CISO — review approved\n"
    )
    return "\n".join(lines)


# ---------- CLI ----------

def main(argv: List[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--matrix", required=True, type=Path)
    p.add_argument("--roster", type=Path)
    p.add_argument("--report-out", default=None, help="path or `-` for stdout")
    p.add_argument(
        "--validate-only",
        action="store_true",
        help="Only validate the matrix (and roster if given); do not render a report.",
    )
    args = p.parse_args(argv[1:])

    try:
        matrix = load_matrix(args.matrix)
    except (ValueError, FileNotFoundError, json.JSONDecodeError) as e:
        print(f"matrix invalid: {e}", file=sys.stderr)
        return 1

    if args.roster:
        try:
            roster = load_roster(args.roster)
        except (ValueError, FileNotFoundError, json.JSONDecodeError) as e:
            print(f"roster invalid: {e}", file=sys.stderr)
            return 1
        errors = validate_roster(matrix, roster)
        if errors:
            print("Roster validation failed:", file=sys.stderr)
            for e in errors:
                print(e.render(), file=sys.stderr)
            return 1
        if not args.validate_only:
            report = render_report(matrix, roster)
            if args.report_out in (None, "-"):
                print(report)
            else:
                Path(args.report_out).write_text(report, encoding="utf-8")
                print(f"wrote {args.report_out}")
    else:
        if not args.validate_only:
            print("--roster is required unless --validate-only is set", file=sys.stderr)
            return 2

    op_count = len(matrix.operations)
    role_count = len(matrix.roles)
    print(
        f"matrix OK — {role_count} role(s), {op_count} operation(s).",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
