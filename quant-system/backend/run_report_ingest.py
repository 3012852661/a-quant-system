from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.committee.roles import repo_root


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest a broker/company research report into knowledge/Report-KB.")
    parser.add_argument("--title", required=True, help="Report title.")
    parser.add_argument("--institution", required=True, help="Institution or publisher.")
    parser.add_argument("--author", default="", help="Author or analyst.")
    parser.add_argument("--published-at", default=date.today().isoformat(), help="Publication date, YYYY-MM-DD.")
    parser.add_argument("--url", default="", help="Original report URL or local PDF path.")
    parser.add_argument("--symbols", default="", help="Comma-separated stock codes mentioned by the report.")
    parser.add_argument("--rating", default="", help="Report rating, e.g. 买入/增持/中性.")
    parser.add_argument("--target-price", default="", help="Target price or valuation range.")
    parser.add_argument("--summary", required=True, help="Core factual summary.")
    parser.add_argument("--assumptions", default="", help="Financial assumptions.")
    parser.add_argument("--catalysts", default="", help="Key catalysts.")
    parser.add_argument("--risk", required=True, help="Risk notes.")
    args = parser.parse_args()

    output_dir = repo_root() / "knowledge/Report-KB"
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{args.published_at}-{_slug(args.title)}.md"
    symbols = [item.strip().zfill(6) for item in args.symbols.split(",") if item.strip()]
    path.write_text(
        _render_report(
            title=args.title,
            institution=args.institution,
            author=args.author,
            published_at=args.published_at,
            url=args.url,
            symbols=symbols,
            rating=args.rating,
            target_price=args.target_price,
            summary=args.summary,
            assumptions=args.assumptions,
            catalysts=args.catalysts,
            risk=args.risk,
        ),
        encoding="utf-8",
    )
    print(f"report kb: {path}")
    return 0


def _render_report(
    *,
    title: str,
    institution: str,
    author: str,
    published_at: str,
    url: str,
    symbols: list[str],
    rating: str,
    target_price: str,
    summary: str,
    assumptions: str,
    catalysts: str,
    risk: str,
) -> str:
    symbol_text = ", ".join(symbols) if symbols else "无"
    return "\n".join(
        [
            f"# {title}",
            "",
            "status: L1 note",
            "market: A 股",
            f"source: {institution}",
            f"institution: {institution}",
            f"author: {author or '未标注'}",
            f"published_at: {published_at}",
            f"url: {url or '无'}",
            f"symbols: {symbol_text}",
            f"rating: {rating or '未标注'}",
            f"target_price: {target_price or '未标注'}",
            "",
            "## 核心观点",
            "",
            f"- {summary}",
            "",
            "## 财务假设",
            "",
            f"- {assumptions or '待补充'}",
            "",
            "## 催化因素",
            "",
            f"- {catalysts or '待补充'}",
            "",
            "## 风险提示",
            "",
            f"- {risk}",
            "",
            "## Agent 使用",
            "",
            "- 研报 Evidence 必须保留来源、日期和风险提示；过期研报只能作为历史观点。",
        ]
    ) + "\n"


def _slug(title: str) -> str:
    value = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", title).strip("-")
    return value[:48] or "report"


if __name__ == "__main__":
    raise SystemExit(main())
