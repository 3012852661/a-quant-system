from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.committee.roles import repo_root


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def render_case(review: dict[str, Any], params: dict[str, Any]) -> str:
    blocked = [row for row in review.get("rows", []) if row.get("execution_gate") == "PAPER_BLOCKED"]
    top_runs = params.get("runs", [])[:5]
    lines = [
        f"# {date.today().isoformat()} 策略失败复盘：放量突破",
        "",
        "status: L2 normalized",
        "type: strategy-failure-review",
        "source: reports/data/strategy-quality-review.json; reports/data/parameter-backtest-result.json",
        "",
        "## 背景",
        "",
        "系统已将 TradingAgents-CN 风格的研究层输出接入 QuantDinger 风格的策略注册、回测、Paper Trading 和准入闸门。",
        "本案例记录 `volume_breakout` 未通过 Paper 准入的原因，以及参数回测后的改进方向。",
        "",
        "## 失败结论",
        "",
    ]
    for row in blocked:
        lines.extend(
            [
                f"- 策略：{row.get('name')}（{row.get('key')}）",
                f"- 闸门：{row.get('execution_gate')}",
                f"- 阻塞原因：{'；'.join(row.get('gate_reasons') or [])}",
                f"- 下一步：{'；'.join(row.get('next_actions') or [])}",
                "",
            ]
        )
    lines.extend(["## 参数回测摘要", ""])
    summary = params.get("summary", {})
    lines.extend(
        [
            f"- 参数组合数：{summary.get('runs', 0)}",
            f"- 通过准入数：{summary.get('passed', 0)}",
            f"- 最佳组合：{summary.get('bestVariant')}，score={summary.get('bestScore')}",
            "",
        ]
    )
    for run in top_runs:
        m = run.get("metrics", {})
        lines.extend(
            [
                f"### {run.get('variantName')} / {run.get('params')}",
                "",
                f"- score：{run.get('score')}，passesGate：{run.get('passesGate')}",
                f"- 样本：{m.get('closedTrades')}，胜率：{m.get('winRatePct')}%，平均收益：{m.get('averageReturnPct')}%，最大回撤：{m.get('maxDrawdownPct')}%",
                "",
            ]
        )
    lines.extend(
        [
            "## 复盘动作",
            "",
            "- 若没有参数组合通过准入，保持 `PAPER_BLOCKED`，不得进入自动交易。",
            "- 优先研究回撤来源：高波动个股、追高买点、市场环境退潮、持有期过长。",
            "- 下一轮策略生成应加入大盘环境过滤、单票止损、组合止损和更严格流动性过滤。",
            "- 该案例可被 Risk Officer 引用为放量突破策略的禁用证据。",
            "",
            "## Agent 使用",
            "",
            "- 研究 Agent 可以引用本案例解释策略失败原因。",
            "- 执行 Agent 必须把本案例作为 `volume_breakout` 的阻塞证据，直到新参数通过准入。",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Write failed strategy review into Case-KB.")
    parser.add_argument("--output", default=str(repo_root() / f"quant-system/knowledge/Case-KB/{date.today().isoformat()}-volume-breakout-failure.md"))
    args = parser.parse_args()

    review = read_json(repo_root() / "reports/data/strategy-quality-review.json", {})
    params = read_json(repo_root() / "reports/data/parameter-backtest-result.json", {})
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(render_case(review, params), encoding="utf-8")
    print(f"case: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
