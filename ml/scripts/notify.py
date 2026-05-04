"""POST a notification to the BFF.

Used by the retrain DAG to surface "retrain completed" / "drift detected"
events into the SPA's bell. No external dependencies — `urllib` only —
so the Airflow worker doesn't need any extra Python packages.

Usage::

    python -m ml.scripts.notify --level warning --title "Retrain completed" \
        --body "AUC 0.881 (was 0.882) — slight regression"

Env::

    APEX_BFF_URL          — defaults to http://localhost:8084
    APEX_BFF_ROLE         — RBAC header value, defaults to "admin"
    APEX_BFF_AUTH_TOKEN   — optional Bearer token if BFF requires it
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def post_notification(
    *,
    level: str,
    title: str,
    body: str | None = None,
    href: str | None = None,
    bff_url: str | None = None,
    role: str | None = None,
    token: str | None = None,
    timeout_seconds: float = 10.0,
) -> dict:
    """POST to /v1/notifications/publish. Returns the parsed JSON response.

    Raises urllib.error.HTTPError on non-2xx so the caller (DAG task) can
    decide whether to fail the run or swallow the error.
    """
    base = (bff_url or os.environ.get("APEX_BFF_URL") or "http://localhost:8084").rstrip("/")
    role_hdr = role or os.environ.get("APEX_BFF_ROLE", "admin")
    auth = token or os.environ.get("APEX_BFF_AUTH_TOKEN")

    payload: dict = {"level": level, "title": title}
    if body:
        payload["body"] = body
    if href:
        payload["href"] = href

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/v1/notifications/publish",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-apex-role": role_hdr,
            **({"Authorization": f"Bearer {auth}"} if auth else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--level", choices=["info", "success", "warning", "danger"], required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--body", default=None)
    parser.add_argument("--href", default=None)
    parser.add_argument(
        "--allow-failure",
        action="store_true",
        help="Exit 0 even if the BFF is unreachable. Used by DAG steps that "
        "shouldn't fail the whole retrain just because the bell is offline.",
    )
    args = parser.parse_args()
    try:
        result = post_notification(level=args.level, title=args.title, body=args.body, href=args.href)
        print(json.dumps(result))
        return 0
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        print(f"[notify] failed: {exc}", file=sys.stderr)
        return 0 if args.allow_failure else 2


if __name__ == "__main__":
    sys.exit(main())
