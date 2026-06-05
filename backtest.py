from __future__ import annotations

import argparse
from datetime import datetime, timedelta
from pathlib import Path

from quant.data_source import fetch_daily_kline
from quant.report import write_backtest_report
from quant.storage import load_stock_pool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backtest persisted stock pool.")
    parser.add_argument("--trade-date", default=None, help="Only backtest one stock-pool date.")
    parser.add_argument("--hold-days", type=int, default=3)
    parser.add_argument("--db", default="data/stock_pool.db")
    parser.add_argument("--report-dir", default="reports/daily")
    parser.add_argument("--end-date", default=(datetime.today() + timedelta(days=30)).date().isoformat())
    return parser.parse_args()


def date_key(value: str) -> str:
    return value.replace("-", "")


def max_drawdown(returns: list[float]) -> float:
    equity = 1.0
    peak = 1.0
    worst = 0.0
    for item in returns:
        equity *= 1 + item / 100
        peak = max(peak, equity)
        worst = min(worst, (equity / peak - 1) * 100)
    return abs(worst)


def find_trade_window(klines: list[dict], signal_date: str, hold_days: int) -> tuple[dict, dict] | None:
    ordered = sorted(klines, key=lambda item: item["trade_date"])
    start_idx = next(
        (idx for idx, item in enumerate(ordered) if date_key(item["trade_date"]) > date_key(signal_date)),
        None,
    )
    if start_idx is None:
        return None
    sell_idx = start_idx + hold_days - 1
    if sell_idx >= len(ordered):
        return None
    return ordered[start_idx], ordered[sell_idx]


def run_backtest(root: Path, trade_date: str | None, hold_days: int, end_date: str, db_path: Path) -> dict:
    rows = load_stock_pool(db_path, trade_date=trade_date)
    trades: list[dict] = []
    skipped: list[str] = []

    for row in rows:
        try:
            klines = fetch_daily_kline(
                row["code"],
                start_date=row["trade_date"],
                end_date=end_date,
            )
        except Exception as exc:
            skipped.append(f"{row['code']} {row['name']} kline error: {exc.__class__.__name__}")
            continue

        window = find_trade_window(klines, row["trade_date"], hold_days)
        if not window:
            skipped.append(f"{row['code']} {row['name']} insufficient future kline")
            continue
        buy, sell = window
        buy_price = float(buy["open"])
        sell_price = float(sell["close"])
        if buy_price <= 0:
            skipped.append(f"{row['code']} {row['name']} invalid buy price")
            continue
        return_pct = (sell_price / buy_price - 1) * 100
        trades.append(
            {
                "trade_date": row["trade_date"],
                "code": row["code"],
                "name": row["name"],
                "buy_date": buy["trade_date"],
                "sell_date": sell["trade_date"],
                "buy_price": round(buy_price, 2),
                "sell_price": round(sell_price, 2),
                "return_pct": round(return_pct, 2),
            }
        )

    returns = [item["return_pct"] for item in trades]
    return {
        "trade_date": trade_date,
        "pool_rows": len(rows),
        "trades": len(trades),
        "skipped": len(skipped),
        "hold_days": hold_days,
        "average_return_pct": round(sum(returns) / len(returns), 2) if returns else 0.0,
        "win_rate_pct": round(sum(1 for item in returns if item > 0) / len(returns) * 100, 2) if returns else 0.0,
        "max_drawdown_pct": round(max_drawdown(returns), 2),
        "trade_samples": trades[:20],
        "skip_samples": skipped[:20],
    }


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parent
    db_path = root / args.db
    result = run_backtest(root, args.trade_date, args.hold_days, args.end_date, db_path)
    report_path = write_backtest_report(root / args.report_dir, result)

    print(f"pool_rows: {result['pool_rows']}")
    print(f"trades: {result['trades']}")
    print(f"skipped: {result['skipped']}")
    print(f"average_return_pct: {result['average_return_pct']}")
    print(f"win_rate_pct: {result['win_rate_pct']}")
    print(f"max_drawdown_pct: {result['max_drawdown_pct']}")
    print(f"report: {report_path}")
    for item in result["trade_samples"][:10]:
        print(
            f"{item['code']} {item['name']} buy={item['buy_date']} sell={item['sell_date']} "
            f"return={item['return_pct']}%"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
