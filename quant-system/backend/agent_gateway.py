from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def append_agent_audit(action: str, payload: dict[str, Any], result: dict[str, Any]) -> None:
    path = repo_root() / "reports/data/agent-gateway-audit.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "action": action,
        "mode": "PAPER_ONLY",
        "payload": payload,
        "result": {
            "status": result.get("status"),
            "ok": result.get("ok"),
            "reasonCount": len(result.get("reasons", []) or []),
        },
    }
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False) + "\n")


def agent_capabilities() -> dict[str, Any]:
    return {
        "name": "QuantOS Agent Gateway",
        "mode": "PAPER_ONLY",
        "upstreamPattern": {
            "researchLayer": "TradingAgents-CN style multi-agent research reports",
            "executionLayer": "QuantDinger style strategy registry, paper-first gateway, audit log",
        },
        "read": [
            "/api/agent/v1/capabilities",
            "/api/agent/v1/research/latest",
            "/api/agent/v1/strategies",
            "/api/agent/v1/workbench",
            "/api/agent/v1/audit/latest",
        ],
        "write": [
            {
                "path": "/api/agent/v1/orders/preflight",
                "effect": "dry-run order risk check only",
                "forcesDryRun": True,
            }
        ],
        "blocked": [
            "live broker order submission",
            "automatic real-money execution",
            "strategy execution without L4 production-guarded knowledge and risk gates",
        ],
        "brokerAdapters": {
            "live": "disabled-live-broker",
            "paper": "backend.execution.paper",
        },
    }
