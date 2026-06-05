from __future__ import annotations

from quant.agents.base import AgentDecision, AgentInput, AgentStatus


class RiskAgent:
    name = "风控Agent"

    def evaluate(self, item: AgentInput) -> AgentDecision:
        stock = item.stock
        risks: list[str] = []
        pct_chg = float(stock.get("pct_chg", 0))
        turnover = float(stock.get("turnover", 0))
        volume_ratio = float(stock.get("volume_ratio", 0))

        if pct_chg >= 6.8:
            risks.append("接近涨幅上沿，追高风险较高")
        if turnover >= 15:
            risks.append("换手率偏高，短线分歧较大")
        if volume_ratio >= 4:
            risks.append("量比过高，可能存在情绪拥挤")

        if risks:
            return AgentDecision(self.name, AgentStatus.WARN, 60, risks, "akshare.stock_zh_a_spot_em")
        return AgentDecision(self.name, AgentStatus.PASS, 90, ["未触发基础风控警告"], "akshare.stock_zh_a_spot_em")
