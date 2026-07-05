from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.committee.roles import repo_root
from backend.strategy.registry import build_strategy_registry


def render_markdown(payload: dict[str, Any]) -> str:
    summary = payload.get("summary", {})
    lines = [
        "# 策略准入复盘",
        "",
        f"- 生成时间：{payload.get('generatedAt')}",
        f"- 策略总数：{summary.get('total', 0)}",
        f"- Paper 可跑：{summary.get('paperAllowed', 0)}",
        f"- Paper 阻塞：{summary.get('paperBlocked', 0)}",
        f"- 生产可交易：{summary.get('productionReady', 0)}",
        f"- 质量阻塞：{summary.get('qualityBlocked', 0)}",
        f"- 平均质量分：{summary.get('averageQualityScore', '-')}",
        "",
        "## 策略闸门",
        "",
    ]
    for row in payload.get("rows", []):
        quality = row.get("quality") or {}
        promotion = row.get("promotion") or {}
        lines.extend(
            [
                f"### {row.get('name')} - {row.get('execution_gate')}",
                "",
                f"- key：`{row.get('key')}`",
                f"- stage：{row.get('stage')}",
                f"- source：{row.get('source')}",
                f"- 质量：{quality.get('status', '-')} / {quality.get('score', '-')} 分",
                f"- 晋级目标：{promotion.get('target', '-')}",
                f"- backtest：{_backtest_summary(row.get('backtest') or {})}",
                f"- 阻塞原因：{'；'.join((quality.get('blockers') or row.get('gate_reasons') or [])[:6]) or '无'}",
                f"- 观察警告：{'；'.join((quality.get('warnings') or [])[:4]) or '无'}",
                f"- 下一步：{'；'.join(row.get('next_actions') or []) or '继续观察'}",
                "",
            ]
        )
    return "\n".join(lines)


def _backtest_summary(backtest: dict[str, Any]) -> str:
    if not backtest:
        return "无"
    return (
        f"样本 {backtest.get('tradeCount', '-')}，"
        f"胜率 {backtest.get('winRatePct', '-')}%，"
        f"平均收益 {backtest.get('averageReturnPct', '-')}%，"
        f"最大回撤 {backtest.get('maxDrawdownPct', '-')}%"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Review strategy promotion gates.")
    parser.add_argument("--output", default=str(repo_root() / "reports/data/strategy-quality-review.json"))
    parser.add_argument("--markdown", default=str(repo_root() / "reports/data/strategy-quality-review.md"))
    args = parser.parse_args()

    payload = build_strategy_registry()
    output = Path(args.output)
    markdown = Path(args.markdown)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown.write_text(render_markdown(payload), encoding="utf-8")
    print(f"strategies: {payload['summary']['total']}")
    print(f"paper allowed: {payload['summary'].get('paperAllowed', 0)}")
    print(f"paper blocked: {payload['summary'].get('paperBlocked', 0)}")
    print(f"json: {output}")
    print(f"markdown: {markdown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
