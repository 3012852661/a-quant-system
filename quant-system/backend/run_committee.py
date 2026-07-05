from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.committee.roles import repo_root, run_committee


ROLE_ORDER = [
    "Researcher",
    "Fundamental Analyst",
    "Technical Analyst",
    "Sentiment Analyst",
    "Risk Officer",
]


def render_markdown(payload: dict[str, Any]) -> str:
    lines = [
        "# AI 投资委员会复核",
        "",
        f"- 生成时间：{payload.get('generatedAt')}",
        f"- 方法：{payload.get('method')}",
        f"- 知识库：{payload.get('source', {}).get('knowledge', 'quant-system/knowledge')}",
        "",
        "## 投资经理结论",
        "",
    ]
    for item in payload.get("decisions", []):
        lines.extend(
            [
                f"### {item['code']} {item['name']} - {item['decision']}",
                "",
                f"- 置信度：{item['confidence']}",
                f"- 最大建议仓位：{item['max_position_pct']}%",
                f"- 否决项：{'；'.join(item['vetoes']) if item['vetoes'] else '无'}",
                f"- 依据：{'；'.join(item['rationale'])}",
                "",
                "#### 角色报告",
                "",
            ]
        )
        role_reports = item.get("role_reports", {})
        for role in ROLE_ORDER:
            report = role_reports.get(role, {})
            lines.extend(
                [
                    f"- **{role}**：{report.get('stance')} / {report.get('score')}",
                    f"  - 摘要：{report.get('summary')}",
                ]
            )
            evidence = report.get("evidence") or []
            risks = report.get("risks") or []
            gaps = report.get("data_gaps") or []
            if evidence:
                lines.append(f"  - 证据：{'；'.join(evidence[:4])}")
            if risks:
                lines.append(f"  - 风险：{'；'.join(risks[:4])}")
            if gaps:
                lines.append(f"  - 数据缺口：{'；'.join(gaps[:3])}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run six-role investment committee review.")
    parser.add_argument("--codes", default="", help="Comma-separated stock codes. Defaults to latest pool.")
    parser.add_argument("--output", default=str(repo_root() / "reports/data/latest-investment-committee.json"))
    parser.add_argument("--markdown", default=str(repo_root() / "reports/data/latest-investment-committee.md"))
    args = parser.parse_args()

    codes = [item.strip().zfill(6) for item in args.codes.split(",") if item.strip()] or None
    payload = run_committee(codes)
    output = Path(args.output)
    markdown = Path(args.markdown)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown.write_text(render_markdown(payload), encoding="utf-8")
    print(f"committee decisions: {len(payload.get('decisions', []))}")
    for item in payload.get("decisions", [])[:10]:
        print(
            f"{item['code']} {item['name']} decision={item['decision']} "
            f"confidence={item['confidence']} max_position={item['max_position_pct']}%"
        )
    print(f"json: {output}")
    print(f"markdown: {markdown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
