from __future__ import annotations

from quant.agents.base import AgentDecision, AgentInput, AgentStatus


class FundamentalAgent:
    name = "基本面Agent"

    def evaluate(self, item: AgentInput) -> AgentDecision:
        fundamentals = item.context.get("fundamentals")
        if not fundamentals:
            return AgentDecision(
                agent=self.name,
                status=AgentStatus.NO_DATA,
                score=0,
                reasons=["尚未接入真实财务数据，不能生成基本面判断"],
                data_source="not-configured",
            )
        return AgentDecision(
            agent=self.name,
            status=AgentStatus.PASS,
            score=0,
            reasons=["已接入基本面数据，待实现估值和质量打分"],
            data_source=str(item.context.get("fundamental_source", "unknown")),
        )
