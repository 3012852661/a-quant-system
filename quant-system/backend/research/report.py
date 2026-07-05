from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.research.evidence import evidence_from_committee
from backend.research.models import ResearchReport
from backend.research.sources import collect_research_source_evidence


def build_research_report(
    committee_payload: dict[str, Any],
    codes: list[str] | None = None,
    *,
    enable_live_sources: bool = False,
    source_page_size: int = 5,
) -> ResearchReport:
    committee_evidence = evidence_from_committee(committee_payload)
    source_collection = collect_research_source_evidence(
        committee_payload,
        codes,
        enable_live_sources=enable_live_sources,
        source_page_size=source_page_size,
    )
    return ResearchReport.from_committee(
        committee_payload,
        evidence=[*committee_evidence, *source_collection.evidence],
        codes=codes,
        source_data_gaps=source_collection.data_gaps,
        source_metadata=source_collection.metadata,
    )


def write_research_outputs(report: ResearchReport, output: Path, markdown: Path, evidence_dir: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    markdown.parent.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    for stale_path in evidence_dir.glob("*.json"):
        stale_path.unlink()
    payload = report.to_dict()
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown.write_text(render_markdown(payload), encoding="utf-8")
    for item in payload.get("evidence", []):
        evidence_path = evidence_dir / f"{item['id']}.json"
        evidence_path.write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")


def render_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# AI 研究层报告",
        "",
        f"- 生成时间：{payload.get('generatedAt')}",
        f"- 方法：{payload.get('method')}",
        f"- 摘要：{payload.get('summary')}",
        "",
        "## 研究结论",
        "",
    ]
    for item in payload.get("decisions", []):
        lines.extend(
            [
                f"### {item.get('code')} {item.get('name')} - {item.get('decision')}",
                "",
                f"- 置信度：{item.get('confidence')}",
                f"- 最大建议仓位：{item.get('max_position_pct')}%",
                f"- 否决项：{'；'.join(item.get('vetoes') or []) if item.get('vetoes') else '无'}",
                f"- 依据：{'；'.join(item.get('rationale') or [])}",
                "",
            ]
        )
    lines.extend(["## 数据缺口", ""])
    gaps = payload.get("dataGaps") or []
    lines.extend([f"- {item}" for item in gaps] or ["- 无"])
    lines.extend(["", "## 风险标记", ""])
    risks = payload.get("riskFlags") or []
    lines.extend([f"- {item}" for item in risks] or ["- 无"])
    lines.extend(["", "## 证据索引", ""])
    for item in payload.get("evidence", [])[:80]:
        lines.append(
            f"- {item.get('id')}：[{item.get('type')}] {item.get('title')}（{item.get('source')}）"
        )
    return "\n".join(lines)
