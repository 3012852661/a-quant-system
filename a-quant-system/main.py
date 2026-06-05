from __future__ import annotations

import argparse
import logging
from datetime import date
from pathlib import Path

from quant.data_source import get_market_rows
from quant.report import write_daily_csv, write_daily_report
from quant.storage import count_by_date, save_stock_pool
from quant.strategy import select_stock_pool


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Daily A-share stock selection.")
    parser.add_argument("--trade-date", default=date.today().isoformat())
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--fetch-limit", type=int, default=None)
    parser.add_argument("--db", default="data/stock_pool.db")
    parser.add_argument("--report-dir", default="reports/daily")
    parser.add_argument("--csv-dir", default="data/daily")
    parser.add_argument("--log-file", default="logs/daily.log")
    parser.add_argument("--fallback", default="../reports/data/latest-free-a-share-scan.brief.json")
    return parser.parse_args()


def setup_logging(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(path, encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )


def main() -> int:
    args = parse_args()
    root = Path(__file__).resolve().parent
    db_path = root / args.db
    report_dir = root / args.report_dir
    csv_dir = root / args.csv_dir
    log_path = root / args.log_file
    fallback_path = (root / args.fallback).resolve()
    setup_logging(log_path)

    logging.info("daily selection started trade_date=%s", args.trade_date)
    rows, source = get_market_rows(limit=args.fetch_limit, fallback_path=fallback_path)
    logging.info("loaded market rows=%s source=%s", len(rows), source)
    stock_pool = select_stock_pool(rows, limit=args.limit)
    saved = save_stock_pool(db_path, args.trade_date, stock_pool)
    report_path = write_daily_report(report_dir, args.trade_date, stock_pool, source, db_path)
    csv_path = write_daily_csv(csv_dir, args.trade_date, stock_pool)
    db_count = count_by_date(db_path, args.trade_date)
    logging.info("daily selection completed selected=%s saved=%s report=%s", len(stock_pool), saved, report_path)

    print(f"trade_date: {args.trade_date}")
    print(f"source: {source}")
    print(f"selected: {len(stock_pool)}")
    print(f"saved: {saved}")
    print(f"db_rows_for_date: {db_count}")
    print(f"db: {db_path}")
    print(f"report: {report_path}")
    print(f"csv: {csv_path}")
    print(f"log: {log_path}")
    for row in stock_pool[:10]:
        print(
            f"{row['code']} {row['name']} price={row['price']} pct={row['pct_chg']}% "
            f"turnover={row['turnover']} vr={row['volume_ratio']} score={row['score']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
