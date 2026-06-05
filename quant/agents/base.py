from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AgentStatus(str, Enum):
    PASS = "PASS"
    WARN = "WARN"
    BLOCK = "BLOCK"
    NO_DATA = "NO_DATA"


@dataclass(frozen=True)
class AgentInput:
    trade_date: str
    stock: dict[str, Any]
    context: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AgentDecision:
    agent: str
    status: AgentStatus
    score: float
    reasons: list[str]
    data_source: str

    @property
    def tradable(self) -> bool:
        return self.status in {AgentStatus.PASS, AgentStatus.WARN}
