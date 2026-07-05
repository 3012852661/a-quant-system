from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any

from backend.research.models import Evidence, EvidenceType


def evidence_from_committee(payload: dict[str, Any]) -> list[Evidence]:
    collected_at = payload.get("generatedAt") or datetime.now().isoformat(timespec="seconds")
    rows: list[Evidence] = []
    for decision in payload.get("decisions", []):
        code = str(decision.get("code") or "").zfill(6)
        name = str(decision.get("name") or code)
        for role, report in (decision.get("role_reports") or {}).items():
            evidence_items = report.get("evidence") or []
            risk_items = report.get("risks") or []
            gap_items = report.get("data_gaps") or []
            summary_parts = [str(report.get("summary") or "")]
            if evidence_items:
                summary_parts.append("证据：" + "；".join(str(item) for item in evidence_items[:3]))
            if risk_items:
                summary_parts.append("风险：" + "；".join(str(item) for item in risk_items[:2]))
            if gap_items:
                summary_parts.append("缺口：" + "；".join(str(item) for item in gap_items[:2]))
            rows.append(
                Evidence(
                    id=_evidence_id(code, role, collected_at),
                    type=_role_type(role),
                    title=f"{code} {name} - {role}",
                    summary=" ".join(item for item in summary_parts if item),
                    source="six-role investment committee",
                    symbols=[code],
                    collected_at=collected_at,
                    confidence=_confidence(report.get("score")),
                    metadata={
                        "role": role,
                        "stance": report.get("stance"),
                        "score": report.get("score"),
                        "decision": decision.get("decision"),
                    },
                )
            )
    return rows


def _evidence_id(*parts: object) -> str:
    raw = "|".join(str(part) for part in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _role_type(role: str) -> EvidenceType:
    normalized = role.lower()
    if "technical" in normalized:
        return "technical"
    if "fundamental" in normalized:
        return "fundamental"
    if "sentiment" in normalized:
        return "sentiment"
    if "risk" in normalized:
        return "risk"
    if "research" in normalized:
        return "market"
    return "committee"


def _confidence(score: object) -> float:
    try:
        value = float(score)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, value / 100))

