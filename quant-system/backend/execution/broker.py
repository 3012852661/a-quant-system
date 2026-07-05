from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class BrokerOrder:
    side: str
    code: str
    quantity: int
    price: float | None = None
    name: str | None = None
    client_order_id: str | None = None


class BrokerAdapter(Protocol):
    name: str
    mode: str

    def preflight(self, order: BrokerOrder) -> dict[str, Any]:
        ...

    def submit_order(self, order: BrokerOrder) -> dict[str, Any]:
        ...


class DisabledLiveBroker:
    name = "disabled-live-broker"
    mode = "DISABLED"

    def preflight(self, order: BrokerOrder) -> dict[str, Any]:
        return {
            "ok": False,
            "status": "BLOCKED",
            "broker": self.name,
            "mode": self.mode,
            "reason": "实盘 broker adapter 未启用；当前系统只允许 PAPER / dry-run。",
            "order": order.__dict__,
        }

    def submit_order(self, order: BrokerOrder) -> dict[str, Any]:
        return self.preflight(order)


def get_live_broker() -> BrokerAdapter:
    return DisabledLiveBroker()

