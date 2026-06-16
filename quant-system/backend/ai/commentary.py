from __future__ import annotations

from backend.config import settings
from backend.data.models import StockSignal


def build_rule_comment(signal: StockSignal) -> str:
    risk_note = {
        "低": "形态较顺，仍需等待次日承接确认。",
        "中": "强度不错，但追高风险开始抬升，适合等回踩确认。",
        "高": "短线拥挤或涨幅偏高，仓位要轻，避免情绪高点接力。",
    }[signal.risk_level]
    return (
        f"{signal.name}趋势评分{signal.trend_score}，量能放大{signal.volume_ratio}倍；"
        f"{'，'.join(signal.reasons[:3])}。{risk_note}"
    )


def enrich_with_openai(signal: StockSignal) -> StockSignal:
    if not settings.openai_api_key:
        return signal

    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key)
    prompt = (
        "你是A股短线量化研究助手。基于以下信号给出80字以内点评，"
        "必须包含机会、风险和操作纪律，不得承诺收益。\n"
        f"股票：{signal.code} {signal.name}\n"
        f"价格：{signal.current_price}\n"
        f"涨幅：{signal.pct}%\n"
        f"量能放大：{signal.volume_ratio}倍\n"
        f"趋势评分：{signal.trend_score}\n"
        f"风险等级：{signal.risk_level}\n"
        f"触发原因：{'；'.join(signal.reasons)}"
    )
    response = client.responses.create(
        model=settings.openai_model,
        input=prompt,
    )
    signal.ai_comment = response.output_text.strip() or signal.ai_comment
    return signal
