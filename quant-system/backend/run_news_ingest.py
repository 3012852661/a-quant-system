from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.committee.roles import repo_root


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest a manual news item into knowledge/News-KB.")
    parser.add_argument("--title", required=True, help="News title.")
    parser.add_argument("--source", required=True, help="Publisher or source name.")
    parser.add_argument("--published-at", default=date.today().isoformat(), help="Publication date, YYYY-MM-DD.")
    parser.add_argument("--url", default="", help="Original news URL.")
    parser.add_argument("--symbols", default="", help="Comma-separated stock codes mentioned by the news.")
    parser.add_argument("--summary", required=True, help="Factual summary.")
    parser.add_argument("--impact", default="", help="Potential market or industry impact.")
    parser.add_argument("--risk", default="", help="Risk notes or uncertainty.")
    args = parser.parse_args()

    output_dir = repo_root() / "knowledge/News-KB"
    output_dir.mkdir(parents=True, exist_ok=True)
    slug = _slug(args.title)
    path = output_dir / f"{args.published_at}-{slug}.md"
    symbols = [item.strip().zfill(6) for item in args.symbols.split(",") if item.strip()]
    path.write_text(
        _render_news(
            title=args.title,
            source=args.source,
            published_at=args.published_at,
            url=args.url,
            symbols=symbols,
            summary=args.summary,
            impact=args.impact,
            risk=args.risk,
        ),
        encoding="utf-8",
    )
    print(f"news kb: {path}")
    return 0


def _render_news(
    *,
    title: str,
    source: str,
    published_at: str,
    url: str,
    symbols: list[str],
    summary: str,
    impact: str,
    risk: str,
) -> str:
    symbol_text = ", ".join(symbols) if symbols else "无"
    lines = [
        f"# {title}",
        "",
        "status: L1 note",
        "market: A 股",
        f"source: {source}",
        f"published_at: {published_at}",
        f"url: {url or '无'}",
        f"symbols: {symbol_text}",
        "",
        "## 摘要",
        "",
        f"- {summary}",
        "",
        "## 影响路径",
        "",
        f"- {impact or '待分析'}",
        "",
        "## 风险和不确定性",
        "",
        f"- {risk or '待补充'}",
        "",
        "## Agent 使用",
        "",
        "- 新闻 Evidence 只作为研究层证据，不允许单独触发自动买入。",
    ]
    return "\n".join(lines) + "\n"


def _slug(title: str) -> str:
    value = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", title).strip("-")
    return value[:48] or "news"


if __name__ == "__main__":
    raise SystemExit(main())
