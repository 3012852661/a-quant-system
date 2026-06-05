from __future__ import annotations

from quant.agents.base import AgentDecision, AgentInput, AgentStatus


class DataAgent:
    name = "数据Agent"

    REQUIRED_FIELDS = (
        "code",
        "name",
        "price",
        "pct_chg",
        "turnover",
        "volume_ratio",
        "market_cap",
        "score",
    )

    def evaluate(self, item: AgentInput) -> AgentDecision:
        missing = [field for field in self.REQUIRED_FIELDS if item.stock.get(field) in (None, "")]
        if missing:
            return AgentDecision(
                agent=self.name,
                status=AgentStatus.BLOCK,
                score=0,
                reasons=[f"缺少真实行情字段：{', '.join(missing)}"],
                data_source="akshare.stock_zh_a_spot_em",
            )
        return AgentDecision(
            agent=self.name,
            status=AgentStatus.PASS,
            score=100,
            reasons=["实时行情字段完整"],
            data_source="akshare.stock_zh_a_spot_em",
        )
