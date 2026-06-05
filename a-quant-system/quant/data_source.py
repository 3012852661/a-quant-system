from __future__ import annotations

import json
from pathlib import Path
from typing import Any


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


def load_fallback_rows(path: Path | None = None, limit: int | None = None) -> list[dict[str, Any]]:
    """Load local report rows so the daily pipeline can run without network."""
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


def get_market_rows(limit: int | None = None, fallback_path: Path | None = None) -> tuple[list[dict[str, Any]], str]:
    try:
        return fetch_a_share_spot(limit=limit), "akshare.stock_zh_a_spot_em"
    except Exception as exc:
        rows = load_fallback_rows(path=fallback_path, limit=limit)
        return rows, f"fallback:{exc.__class__.__name__}"
