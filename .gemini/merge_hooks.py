#!/usr/bin/env python3
"""Merge tracked Antigravity hooks into ~/.gemini/config/hooks.json without clobbering external hooks."""

from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any


def expand_home_commands(obj: Any, home_dir: str) -> Any:
    """Recursively expand leading ~/ in hook handler 'command' strings."""
    if isinstance(obj, list):
        return [expand_home_commands(item, home_dir) for item in obj]
    if isinstance(obj, dict):
        prefix = f"{home_dir.rstrip('/')}/"
        out: dict[str, Any] = {}
        for key, value in obj.items():
            if key == "command" and isinstance(value, str) and value.startswith("~/"):
                out[key] = f"{prefix}{value[2:]}"
            else:
                out[key] = expand_home_commands(value, home_dir)
        return out
    return obj


def _read_json_dict(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise TypeError(f"Expected JSON object in {path}")
    return data


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.replace(tmp_name, path)
    except Exception:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise


def merge_hooks_file(
    src_path: str | Path,
    dst_path: str | Path,
    home_dir: str | None = None,
) -> dict[str, Any]:
    """Merge tracked hook definitions from src_path into dst_path, preserving external entries."""
    home = home_dir or os.path.expanduser("~")
    src = _read_json_dict(Path(src_path))
    existing = _read_json_dict(Path(dst_path))
    merged = copy.deepcopy(existing)

    for name, spec in src.items():
        expanded = expand_home_commands(spec, home)
        prev = existing.get(name)
        if (
            isinstance(prev, dict)
            and prev.get("enabled") is False
            and isinstance(expanded, dict)
        ):
            expanded["enabled"] = False
        merged[name] = expanded

    _write_json_atomic(Path(dst_path), merged)
    return merged


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in (2, 3):
        print(
            "Usage: merge_hooks.py <src_hooks.json> <dst_hooks.json> [home_dir]",
            file=sys.stderr,
        )
        return 2
    home_dir = args[2] if len(args) == 3 else os.path.expanduser("~")
    merge_hooks_file(args[0], args[1], home_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
