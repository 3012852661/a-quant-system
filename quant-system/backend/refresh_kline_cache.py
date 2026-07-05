from __future__ import annotations

import argparse
import json
import signal
import sys
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.data.providers import SinaKLineProvider


class TimeoutError(Exception):
    pass


@contextmanager
def per_item_timeout(seconds: int):
    if seconds <= 0 or not hasattr(signal, "SIGALRM"):
        yield
        return

    def handler(signum, frame):
        raise TimeoutError(f"timeout after {seconds}s")

    previous = signal.signal(signal.SIGALRM, handler)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def shanghai_trade_date() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def collect_codes(limit: int, include_watchlist: bool = False) -> list[str]:
    root = repo_root()
    sources = [
        read_json(root / "quant-system/backend/data/stock_pool_latest.json", {}),
        read_json(root / "reports/data/latest-quant-recommendation.json", {}),
        read_json(root / "reports/data/latest-trading-signals.json", {}),
    ]
    rows: list[dict[str, Any]] = []
    for payload in sources:
        if isinstance(payload.get("signals"), list):
            rows.extend(payload["signals"])
        for key in ("recommendedBuys", "qualityRadar", "upliftTop", "watchPlan", "trade", "watch"):
            if isinstance(payload.get(key), list):
                rows.extend(payload[key])
    codes: list[str] = []
    seen: set[str] = set()
    for row in rows:
        code = str(row.get("code", "")).zfill(6)
        if not code or code in seen:
            continue
        seen.add(code)
        codes.append(code)
        if len(codes) >= limit:
            break
    if include_watchlist:
        watchlist_sources = [
            read_json(root / "reports/data/user-watchlist.json", {}),
            read_json(root / "reports/data/user-watchlist-attribution.json", {}),
        ]
        for payload in watchlist_sources:
            watch_rows = payload.get("stocks") if isinstance(payload.get("stocks"), list) else payload.get("rows")
            if not isinstance(watch_rows, list):
                continue
            for row in watch_rows:
                code = str(row.get("code", "") or row.get("股票代码", "")).zfill(6)
                if not code or code in seen:
                    continue
                seen.add(code)
                codes.append(code)
    return codes


def has_fresh_cache(cache_dir: Path, code: str, trade_date: str) -> bool:
    payload = read_json(cache_dir / f"{code}.daily.json", {})
    klines = payload.get("klines") if isinstance(payload.get("klines"), list) else []
    if not klines:
        return False
    latest = str((klines[-1] or {}).get("date", ""))
    return latest >= trade_date


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh EastMoney daily K-line cache for current candidates.")
    parser.add_argument("--codes", default="", help="Comma-separated stock codes. Defaults to latest candidates.")
    parser.add_argument("--days", type=int, default=160)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--include-watchlist", action="store_true", help="Also refresh configured user watchlist codes.")
    parser.add_argument("--per-code-timeout", type=int, default=8, help="Hard timeout in seconds for each symbol.")
    parser.add_argument("--refresh-existing", action="store_true", help="Refresh even when today's cache already exists.")
    parser.add_argument("--max-fetch", type=int, default=40, help="Maximum number of uncached symbols to fetch in one run.")
    args = parser.parse_args()

    codes = [item.strip().zfill(6) for item in args.codes.split(",") if item.strip()] or collect_codes(args.limit, args.include_watchlist)
    if not codes:
        print("no candidate codes found", file=sys.stderr)
        return 2

    provider = SinaKLineProvider()
    cache_dir = repo_root() / "reports/data/kline-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    ok = 0
    skipped = 0
    fetch_attempts = 0
    failures: list[str] = []
    trade_date = shanghai_trade_date()
    for code in codes:
        if not args.refresh_existing and has_fresh_cache(cache_dir, code, trade_date):
            skipped += 1
            continue
        if args.max_fetch > 0 and fetch_attempts >= args.max_fetch:
            skipped += 1
            continue
        fetch_attempts += 1
        try:
            with per_item_timeout(args.per_code_timeout):
                klines = provider.get_daily_kline(code, args.days)
        except Exception as exc:
            failures.append(f"{code}: {exc}")
            continue
        if not klines:
            failures.append(f"{code}: empty")
            continue
        payload = {
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "source": "sina:kline-daily",
            "code": code,
            "klines": [
                {
                    "date": item.trade_date.isoformat(),
                    "open": item.open,
                    "close": item.close,
                    "high": item.high,
                    "low": item.low,
                    "volume": item.volume,
                    "amount": item.amount,
                }
                for item in klines
            ],
        }
        (cache_dir / f"{code}.daily.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        ok += 1

    print(f"kline refreshed: {ok}/{len(codes)}; skipped fresh: {skipped}")
    if failures:
        print("; ".join(failures[:8]), file=sys.stderr)
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
