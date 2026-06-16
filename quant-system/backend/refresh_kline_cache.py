from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.data.providers import EastMoneyDirectProvider, ProviderUnavailable


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def collect_codes(limit: int) -> list[str]:
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
    return codes


def main() -> int:
    parser = argparse.ArgumentParser(description="Refresh EastMoney daily K-line cache for current candidates.")
    parser.add_argument("--codes", default="", help="Comma-separated stock codes. Defaults to latest candidates.")
    parser.add_argument("--days", type=int, default=160)
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args()

    codes = [item.strip().zfill(6) for item in args.codes.split(",") if item.strip()] or collect_codes(args.limit)
    if not codes:
        print("no candidate codes found", file=sys.stderr)
        return 2

    provider = EastMoneyDirectProvider()
    cache_dir = repo_root() / "reports/data/kline-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    ok = 0
    failures: list[str] = []
    for code in codes:
        try:
            klines = provider.get_daily_kline(code, args.days)
        except ProviderUnavailable as exc:
            failures.append(f"{code}: {exc}")
            continue
        if not klines:
            failures.append(f"{code}: empty")
            continue
        payload = {
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "source": "eastmoney:push2his-kline",
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

    print(f"kline refreshed: {ok}/{len(codes)}")
    if failures:
        print("; ".join(failures[:8]), file=sys.stderr)
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
