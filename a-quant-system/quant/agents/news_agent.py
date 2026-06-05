from __future__ import annotations

from quant.agents.base import AgentDecision, AgentInput, AgentStatus


class NewsAgent:
    name = "新闻Agent"

    def evaluate(self, item: AgentInput) -> AgentDecision:
        news_items = item.context.get("news_items")
        if not news_items:
            return AgentDecision(
                agent=self.name,
                status=AgentStatus.NO_DATA,
                score=0,
                reasons=["尚未接入真实新闻源，不能生成新闻判断"],
                data_source="not-configured",
            )
        return AgentDecision(
            agent=self.name,
            status=AgentStatus.PASS,
            score=0,
            reasons=["已接入新闻源，待实现情绪和事件打分"],
            data_source=str(item.context.get("news_source", "unknown")),
        )
