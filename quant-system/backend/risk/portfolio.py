from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


RiskSeverity = Literal["INFO", "WARN", "BLOCK"]


@dataclass(frozen=True)
class RiskPolicy:
    max_position_pct: float = 18.0
    max_total_exposure_pct: float = 65.0
    max_positions: int = 6
    max_order_pct: float = 12.0
    max_price_deviation_pct: float = 4.0
    stop_loss_pct: float = -8.0


DEFAULT_POLICY = RiskPolicy()


def _round_pct(value: float) -> float:
    return round(value, 2)


def _cash(state: dict) -> float:
    return float(state.get("cash", 0) or 0)


def portfolio_snapshot(state: dict, positions: list[dict], policy: RiskPolicy = DEFAULT_POLICY) -> dict:
    equity = _cash(state) + sum(float(item.get("marketValue", 0) or 0) for item in positions)
    exposure = sum(float(item.get("marketValue", 0) or 0) for item in positions)
    exposure_pct = (exposure / equity * 100) if equity > 0 else 0.0
    largest = max(positions, key=lambda item: float(item.get("marketValue", 0) or 0), default=None)
    largest_pct = (float(largest.get("marketValue", 0) or 0) / equity * 100) if largest and equity > 0 else 0.0
    position_rows = [
        {
            "code": item.get("code"),
            "name": item.get("name"),
            "weightPct": _round_pct(float(item.get("marketValue", 0) or 0) / equity * 100) if equity > 0 else 0,
            "unrealizedPct": float(item.get("unrealizedPct", 0) or 0),
        }
        for item in positions
    ]
    warnings: list[dict] = []
    if exposure_pct > policy.max_total_exposure_pct:
        warnings.append(
            {
                "severity": "BLOCK",
                "message": f"总仓位 {_round_pct(exposure_pct)}% 超过上限 {policy.max_total_exposure_pct:.0f}%",
            }
        )
    elif exposure_pct > policy.max_total_exposure_pct * 0.85:
        warnings.append(
            {
                "severity": "WARN",
                "message": f"总仓位 {_round_pct(exposure_pct)}% 接近上限 {policy.max_total_exposure_pct:.0f}%",
            }
        )
    if largest and largest_pct > policy.max_position_pct:
        warnings.append(
            {
                "severity": "BLOCK",
                "message": f"{largest.get('name') or largest.get('code')} 单票仓位 {_round_pct(largest_pct)}% 超过上限 {policy.max_position_pct:.0f}%",
            }
        )
    if len(positions) > policy.max_positions:
        warnings.append(
            {
                "severity": "WARN",
                "message": f"持仓数量 {len(positions)} 只，超过建议上限 {policy.max_positions} 只",
            }
        )
    for row in position_rows:
        if row["unrealizedPct"] <= policy.stop_loss_pct:
            warnings.append(
                {
                    "severity": "WARN",
                    "message": f"{row['name'] or row['code']} 浮亏 {row['unrealizedPct']:.2f}%，触发止损复核",
                }
            )
    return {
        "policy": {
            "maxPositionPct": policy.max_position_pct,
            "maxTotalExposurePct": policy.max_total_exposure_pct,
            "maxPositions": policy.max_positions,
            "maxOrderPct": policy.max_order_pct,
            "maxPriceDeviationPct": policy.max_price_deviation_pct,
            "stopLossPct": policy.stop_loss_pct,
        },
        "exposurePct": _round_pct(exposure_pct),
        "largestPositionPct": _round_pct(largest_pct),
        "positionCount": len(positions),
        "cashPct": _round_pct((_cash(state) / equity * 100) if equity > 0 else 0),
        "positions": position_rows,
        "warnings": warnings,
        "status": "BLOCK" if any(item["severity"] == "BLOCK" for item in warnings) else "WARN" if warnings else "OK",
    }


def _position_after_order(state: dict, order: dict, price: float, positions: list[dict]) -> list[dict]:
    code = str(order["code"]).zfill(6)
    quantity = int(order["quantity"])
    side = order["side"]
    next_positions: list[dict] = []
    touched = False
    for item in positions:
        if item["code"] != code:
            next_positions.append(item)
            continue
        touched = True
        if side == "BUY":
            next_qty = int(item["quantity"]) + quantity
            current_cost = float(item["avgPrice"]) * int(item["quantity"])
            avg_price = (current_cost + price * quantity) / next_qty
            next_positions.append({**item, "quantity": next_qty, "avgPrice": avg_price, "lastPrice": price})
        else:
            next_qty = int(item["quantity"]) - quantity
            if next_qty > 0:
                next_positions.append({**item, "quantity": next_qty, "lastPrice": price})
    if side == "BUY" and not touched:
        next_positions.append(
            {
                "code": code,
                "name": order.get("name") or code,
                "quantity": quantity,
                "avgPrice": price,
                "lastPrice": price,
            }
        )
    return next_positions


def order_risk_reasons(
    order: dict,
    state: dict,
    positions: list[dict],
    price: float,
    quote_price: float | None,
    policy: RiskPolicy = DEFAULT_POLICY,
) -> list[str]:
    if order["side"] != "BUY" or price <= 0:
        return []
    equity = _cash(state) + sum(float(item.get("marketValue", 0) or 0) for item in positions)
    if equity <= 0:
        return ["账户权益异常，禁止开仓"]

    reasons: list[str] = []
    gross = price * int(order["quantity"])
    order_pct = gross / equity * 100
    if order_pct > policy.max_order_pct:
        reasons.append(f"单笔委托占权益 {order_pct:.2f}%，超过上限 {policy.max_order_pct:.0f}%")
    if quote_price and quote_price > 0:
        deviation = abs(price / quote_price - 1) * 100
        if deviation > policy.max_price_deviation_pct:
            reasons.append(f"委托价偏离最新价 {deviation:.2f}%，超过上限 {policy.max_price_deviation_pct:.0f}%")

    simulated_state = {**state, "cash": _cash(state) - gross}
    simulated_positions = _position_after_order(state, order, price, positions)
    normalized = []
    for item in simulated_positions:
        last_price = price if item["code"] == str(order["code"]).zfill(6) else float(item.get("lastPrice") or item["avgPrice"])
        market_value = last_price * int(item["quantity"])
        cost = float(item["avgPrice"]) * int(item["quantity"])
        normalized.append(
            {
                **item,
                "lastPrice": last_price,
                "marketValue": market_value,
                "unrealizedPct": (market_value / cost - 1) * 100 if cost > 0 else 0,
            }
        )
    snapshot = portfolio_snapshot(simulated_state, normalized, policy)
    for warning in snapshot["warnings"]:
        if warning["severity"] == "BLOCK":
            reasons.append(warning["message"])
    if snapshot["positionCount"] > policy.max_positions:
        reasons.append(f"买入后持仓数量 {snapshot['positionCount']} 只，超过上限 {policy.max_positions} 只")
    return reasons
