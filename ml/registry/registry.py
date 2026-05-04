"""JSON-backed model registry.

A single ``registry.json`` keeps the source of truth, with semantics:

* Each entry: ``{name, version, status, metrics, created_at, artifact_path}``.
* ``status`` is one of ``champion`` | ``challenger`` | ``archived``.
* At most **one** champion per ``name`` at any time. Promoting a new champion
  archives the previous one.
* All writes are atomic (write-then-rename) to survive crashes.

Designed for prototype use. In production we would back this with DynamoDB or
a Glue Data Catalog table; the API surface here matches that future swap.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


VALID_STATUSES = {"champion", "challenger", "archived"}
DEFAULT_REGISTRY_PATH = Path("ml/registry/registry.json")


@dataclass
class RegistryEntry:
    name: str
    version: str
    status: str
    metrics: Dict[str, float]
    artifact_path: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return asdict(self)


class Registry:
    """Thread-safe JSON-backed registry."""

    def __init__(self, path: Optional[os.PathLike] = None) -> None:
        self.path = Path(path) if path else DEFAULT_REGISTRY_PATH
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write([])

    # ------------------------------------------------------------------
    # Internal IO
    # ------------------------------------------------------------------
    def _read(self) -> List[dict]:
        if not self.path.exists():
            return []
        with open(self.path, "r") as fh:
            data = json.load(fh)
        if not isinstance(data, list):
            raise RuntimeError(f"Registry file {self.path} is malformed (expected a list).")
        return data

    def _write(self, items: List[dict]) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        with open(tmp, "w") as fh:
            json.dump(items, fh, indent=2, sort_keys=False)
        os.replace(tmp, self.path)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def list(self, name: Optional[str] = None) -> List[dict]:
        items = self._read()
        if name:
            items = [it for it in items if it["name"] == name]
        return items

    def get(self, name: str, version: str) -> Optional[dict]:
        for it in self._read():
            if it["name"] == name and it["version"] == version:
                return it
        return None

    def get_champion(self, name: str) -> Optional[dict]:
        for it in self._read():
            if it["name"] == name and it["status"] == "champion":
                return it
        return None

    def get_challenger(self, name: str) -> Optional[dict]:
        for it in self._read():
            if it["name"] == name and it["status"] == "challenger":
                return it
        return None

    def register(
        self,
        name: str,
        version: str,
        metrics: Dict[str, float],
        artifact_path: str,
        status: str = "challenger",
        overwrite: bool = False,
    ) -> dict:
        if status not in VALID_STATUSES:
            raise ValueError(f"Invalid status {status!r}; expected one of {sorted(VALID_STATUSES)}")

        with self._lock:
            items = self._read()
            existing = next(
                (i for i, it in enumerate(items) if it["name"] == name and it["version"] == version),
                None,
            )

            entry = RegistryEntry(
                name=name,
                version=version,
                status=status,
                metrics=metrics,
                artifact_path=artifact_path,
            ).to_dict()

            # Enforce single-champion invariant if registering directly as champion.
            if status == "champion":
                for it in items:
                    if it["name"] == name and it["status"] == "champion":
                        it["status"] = "archived"

            if existing is not None:
                if not overwrite:
                    raise ValueError(
                        f"Entry already exists for {name} v{version}. Pass overwrite=True to replace."
                    )
                # Preserve original created_at so the audit trail is honest.
                entry["created_at"] = items[existing].get("created_at", entry["created_at"])
                items[existing] = entry
            else:
                items.append(entry)

            self._write(items)
            return entry

    def promote(self, name: str, version: str) -> dict:
        """Mark (name, version) as champion; archive previous champion."""
        with self._lock:
            items = self._read()
            target_idx = next(
                (i for i, it in enumerate(items) if it["name"] == name and it["version"] == version),
                None,
            )
            if target_idx is None:
                raise KeyError(f"No registry entry found for {name} v{version}")

            for it in items:
                if it["name"] == name and it["status"] == "champion":
                    it["status"] = "archived"

            items[target_idx]["status"] = "champion"
            self._write(items)
            return items[target_idx]

    def archive(self, name: str, version: str) -> dict:
        with self._lock:
            items = self._read()
            for it in items:
                if it["name"] == name and it["version"] == version:
                    it["status"] = "archived"
                    self._write(items)
                    return it
            raise KeyError(f"No registry entry found for {name} v{version}")
