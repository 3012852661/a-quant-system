from __future__ import annotations

from quant.agents import (
    AgentDecision,
    AgentInput,
    DataAgent,
    FundamentalAgent,
    NewsAgent,
    RiskAgent,
    TechnicalAnalysisAgent,
    TradeAgent,
)
from quant.agents.base import AgentStatus


AGENTS = (
    DataAgent(),
    NewsAgent(),
    TechnicalAnalysisAgent(),
    FundamentalAgent(),
    RiskAgent(),
    TradeAgent(),
)


def evaluate_stock(trade_date: str, stock: dict, context: dict | None = None) -> list[AgentDecision]:
    item = AgentInput(trade_date=trade_date, stock=stock, context=context or {})
    return [agent.evaluate(item) for agent in AGENTS]


def final_research_status(decisions: list[AgentDecision]) -> AgentStatus:
    if any(decision.status == AgentStatus.BLOCK for decision in decisions):
        return AgentStatus.BLOCK
    if any(decision.status == AgentStatus.WARN for decision in decisions):
        return AgentStatus.WARN
    return AgentStatus.PASS


def summarize_decisions(decisions: list[AgentDecision]) -> dict:
    return {
        "status": final_research_status(decisions).value,
        "agents": [
            {
                "agent": decision.agent,
                "status": decision.status.value,
                "score": decision.score,
                "reasons": decision.reasons,
                "data_source": decision.data_source,
            }
            for decision in decisions
        ],
    }
