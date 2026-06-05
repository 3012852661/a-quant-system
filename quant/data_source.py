from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlencode


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, "", "-"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    code = str(row.get("代码") or row.get("code") or "").zfill(6)
    return {
        "code": code,
        "name": str(row.get("名称") or row.get("name") or ""),
        "price": _to_float(row.get("最新价") or row.get("price")),
        "pct_chg": _to_float(row.get("涨跌幅") or row.get("pct") or row.get("pct_chg")),
        "turnover": _to_float(row.get("换手率") or row.get("turnover")),
        "volume_ratio": _to_float(row.get("量比") or row.get("volumeRatio") or row.get("volume_ratio"), 1.0),
        "market_cap": _to_float(row.get("总市值") or row.get("marketCap") or row.get("market_cap")),
    }


def fetch_a_share_spot(limit: int | None = None) -> list[dict[str, Any]]:
    """Fetch realtime A-share spot data with AkShare."""
    import akshare as ak  # type: ignore

    frame = ak.stock_zh_a_spot_em()
    if limit:
        frame = frame.head(limit)
    return [_normalize_row(row.to_dict()) for _, row in frame.iterrows()]


def _normalize_eastmoney_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": str(row.get("f12") or "").zfill(6),
        "name": str(row.get("f14") or ""),
        "price": _to_float(row.get("f2")),
        "pct_chg": _to_float(row.get("f3")),
        "turnover": _to_float(row.get("f8")),
        "volume_ratio": _to_float(row.get("f10"), 1.0),
        "market_cap": _to_float(row.get("f20")),
    }


def fetch_eastmoney_spot_with_curl(
    limit: int | None = None,
    page_size: int = 100,
    max_pages: int = 80,
) -> list[dict[str, Any]]:
    """Fetch realtime A-share spot data from Eastmoney using system curl."""
    rows: list[dict[str, Any]] = []
    base_urls = (
        "https://push2.eastmoney.com/api/qt/clist/get",
        "https://push2delay.eastmoney.com/api/qt/clist/get",
        "http://push2.eastmoney.com/api/qt/clist/get",
        "http://77.push2.eastmoney.com/api/qt/clist/get",
    )
    fields = "f12,f14,f2,f3,f8,f10,f20"
    fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"

    for page in range(1, max_pages + 1):
        params = {
            "pn": page,
            "pz": page_size,
            "po": 1,
            "np": 1,
            "fltt": 2,
            "invt": 2,
            "fid": "f3",
            "fs": fs,
            "fields": fields,
        }
        payload = None
        errors: list[str] = []
        for base_url in base_urls:
            url = f"{base_url}?{urlencode(params)}"
            result = subprocess.run(
                [
                    "curl",
                    "-L",
                    "-sS",
                    "--ipv4",
                    "--connect-timeout",
                    "5",
                    "--max-time",
                    "10",
                    "--retry",
                    "2",
                    "--retry-delay",
                    "1",
                    "--compressed",
                    "-A",
                    "Mozilla/5.0",
                    "-e",
                    "https://quote.eastmoney.com/",
                    url,
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                errors.append(f"{base_url}: curl exit {result.returncode} {result.stderr.strip()}")
                continue
            try:
                payload = json.loads(result.stdout)
                break
            except json.JSONDecodeError as exc:
                errors.append(f"{base_url}: json error {exc}")
        if payload is None:
            last_pct = _to_float(rows[-1]["pct_chg"]) if rows else 999.0
            if rows and last_pct < 3:
                break
            raise RuntimeError(f"Eastmoney page {page} failed: {' | '.join(errors)}")
        diff = payload.get("data", {}).get("diff") or []
        if not diff:
            break
        page_rows = [_normalize_eastmoney_row(item) for item in diff]
        rows.extend(page_rows)
        if limit and len(rows) >= limit:
            return rows[:limit]
        if page_rows and _to_float(page_rows[-1]["pct_chg"]) < 3:
            break
        if len(diff) < page_size:
            break
    return rows


def fetch_daily_kline(
    code: str,
    start_date: str,
    end_date: str,
    adjust: str = "qfq",
) -> list[dict[str, Any]]:
    """Fetch daily kline data for one A-share stock with AkShare."""
    import akshare as ak  # type: ignore

    frame = ak.stock_zh_a_hist(
        symbol=code,
        period="daily",
        start_date=start_date.replace("-", ""),
        end_date=end_date.replace("-", ""),
        adjust=adjust,
    )
    rows: list[dict[str, Any]] = []
    for _, row in frame.iterrows():
        rows.append(
            {
                "trade_date": str(row.get("日期")),
                "open": _to_float(row.get("开盘")),
                "close": _to_float(row.get("收盘")),
                "high": _to_float(row.get("最高")),
                "low": _to_float(row.get("最低")),
                "volume": _to_float(row.get("成交量")),
                "amount": _to_float(row.get("成交额")),
            }
        )
    return rows


def load_dev_rows(path: Path | None = None, limit: int | None = None) -> list[dict[str, Any]]:
    """Load local rows only for explicit development tests, never for production."""
    report_path = path or _repo_root() / "reports/data/latest-free-a-share-scan.brief.json"
    payload = json.loads(report_path.read_text(encoding="utf-8"))
    rows: list[dict[str, Any]] = []
    for key in ("actionable", "tactical", "watch", "strongNotLimit", "qualityPool", "fundTop"):
        value = payload.get(key)
        if isinstance(value, list):
            rows.extend(item for item in value if isinstance(item, dict))

    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for row in rows:
        item = _normalize_row(row)
        if not item["code"] or item["code"] in seen:
            continue
        seen.add(item["code"])
        normalized.append(item)
        if limit and len(normalized) >= limit:
            break
    return normalized


def get_market_rows(
    limit: int | None = None,
    dev_data_path: Path | None = None,
    allow_dev_data: bool = False,
) -> tuple[list[dict[str, Any]], str]:
    if allow_dev_data:
        return load_dev_rows(path=dev_data_path, limit=limit), "dev-local-report"
    try:
        return fetch_a_share_spot(limit=limit), "akshare.stock_zh_a_spot_em"
    except Exception:
        return fetch_eastmoney_spot_with_curl(limit=limit), "eastmoney.curl.clist"
