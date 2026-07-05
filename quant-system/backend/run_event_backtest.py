from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.backtest.engine import BacktestConfig, Bar, run_historical_event_backtest, to_bar
from backend.committee.roles import repo_root


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def load_candidates(limit: int) -> list[dict[str, Any]]:
    pool = read_json(repo_root() / "quant-system/backend/data/stock_pool_latest.json", {})
    rows = pool.get("signals", []) if isinstance(pool, dict) else []
    if not rows:
        recommendation = read_json(repo_root() / "reports/data/latest-quant-recommendation.json", {})
        rows = recommendation.get("recommendedBuys", []) if isinstance(recommendation, dict) else []
    return [item for item in rows if isinstance(item, dict)][:limit]


def load_cached_klines(code: str) -> list[Bar]:
    payload = read_json(repo_root() / f"reports/data/kline-cache/{code}.daily.json", {})
    rows = payload.get("klines", payload if isinstance(payload, list) else [])
    bars = [bar for row in rows if (bar := to_bar(row))]
    return bars


def main() -> int:
    parser = argparse.ArgumentParser(description="Run event-style A-share backtest with execution constraints.")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--hold-days", type=int, default=2)
    parser.add_argument("--window", type=int, default=160)
    parser.add_argument("--initial-cash", type=float, default=100000)
    parser.add_argument("--max-position-pct", type=float, default=6)
    parser.add_argument("--stop-loss-pct", type=float, default=4)
    parser.add_argument("--min-volume-ratio", type=float, default=1.5)
    parser.add_argument("--max-twenty-day-pct", type=float, default=45)
    parser.add_argument("--min-signal-pct", type=float, default=3)
    parser.add_argument("--max-signal-pct", type=float, default=7)
    parser.add_argument("--output", default=str(repo_root() / "reports/data/event-backtest-result.json"))
    args = parser.parse_args()

    config = BacktestConfig(
        initial_cash=args.initial_cash,
        hold_days=args.hold_days,
        max_position_pct=args.max_position_pct,
        stop_loss_pct=args.stop_loss_pct,
        min_volume_ratio=args.min_volume_ratio,
        max_twenty_day_pct=args.max_twenty_day_pct,
        min_signal_pct=args.min_signal_pct,
        max_signal_pct=args.max_signal_pct,
    )
    payload = run_historical_event_backtest(load_candidates(args.limit), load_cached_klines, config=config, window=args.window)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"closed trades: {payload['metrics']['closedTrades']}")
    print(f"win rate: {payload['metrics']['winRatePct']}")
    print(f"avg return: {payload['metrics']['averageReturnPct']}")
    print(f"json: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
