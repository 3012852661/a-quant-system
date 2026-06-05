from __future__ import annotations

from quant.agents.base import AgentDecision, AgentInput, AgentStatus


class TradeAgent:
    name = "交易Agent"

    def evaluate(self, item: AgentInput) -> AgentDecision:
        mode = item.context.get("mode", "research")
        if mode != "live":
            return AgentDecision(
                agent=self.name,
                status=AgentStatus.NO_DATA,
                score=0,
                reasons=["当前为研究/回测阶段，禁止实盘下单"],
                data_source="local-config",
            )
        broker = item.context.get("broker")
        if not broker:
            return AgentDecision(
                agent=self.name,
                status=AgentStatus.BLOCK,
                score=0,
                reasons=["实盘模式未配置券商/交易接口"],
                data_source="local-config",
            )
        return AgentDecision(
            agent=self.name,
            status=AgentStatus.BLOCK,
            score=0,
            reasons=["交易接口已配置但下单逻辑尚未启用"],
            data_source=str(broker),
        )
