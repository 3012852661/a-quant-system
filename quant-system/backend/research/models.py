from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Literal


EvidenceType = Literal[
    "market",
    "technical",
    "fundamental",
    "sentiment",
    "risk",
    "knowledge",
    "committee",
    "announcement",
    "report",
    "news",
    "policy",
    "financial",
    "moneyflow",
]


@dataclass
class Evidence:
    id: str
    type: EvidenceType
    title: str
    summary: str
    source: str
    symbols: list[str] = field(default_factory=list)
    source_url: str | None = None
    published_at: str | None = None
    collected_at: str | None = None
    confidence: float = 0.5
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ResearchReport:
    generated_at: str
    method: str
    scope: dict[str, Any]
    summary: str
    decisions: list[dict[str, Any]]
    evidence: list[Evidence]
    data_gaps: list[str]
    risk_flags: list[str]
    sources: dict[str, Any]

    @classmethod
    def from_committee(
        cls,
        committee_payload: dict[str, Any],
        evidence: list[Evidence],
        codes: list[str] | None = None,
        source_data_gaps: list[str] | None = None,
        source_metadata: dict[str, Any] | None = None,
    ) -> "ResearchReport":
        decisions = committee_payload.get("decisions", [])
        risk_flags: list[str] = []
        data_gaps: list[str] = []
        for item in decisions:
            risk_flags.extend(str(veto) for veto in item.get("vetoes", []) if veto)
            for report in (item.get("role_reports") or {}).values():
                data_gaps.extend(str(gap) for gap in report.get("data_gaps", []) if gap)

        accepted = [item for item in decisions if item.get("decision") not in ("REJECT", "WATCH_ONLY")]
        rejected = [item for item in decisions if item.get("decision") == "REJECT"]
        summary = (
            f"研究范围覆盖 {len(decisions)} 个标的，"
            f"{len(accepted)} 个进入观察/轻仓候选，{len(rejected)} 个被风险否决。"
        )
        data_gaps.extend(source_data_gaps or [])
        sources = dict(committee_payload.get("source", {}))
        if source_metadata:
            sources["researchEvidenceSources"] = source_metadata
        return cls(
            generated_at=committee_payload.get("generatedAt") or datetime.now().isoformat(timespec="seconds"),
            method="Research layer wrapper over six-role committee + source evidence adapters",
            scope={"codes": codes or [item.get("code") for item in decisions if item.get("code")]},
            summary=summary,
            decisions=decisions,
            evidence=evidence,
            data_gaps=sorted(set(data_gaps)),
            risk_flags=sorted(set(risk_flags)),
            sources=sources,
        )

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["generatedAt"] = payload.pop("generated_at")
        payload["dataGaps"] = payload.pop("data_gaps")
        payload["riskFlags"] = payload.pop("risk_flags")
        payload["evidence"] = [item.to_dict() if isinstance(item, Evidence) else item for item in self.evidence]
        return payload
