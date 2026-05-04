"""Registry CLI.

Usage::

    python -m ml.registry.cli list [--name pd_xgboost]
    python -m ml.registry.cli get-champion --name pd_xgboost
    python -m ml.registry.cli register --name pd_xgboost --version 0.1.0 \
        --artifact ml/models/pd/v0.1.0 --metric auc_holdout=0.85 --status challenger
    python -m ml.registry.cli promote --name pd_xgboost --version 0.1.0
    python -m ml.registry.cli archive --name pd_xgboost --version 0.0.1
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from ml.registry.registry import Registry  # noqa: E402


def _parse_metrics(items):
    out = {}
    for it in items or []:
        if "=" not in it:
            raise SystemExit(f"--metric expects key=value, got {it!r}")
        k, v = it.split("=", 1)
        try:
            out[k] = float(v)
        except ValueError:
            raise SystemExit(f"Metric {k!r} value must be numeric, got {v!r}")
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--registry-path",
        default=None,
        help="Override path to registry.json (default ml/registry/registry.json)",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="List registry entries")
    p_list.add_argument("--name", default=None)

    p_get = sub.add_parser("get-champion", help="Print current champion for a model name")
    p_get.add_argument("--name", required=True)

    p_reg = sub.add_parser("register", help="Register a new model version")
    p_reg.add_argument("--name", required=True)
    p_reg.add_argument("--version", required=True)
    p_reg.add_argument("--artifact", required=True)
    p_reg.add_argument("--metric", action="append", help="key=value metric (repeatable)")
    p_reg.add_argument("--status", default="challenger", choices=["champion", "challenger", "archived"])
    p_reg.add_argument("--overwrite", action="store_true")

    p_prom = sub.add_parser("promote", help="Promote a version to champion")
    p_prom.add_argument("--name", required=True)
    p_prom.add_argument("--version", required=True)

    p_arc = sub.add_parser("archive", help="Archive a version")
    p_arc.add_argument("--name", required=True)
    p_arc.add_argument("--version", required=True)

    args = parser.parse_args()
    reg = Registry(args.registry_path)

    if args.cmd == "list":
        print(json.dumps(reg.list(args.name), indent=2))
    elif args.cmd == "get-champion":
        champ = reg.get_champion(args.name)
        if champ is None:
            raise SystemExit(f"No champion registered for {args.name!r}")
        print(json.dumps(champ, indent=2))
    elif args.cmd == "register":
        entry = reg.register(
            name=args.name,
            version=args.version,
            metrics=_parse_metrics(args.metric),
            artifact_path=args.artifact,
            status=args.status,
            overwrite=args.overwrite,
        )
        print(json.dumps(entry, indent=2))
    elif args.cmd == "promote":
        entry = reg.promote(name=args.name, version=args.version)
        print(json.dumps(entry, indent=2))
    elif args.cmd == "archive":
        entry = reg.archive(name=args.name, version=args.version)
        print(json.dumps(entry, indent=2))


if __name__ == "__main__":
    main()
