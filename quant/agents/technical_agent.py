from __future__ import annotations

from quant.agents.base import AgentDecision, AgentInput, AgentStatus


class TechnicalAnalysisAgent:
    name = "技术分析Agent"

    def evaluate(self, item: AgentInput) -> AgentDecision:
        stock = item.stock
        score = float(stock.get("score", 0))
        reasons = [
            f"涨幅 {stock.get('pct_chg')}%",
            f"换手率 {stock.get('turnover')}%",
            f"量比 {stock.get('volume_ratio')}",
            f"策略分 {score}",
        ]
        if score <= 0:
            return AgentDecision(self.name, AgentStatus.BLOCK, 0, ["技术评分无效"], "akshare.stock_zh_a_spot_em")
        status = AgentStatus.PASS if score >= 25 else AgentStatus.WARN
        return AgentDecision(self.name, status, score, reasons, "akshare.stock_zh_a_spot_em")
