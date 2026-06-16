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


def main() -> int:
    parser = argparse.ArgumentParser(description="Backtest persisted stock pool.")
    parser.add_argument("--db", default=str(repo_root() / "quant-system/data/quant.db"))
    parser.add_argument("--trade-date", default=None)
    parser.add_argument("--hold-days", type=int, default=3)
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

    trades: list[dict[str, Any]] = []
    skipped: list[str] = []
    with engine.connect() as conn:
        rows = conn.execute(query).mappings().all()

    for row in rows:
        klines = load_cached_klines(row["code"])
        if not klines:
            skipped.append(f"{row['code']} no kline cache")
            continue
        start_idx = next((idx for idx, item in enumerate(klines) if item.trade_date > row["trade_date"]), None)
        if start_idx is None or start_idx + args.hold_days - 1 >= len(klines):
            skipped.append(f"{row['code']} insufficient future kline")
            continue
        buy = klines[start_idx]
        sell = klines[start_idx + args.hold_days - 1]
        if buy.open <= 0:
            skipped.append(f"{row['code']} invalid buy open")
            continue
        return_pct = (sell.close / buy.open - 1) * 100
        trades.append(
            {
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

    returns = [item["return_pct"] for item in trades]
    summary = {
        "db": str(db_path),
        "pool_rows": len(rows),
        "trades": len(trades),
        "skipped": len(skipped),
        "hold_days": args.hold_days,
        "average_return_pct": round(sum(returns) / len(returns), 2) if returns else 0,
        "win_rate_pct": round(sum(1 for item in returns if item > 0) / len(returns) * 100, 2) if returns else 0,
        "max_drawdown_pct": max_drawdown(returns),
        "trade_samples": trades[:10],
        "skip_samples": skipped[:10],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
