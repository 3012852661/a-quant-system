from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from backend.db import create_database_engine, init_db, stock_pool
from backend.run_selection import repo_root, to_float


@dataclass
class KLine:
    trade_date: date
    open: float
    close: float


def parse_date(value: Any) -> date | None:
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def load_cached_klines(code: str) -> list[KLine]:
    path = repo_root() / "reports" / "data" / "kline-cache" / f"{code}.daily.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    rows = payload.get("klines", payload if isinstance(payload, list) else [])
    klines: list[KLine] = []
    for row in rows:
        if isinstance(row, str):
            parts = row.split(",")
            if len(parts) < 3:
                continue
            trade_date = parse_date(parts[0])
            if trade_date:
                klines.append(KLine(trade_date, to_float(parts[1]), to_float(parts[2])))
        elif isinstance(row, dict):
            trade_date = parse_date(row.get("date") or row.get("trade_date"))
            if trade_date:
                klines.append(KLine(trade_date, to_float(row.get("open")), to_float(row.get("close"))))
    return sorted(klines, key=lambda item: item.trade_date)


def max_drawdown(returns: list[float]) -> float:
    equity = 1.0
    peak = 1.0
    worst = 0.0
    for item in returns:
        equity *= 1 + item / 100
        peak = max(peak, equity)
        worst = min(worst, (equity / peak - 1) * 100)
    return round(abs(worst), 2)


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 2)
    rank = (len(ordered) - 1) * pct
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    weight = rank - lower
    return round(ordered[lower] * (1 - weight) + ordered[upper] * weight, 2)


def grouped_returns(trades: list[dict[str, Any]]) -> dict[str, list[float]]:
    groups: dict[str, list[float]] = {}
    for trade in trades:
        groups.setdefault(str(trade["code"]), []).append(float(trade["return_pct"]))
    return groups


def price_max_drawdown(closes: list[float]) -> float:
    peak = 0.0
    worst = 0.0
    for close in closes:
        if close <= 0:
            continue
        peak = max(peak, close)
        if peak > 0:
            worst = min(worst, (close / peak - 1) * 100)
    return round(abs(worst), 2)


def historical_price_drawdowns(rows: list[dict[str, Any]], window: int) -> list[float]:
    drawdowns: list[float] = []
    seen_codes: set[str] = set()
    for row in rows:
        code = str(row["code"])
        if code in seen_codes:
            continue
        seen_codes.add(code)
        klines = load_cached_klines(code)
        sample = klines[-window:] if window > 0 else klines
        closes = [item.close for item in sample]
        if closes:
            drawdowns.append(price_max_drawdown(closes))
    return drawdowns


def historical_distribution_metrics(trades: list[dict[str, Any]], rows: list[dict[str, Any]], window: int) -> dict[str, Any]:
    returns = [float(item["return_pct"]) for item in trades]
    groups = grouped_returns(trades)
    code_averages = [sum(items) / len(items) for items in groups.values() if items]
    price_drawdowns = historical_price_drawdowns(rows, window)
    return {
        "median_return_pct": percentile(returns, 0.5),
        "p25_return_pct": percentile(returns, 0.25),
        "p75_return_pct": percentile(returns, 0.75),
        "worst_trade_return_pct": round(min(returns), 2) if returns else None,
        "best_trade_return_pct": round(max(returns), 2) if returns else None,
        "codes_tested": len(groups),
        "average_code_return_pct": round(sum(code_averages) / len(code_averages), 2) if code_averages else None,
        "average_code_price_drawdown_pct": round(sum(price_drawdowns) / len(price_drawdowns), 2) if price_drawdowns else None,
        "worst_code_price_drawdown_pct": round(max(price_drawdowns), 2) if price_drawdowns else None,
    }


def build_event_trades(rows: list[dict[str, Any]], hold_days: int) -> tuple[list[dict[str, Any]], list[str]]:
    trades: list[dict[str, Any]] = []
    skipped: list[str] = []
    for row in rows:
        klines = load_cached_klines(row["code"])
        if not klines:
            skipped.append(f"{row['code']} no kline cache")
            continue
        start_idx = next((idx for idx, item in enumerate(klines) if item.trade_date > row["trade_date"]), None)
        if start_idx is None or start_idx + hold_days - 1 >= len(klines):
            skipped.append(f"{row['code']} insufficient future kline")
            continue
        buy = klines[start_idx]
        sell = klines[start_idx + hold_days - 1]
        if buy.open <= 0:
            skipped.append(f"{row['code']} invalid buy open")
            continue
        return_pct = (sell.close / buy.open - 1) * 100
        trades.append(
            {
                "mode": "event_forward",
                "trade_date": row["trade_date"].isoformat(),
                "code": row["code"],
                "name": row["name"],
                "buy_date": buy.trade_date.isoformat(),
                "sell_date": sell.trade_date.isoformat(),
                "buy_price": round(buy.open, 2),
                "sell_price": round(sell.close, 2),
                "return_pct": round(return_pct, 2),
            }
        )
    return trades, skipped


