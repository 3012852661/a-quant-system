from __future__ import annotations

import argparse
import itertools
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.backtest.engine import BacktestConfig, run_historical_event_backtest
from backend.committee.roles import repo_root
from backend.run_event_backtest import load_cached_klines, load_candidates, read_json
from backend.strategy.generator import generate_strategy_variants


def parameter_grid(parameters: dict[str, list[Any]]) -> list[dict[str, Any]]:
    keys = list(parameters.keys())
    return [dict(zip(keys, values)) for values in itertools.product(*(parameters[key] for key in keys))]


def score_result(metrics: dict[str, Any]) -> float:
    closed = float(metrics.get("closedTrades") or 0)
    win_rate = float(metrics.get("winRatePct") or 0)
    avg = float(metrics.get("averageReturnPct") or 0)
    drawdown = float(metrics.get("maxDrawdownPct") or 100)
    worst = float(metrics.get("worstReturnPct") or -100)
    sample_score = min(closed / 300, 1) * 10
    return round(sample_score + win_rate * 0.35 + avg * 8 - drawdown * 0.25 + max(worst, -30) * 0.2, 2)


def passes_gate(metrics: dict[str, Any]) -> bool:
    return (
        (metrics.get("closedTrades") or 0) >= 100
        and (metrics.get("winRatePct") or 0) >= 50
        and (metrics.get("averageReturnPct") or 0) > 0
        and (metrics.get("maxDrawdownPct") or 100) <= 25
        and (metrics.get("worstReturnPct") or -100) >= -12
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate strategy variants and run parameter grid backtests.")
    parser.add_argument("--base-key", default="volume_breakout")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--window", type=int, default=160)
    parser.add_argument("--output", default=str(repo_root() / "reports/data/parameter-backtest-result.json"))
    args = parser.parse_args()

    review = read_json(repo_root() / "reports/data/strategy-quality-review.json", {})
    candidates = load_candidates(args.limit)
    variants = generate_strategy_variants(args.base_key, review)
    runs: list[dict[str, Any]] = []
    for variant in variants:
        for params in parameter_grid(variant["parameters"]):
            config = BacktestConfig(
                hold_days=int(params["hold_days"]),
                max_position_pct=float(params["max_position_pct"]),
                slippage_bps=float(params["slippage_bps"]),
                max_volume_pct=float(params["max_volume_pct"]),
                limit_pct=float(params["limit_pct"]),
                stop_loss_pct=float(params.get("stop_loss_pct", 4)),
                min_volume_ratio=float(params.get("min_volume_ratio", 1.5)),
                max_twenty_day_pct=float(params.get("max_twenty_day_pct", 45)),
            )
            result = run_historical_event_backtest(candidates, load_cached_klines, config=config, window=args.window)
            metrics = result["metrics"]
            runs.append(
                {
                    "variantKey": variant["key"],
                    "variantName": variant["name"],
                    "thesis": variant["thesis"],
                    "params": params,
                    "metrics": metrics,
                    "score": score_result(metrics),
                    "passesGate": passes_gate(metrics),
                    "rules": result.get("rules", []),
                    "sampleTrades": result.get("trades", [])[:8],
                }
            )
    runs.sort(key=lambda item: (item["passesGate"], item["score"]), reverse=True)
    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "baseKey": args.base_key,
        "variants": variants,
        "summary": {
            "runs": len(runs),
            "passed": sum(1 for item in runs if item["passesGate"]),
            "bestScore": runs[0]["score"] if runs else None,
            "bestVariant": runs[0]["variantKey"] if runs else None,
        },
        "runs": runs,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"runs: {payload['summary']['runs']}")
    print(f"passed: {payload['summary']['passed']}")
    print(f"best: {payload['summary']['bestVariant']} score={payload['summary']['bestScore']}")
    print(f"json: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
