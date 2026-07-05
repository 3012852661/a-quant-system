from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def append_execution_audit(action: str, payload: dict[str, Any], result: dict[str, Any]) -> None:
    path = repo_root() / "reports/data/execution-audit.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "action": action,
        "mode": "PAPER",
        "payload": payload,
        "result": {
            "status": result.get("status"),
            "code": result.get("code"),
            "side": result.get("side"),
            "dryRun": result.get("dryRun"),
            "reasonCount": len(result.get("reasons", []) or []),
        },
    }
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False) + "\n")