def build_historical_trades(rows: list[dict[str, Any]], hold_days: int, window: int) -> tuple[list[dict[str, Any]], list[str]]:
    trades: list[dict[str, Any]] = []
    skipped: list[str] = []
    seen_codes: set[str] = set()
    unique_rows: list[dict[str, Any]] = []
    for row in rows:
        code = str(row["code"])
        if code in seen_codes:
            continue
        seen_codes.add(code)
        unique_rows.append(row)

    for row in unique_rows:
        klines = load_cached_klines(row["code"])
        if len(klines) <= hold_days + 20:
            skipped.append(f"{row['code']} insufficient historical kline")
            continue
        sample = klines[-window:] if window > 0 else klines
        if len(sample) <= hold_days:
            skipped.append(f"{row['code']} insufficient historical window")
            continue
        for idx in range(0, len(sample) - hold_days):
            buy = sample[idx]
            sell = sample[idx + hold_days]
            if buy.open <= 0:
                continue
            return_pct = (sell.close / buy.open - 1) * 100
            trades.append(
                {
                    "mode": "historical_rolling",
                    "trade_date": row["trade_date"].isoformat(),
                    "code": row["code"],
                    "name": row["name"],
                    "buy_date": buy.trade_date.isoformat(),
                    "sell_date": sell.trade_date.isoformat(),
                    "buy_price": round(buy.open, 2),
                    "sell_price": round(sell.close, 2),
                    "return_pct": round(return_pct, 2),
                }
            )
    return trades, skipped


def summarize(
    rows: list[dict[str, Any]],
    trades: list[dict[str, Any]],
    skipped: list[str],
    hold_days: int,
    mode: str,
    historical_window: int,
) -> dict:
    returns = [item["return_pct"] for item in trades]
    is_historical = mode.startswith("historical_rolling")
    summary = {
        "mode": mode,
        "pool_rows": len(rows),
        "trades": len(trades),
        "skipped": len(skipped),
        "hold_days": hold_days,
        "average_return_pct": round(sum(returns) / len(returns), 2) if returns else 0,
        "win_rate_pct": round(sum(1 for item in returns if item > 0) / len(returns) * 100, 2) if returns else 0,
        "max_drawdown_pct": max_drawdown(returns) if not is_historical else None,
        "trade_samples": trades[:10],
        "skip_samples": skipped[:10],
    }
    if is_historical:
        summary["distribution"] = historical_distribution_metrics(trades, rows, historical_window)
        summary["metric_note"] = (
            "历史滚动样本包含同一股票的重叠持有期，max_drawdown_pct 不做串联复利计算；"
            "请优先查看 distribution 中的分位数和基于价格序列的分股票回撤。"
        )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Backtest persisted stock pool.")
    parser.add_argument("--db", default=str(repo_root() / "quant-system/data/quant.db"))
    parser.add_argument("--trade-date", default=None)
    parser.add_argument("--hold-days", type=int, default=3)
    parser.add_argument(
        "--mode",
        choices=("auto", "event-forward", "historical-rolling"),
        default="auto",
        help="event-forward uses future klines after the stock-pool date; historical-rolling samples cached history for the same codes.",
    )
    parser.add_argument("--historical-window", type=int, default=120, help="Trading days per code for historical-rolling mode.")
    args = parser.parse_args()

    db_path = Path(args.db)
    engine = create_database_engine(db_path)
    init_db(engine)

    query = select(stock_pool)
    if args.trade_date:
        parsed = parse_date(args.trade_date)
        if parsed is None:
            raise SystemExit(f"invalid trade date: {args.trade_date}")
        query = query.where(stock_pool.c.trade_date == parsed)
    query = query.order_by(stock_pool.c.trade_date, stock_pool.c.score.desc())

    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(query).mappings().all()]

    mode = args.mode
    if args.mode in ("auto", "event-forward"):
        trades, skipped = build_event_trades(rows, args.hold_days)
        mode = "event_forward"
    if args.mode == "historical-rolling" or (args.mode == "auto" and not trades):
        historical_trades, historical_skipped = build_historical_trades(rows, args.hold_days, args.historical_window)
        if args.mode == "auto" and not trades:
            skipped = [*skipped, *historical_skipped]
            trades = historical_trades
            mode = "historical_rolling_fallback"
        elif args.mode == "historical-rolling":
            skipped = historical_skipped
            trades = historical_trades
            mode = "historical_rolling"

    summary = {
        "db": str(db_path),
        **summarize(rows, trades, skipped, args.hold_days, mode, args.historical_window),
    }
    if mode == "historical_rolling_fallback":
        summary["warning"] = "事件后验回测缺少未来K线，已自动切换为同一候选代码的历史滚动样本。"
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
