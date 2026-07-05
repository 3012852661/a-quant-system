from __future__ import annotations

from typing import Any, Callable


QuoteLookup = Callable[[str], dict[str, Any] | None]


def default_trade_state() -> dict[str, Any]:
    return {
        "mode": "PAPER",
        "cash": 100000.0,
        "initialCash": 100000.0,
        "positions": [],
        "orders": [],
        "trades": [],
    }


def normalize_position(position: dict[str, Any], quote_lookup: QuoteLookup) -> dict[str, Any]:
    quote = quote_lookup(str(position["code"]))
    last_price = float(quote.get("price") or position.get("lastPrice") or position["avgPrice"]) if quote else float(
        position.get("lastPrice") or position["avgPrice"]
    )
    market_value = last_price * int(position["quantity"])
    cost = float(position["avgPrice"]) * int(position["quantity"])
    return {
        **position,
        "lastPrice": round(last_price, 3),
        "marketValue": round(market_value, 2),
        "unrealizedPct": round((market_value / cost - 1) * 100, 2) if cost > 0 else 0,
    }


def equity_of(state: dict[str, Any], quote_lookup: QuoteLookup) -> float:
    positions = [normalize_position(position, quote_lookup) for position in state.get("positions", [])]
    return round(float(state.get("cash", 0)) + sum(float(item["marketValue"]) for item in positions), 2)


def apply_paper_order(
    order: dict[str, Any],
    state: dict[str, Any],
    *,
    price: float,
    name: str,
    reasons: list[str],
) -> dict[str, Any]:
    code = str(order["code"]).zfill(6)
    quantity = int(order["quantity"])
    dry_run = bool(order.get("dryRun"))
    side = str(order["side"])
    order_record = {
        "id": len(state.get("orders", [])) + 1,
        "side": side,
        "code": code,
        "name": name,
        "quantity": quantity,
        "price": round(price, 3) if price else None,
        "status": "CHECKED" if dry_run and not reasons else "REJECTED" if reasons else "FILLED",
        "dryRun": dry_run,
        "reasons": reasons,
    }
    if dry_run or reasons:
        state.setdefault("orders", []).append(order_record)
        return order_record

    gross = price * quantity
    if side == "BUY":
        state["cash"] = round(float(state.get("cash", 0)) - gross, 2)
        existing = next((item for item in state.get("positions", []) if item["code"] == code), None)
        if existing:
            total_qty = int(existing["quantity"]) + quantity
            existing["avgPrice"] = round(
                (float(existing["avgPrice"]) * int(existing["quantity"]) + gross) / total_qty,
                3,
            )
            existing["quantity"] = total_qty
        else:
            state.setdefault("positions", []).append(
                {
                    "code": code,
                    "name": name,
                    "quantity": quantity,
                    "avgPrice": round(price, 3),
                    "lastPrice": round(price, 3),
                }
            )
    else:
        state["cash"] = round(float(state.get("cash", 0)) + gross, 2)
        next_positions = []
        for position in state.get("positions", []):
            if position["code"] != code:
                next_positions.append(position)
                continue
            remaining = int(position["quantity"]) - quantity
            if remaining > 0:
                next_positions.append({**position, "quantity": remaining, "lastPrice": round(price, 3)})
        state["positions"] = next_positions

    state.setdefault("orders", []).append(order_record)
    state.setdefault("trades", []).append({**order_record, "gross": round(gross, 2)})
    return order_record

