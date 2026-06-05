from __future__ import annotations

from typing import Any


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, "", "-"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def is_beijing_exchange(code: str) -> bool:
    return code.startswith(("4", "8", "920"))


def score_stock(row: dict[str, Any]) -> float:
    return (
        _to_float(row.get("pct_chg")) * 2
        + _to_float(row.get("volume_ratio")) * 5
        + _to_float(row.get("turnover")) * 0.5
    )


def select_stock_pool(rows: list[dict[str, Any]], limit: int = 30) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for row in rows:
        code = str(row.get("code", "")).zfill(6)
        name = str(row.get("name", ""))
        price = _to_float(row.get("price"))
        pct_chg = _to_float(row.get("pct_chg"))
        turnover = _to_float(row.get("turnover"))
        volume_ratio = _to_float(row.get("volume_ratio"))
        market_cap = _to_float(row.get("market_cap"))
        market_cap_yi = market_cap / 100_000_000 if market_cap > 1_000_000 else market_cap

        if not code or not name:
            continue
        if "ST" in name.upper() or "退" in name:
            continue
        if is_beijing_exchange(code):
            continue
        if price <= 5:
            continue
        if not (3 <= pct_chg <= 7):
            continue
        if not (3 <= turnover <= 20):
            continue
        if volume_ratio <= 1.5:
            continue
        if not (50 <= market_cap_yi <= 800):
            continue

        item = {
            "code": code,
            "name": name,
            "price": round(price, 2),
            "pct_chg": round(pct_chg, 2),
            "turnover": round(turnover, 2),
            "volume_ratio": round(volume_ratio, 2),
            "market_cap": round(market_cap, 2),
            "score": round(score_stock(row), 2),
        }
        selected.append(item)

    selected.sort(key=lambda item: item["score"], reverse=True)
    return selected[:limit]
