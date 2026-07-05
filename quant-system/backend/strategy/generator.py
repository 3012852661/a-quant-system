from __future__ import annotations

from datetime import datetime
from typing import Any


def generate_strategy_variants(base_key: str, review: dict[str, Any]) -> list[dict[str, Any]]:
    rows = review.get("rows", [])
    target = next((item for item in rows if item.get("key") == base_key), {})
    reasons = target.get("gate_reasons", [])
    variants = [
        {
            "key": f"{base_key}.defensive",
            "name": "放量突破 - 防守版",
            "thesis": "降低单票风险和持有期暴露，优先观察是否能压低极端回撤。",
            "parameters": {
                "hold_days": [1, 2, 3],
                "max_position_pct": [4, 6, 8],
                "slippage_bps": [10],
                "max_volume_pct": [0.01, 0.02],
                "limit_pct": [9.8],
                "stop_loss_pct": [4, 5, 6],
                "min_volume_ratio": [1.5, 2.0],
                "max_twenty_day_pct": [20, 30, 45],
            },
            "filters": ["降低仓位", "缩短持有期", "收紧止损", "限制过热涨幅"],
        },
        {
            "key": f"{base_key}.liquidity",
            "name": "放量突破 - 流动性版",
            "thesis": "用更严格成交参与率和滑点假设检验策略是否依赖不可实现成交。",
            "parameters": {
                "hold_days": [2, 3, 5],
                "max_position_pct": [5, 8],
                "slippage_bps": [15, 25],
                "max_volume_pct": [0.005, 0.01],
                "limit_pct": [9.8],
                "stop_loss_pct": [4, 5, 6],
                "min_volume_ratio": [1.8, 2.2],
                "max_twenty_day_pct": [20, 30, 45],
            },
            "filters": ["更低成交参与率", "更高滑点", "更强放量确认", "检验流动性脆弱性"],
        },
        {
            "key": f"{base_key}.swing",
            "name": "放量突破 - 波段版",
            "thesis": "延长持有期，测试短线追涨是否需要更多时间消化波动。",
            "parameters": {
                "hold_days": [3, 5, 8],
                "max_position_pct": [4, 6],
                "slippage_bps": [10, 15],
                "max_volume_pct": [0.01],
                "limit_pct": [9.8],
                "stop_loss_pct": [4, 5, 6],
                "min_volume_ratio": [1.5, 2.0],
                "max_twenty_day_pct": [20, 30, 45],
            },
            "filters": ["延长持有期", "低仓位", "止损保护", "观察收益右尾是否覆盖回撤"],
        },
    ]
    return [
        {
            **item,
            "baseKey": base_key,
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "inputGateReasons": reasons,
        }
        for item in variants
    ]
