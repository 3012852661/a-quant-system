from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal


StrategyStage = Literal["RESEARCH", "CANDIDATE", "BACKTESTED", "PAPER_READY", "PRODUCTION_GUARDED"]
ExecutionGate = Literal["RESEARCH_ONLY", "BACKTEST_REQUIRED", "PAPER_BLOCKED", "PAPER_ALLOWED", "PRODUCTION_ALLOWED"]


@dataclass(frozen=True)
class StrategySpec:
    key: str
    name: str
    stage: StrategyStage
    enabled: bool
    market: str
    horizon: str
    source: str
    description: str
    parameters: list[str] = field(default_factory=list)
    required_data: list[str] = field(default_factory=list)
    gates: list[str] = field(default_factory=list)
    invalidation: list[str] = field(default_factory=list)
    risk_level: str = "medium"
    min_kb_level: str = "L0"
    backtest: dict[str, Any] = field(default_factory=dict)
    execution_gate: ExecutionGate = "RESEARCH_ONLY"
    gate_reasons: list[str] = field(default_factory=list)
    next_actions: list[str] = field(default_factory=list)
    quality: dict[str, Any] = field(default_factory=dict)
    promotion: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["status"] = self.stage
        return payload


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _level_rank(status: str) -> int:
    if len(status) >= 2 and status[0].upper() == "L" and status[1].isdigit():
        return int(status[1])
    return 0


def _stage_from_level(status: str) -> StrategyStage:
    rank = _level_rank(status)
    if rank >= 4:
        return "PRODUCTION_GUARDED"
    if rank >= 3:
        return "BACKTESTED"
    if rank >= 2:
        return "CANDIDATE"
    return "RESEARCH"


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def _metric(metrics: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in metrics:
            return metrics[key]
    return None


def _number(value: Any, default: float | None = None) -> float | None:
    try:
        if value in (None, "", "-"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def evaluate_backtest_gate(metrics: dict[str, Any], min_kb_level: str = "L2") -> dict[str, Any]:
    closed = int(_number(_metric(metrics, "closedTrades", "tradeCount"), 0) or 0)
    win_rate = _number(_metric(metrics, "winRatePct", "win_rate_pct"))
    average_return = _number(_metric(metrics, "averageReturnPct", "average_return_pct"))
    max_drawdown = _number(_metric(metrics, "maxDrawdownPct", "max_drawdown_pct"))
    worst_return = _number(_metric(metrics, "worstReturnPct", "worst_trade_return_pct"))

    reasons: list[str] = []
    actions: list[str] = []
    if _level_rank(min_kb_level) < 2:
        reasons.append("知识库等级低于 L2，不能进入执行层")
        actions.append("补齐 Strategy-KB 的适用场景、参数、风险和禁用条件")
    if closed < 100:
        reasons.append(f"回测样本 {closed} 笔，低于 100 笔")
        actions.append("扩大历史样本或补齐更多候选标的 K 线")
    if win_rate is None or win_rate < 50:
        reasons.append(f"胜率 {win_rate if win_rate is not None else '-'}%，低于 50%")
        actions.append("增加趋势过滤或降低追高买入")
    if average_return is None or average_return <= 0:
        reasons.append(f"平均收益 {average_return if average_return is not None else '-'}%，未超过 0")
        actions.append("优化买点、卖点和持有期")
    if max_drawdown is None or max_drawdown > 25:
        reasons.append(f"最大回撤 {max_drawdown if max_drawdown is not None else '-'}%，超过 25%")
        actions.append("加入大盘环境过滤、单票止损和组合止损")
    if worst_return is not None and worst_return < -12:
        reasons.append(f"单笔最差收益 {worst_return}%，低于 -12%")
        actions.append("收紧止损或过滤高波动标的")

    if reasons:
        gate: ExecutionGate = "PAPER_BLOCKED" if closed else "BACKTEST_REQUIRED"
        stage: StrategyStage = "BACKTESTED" if closed else "CANDIDATE"
    elif _level_rank(min_kb_level) >= 4:
        gate = "PRODUCTION_ALLOWED"
        stage = "PRODUCTION_GUARDED"
    else:
        gate = "PAPER_ALLOWED"
        stage = "PAPER_READY"
        actions.append("进入 1-3 个月 Paper Trading 连续观察")

    return {
        "stage": stage,
        "execution_gate": gate,
        "gate_reasons": reasons,
        "next_actions": sorted(set(actions)),
    }


def _quality_status(score: float, blockers: list[str]) -> str:
    if blockers:
        return "BLOCK"
    if score >= 80:
        return "PASS"
    if score >= 60:
        return "WATCH"
    return "BLOCK"


def _report_age_days(report: dict[str, Any]) -> int | None:
    value = report.get("tradeDate") or report.get("generatedAt") or report.get("finishedAt") or report.get("startedAt")
    if not value:
        return None
    date_text = str(value)[:10]
    try:
        report_date = datetime.fromisoformat(date_text)
    except ValueError:
        return None
    return max(0, (datetime.now() - report_date).days)


def evaluate_strategy_quality(
    metrics: dict[str, Any],
    *,
    min_kb_level: str = "L2",
    parameter_result: dict[str, Any] | None = None,
    performance: dict[str, Any] | None = None,
    refresh_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    closed = int(_number(_metric(metrics, "closedTrades", "tradeCount"), 0) or 0)
    win_rate = _number(_metric(metrics, "winRatePct", "win_rate_pct"))
    average_return = _number(_metric(metrics, "averageReturnPct", "average_return_pct"))
    max_drawdown = _number(_metric(metrics, "maxDrawdownPct", "max_drawdown_pct"))
    worst_return = _number(_metric(metrics, "worstReturnPct", "worst_trade_return_pct"))
    total_pnl = _number(_metric(metrics, "totalPnl"))
    parameter_summary = (parameter_result or {}).get("summary", {}) if isinstance(parameter_result, dict) else {}
    performance_summary = (performance or {}).get("summary", {}) if isinstance(performance, dict) else {}
    refresh = refresh_report or {}

    dimensions: dict[str, dict[str, Any]] = {}
    blockers: list[str] = []
    warnings: list[str] = []

    sample_score = min(100.0, closed / 300 * 100) if closed else 0.0
    if closed < 100:
        blockers.append(f"回测样本 {closed} 笔，低于 Paper 准入 100 笔")
    dimensions["sample"] = {"score": round(sample_score, 1), "closedTrades": closed, "threshold": 100}

    win_score = 0.0 if win_rate is None else max(0.0, min(100.0, (win_rate - 40) / 20 * 100))
    expectancy_score = 0.0 if average_return is None else max(0.0, min(100.0, (average_return + 0.5) / 2.5 * 100))
    expectancy = round((win_score * 0.45) + (expectancy_score * 0.55), 1)
    if win_rate is None or win_rate < 50:
        blockers.append(f"胜率 {win_rate if win_rate is not None else '-'}%，低于 50%")
    if average_return is None or average_return <= 0:
        blockers.append(f"平均收益 {average_return if average_return is not None else '-'}%，未超过 0")
    dimensions["expectancy"] = {
        "score": expectancy,
        "winRatePct": win_rate,
        "averageReturnPct": average_return,
        "totalPnl": total_pnl,
    }

    drawdown_score = 0.0 if max_drawdown is None else max(0.0, min(100.0, (40 - max_drawdown) / 25 * 100))
    tail_score = 100.0 if worst_return is None else max(0.0, min(100.0, (worst_return + 20) / 12 * 100))
    risk_score = round((drawdown_score * 0.65) + (tail_score * 0.35), 1)
    if max_drawdown is None or max_drawdown > 25:
        blockers.append(f"最大回撤 {max_drawdown if max_drawdown is not None else '-'}%，超过 25%")
    if worst_return is not None and worst_return < -12:
        blockers.append(f"单笔最差收益 {worst_return}%，低于 -12%")
    dimensions["risk"] = {
        "score": risk_score,
        "maxDrawdownPct": max_drawdown,
        "worstReturnPct": worst_return,
        "maxDrawdownThresholdPct": 25,
    }

    runs = int(_number(parameter_summary.get("runs"), 0) or 0)
    passed = int(_number(parameter_summary.get("passed"), 0) or 0)
    robustness_score = 0.0 if runs else 30.0
    if runs:
        robustness_score = min(100.0, max(0.0, (passed / max(runs, 1)) * 100 + min(20.0, runs / 3)))
    if runs and passed == 0:
        blockers.append(f"参数稳定性未通过：{runs} 组参数中 0 组过闸")
    elif not runs:
        warnings.append("尚未运行参数稳定性回测")
    dimensions["robustness"] = {
        "score": round(robustness_score, 1),
        "runs": runs,
        "passed": passed,
        "bestVariant": parameter_summary.get("bestVariant"),
        "bestScore": parameter_summary.get("bestScore"),
    }

    ready_counts = [
        int(_number(performance_summary.get("d1Ready"), 0) or 0),
        int(_number(performance_summary.get("d3Ready"), 0) or 0),
        int(_number(performance_summary.get("d5Ready"), 0) or 0),
    ]
    ready_total = sum(ready_counts)
    forward_returns = [
        _number(performance_summary.get("d1AvgReturnPct")),
        _number(performance_summary.get("d3AvgReturnPct")),
        _number(performance_summary.get("d5AvgReturnPct")),
    ]
    known_forward = [item for item in forward_returns if item is not None]
    forward_score = 25.0 if not ready_total else max(0.0, min(100.0, 50 + (sum(known_forward) / max(len(known_forward), 1)) * 20))
    if ready_total < 10:
        warnings.append(f"推荐后验样本 {ready_total} 条，暂不足以验证样本外表现")
    dimensions["forward"] = {
        "score": round(forward_score, 1),
        "ready": ready_total,
        "d1AvgReturnPct": performance_summary.get("d1AvgReturnPct"),
        "d3AvgReturnPct": performance_summary.get("d3AvgReturnPct"),
        "d5AvgReturnPct": performance_summary.get("d5AvgReturnPct"),
    }

    data_score = 100.0
    if refresh.get("ok") is False or refresh.get("criticalFailures"):
        data_score = 0.0
        blockers.append("最近一次数据刷新失败，禁止策略晋级")
    elif refresh.get("warning"):
        data_score = 60.0
        warnings.append("最近一次数据刷新存在警告")
    age_days = _report_age_days(refresh)
    if age_days is not None and age_days > 3:
        data_score = min(data_score, 40.0)
        blockers.append(f"刷新报告已 {age_days} 天未更新")
    dimensions["data"] = {
        "score": round(data_score, 1),
        "refreshStatus": refresh.get("status"),
        "refreshOk": refresh.get("ok"),
        "ageDays": age_days,
    }

    kb_score = 100.0 if _level_rank(min_kb_level) >= 2 else 20.0
    if _level_rank(min_kb_level) < 2:
        blockers.append("知识库等级低于 L2，不能进入执行层")
    dimensions["knowledge"] = {"score": kb_score, "minKbLevel": min_kb_level}

    score = (
        dimensions["sample"]["score"] * 0.15
        + dimensions["expectancy"]["score"] * 0.2
        + dimensions["risk"]["score"] * 0.25
        + dimensions["robustness"]["score"] * 0.15
        + dimensions["forward"]["score"] * 0.1
        + dimensions["data"]["score"] * 0.1
        + dimensions["knowledge"]["score"] * 0.05
    )
    blockers = sorted(set(blockers))
    warnings = sorted(set(warnings))
    return {
        "score": round(score, 1),
        "status": _quality_status(score, blockers),
        "dimensions": dimensions,
        "blockers": blockers,
        "warnings": warnings,
    }


def promotion_from_quality(quality: dict[str, Any]) -> dict[str, Any]:
    blockers = quality.get("blockers") or []
    score = _number(quality.get("score"), 0) or 0
    if blockers:
        target = "PAPER_BLOCKED"
    elif score >= 85:
        target = "PAPER_READY"
    elif score >= 70:
        target = "PAPER_WATCH"
    else:
        target = "RESEARCH_ONLY"
    return {
        "target": target,
        "score": round(score, 1),
        "required": [
            "样本>=100",
            "胜率>=50%",
            "平均收益>0",
            "最大回撤<=25%",
            "最差单笔>=-12%",
            "参数搜索至少1组过闸",
            "最近数据刷新无关键失败",
        ],
        "missing": blockers,
    }


def _frontmatter_value(text: str, key: str, fallback: str = "") -> str:
    prefix = f"{key}:"
    for line in text.splitlines():
        if line.startswith(prefix):
            return line.split(":", 1)[1].strip()
    return fallback


def _title(text: str, fallback: str) -> str:
    return next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), fallback)


def _bullets(text: str, limit: int = 5) -> list[str]:
    return [line[2:].strip() for line in text.splitlines() if line.strip().startswith("- ")][:limit]


def _knowledge_strategy_specs() -> list[StrategySpec]:
    root = repo_root() / "quant-system/knowledge/Strategy-KB"
    if not root.exists():
        return []
    specs: list[StrategySpec] = []
    for path in sorted(root.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        relative = path.relative_to(repo_root()).as_posix()
        status = _frontmatter_value(text, "status", "L0 raw")
        rank = _level_rank(status)
        bullets = _bullets(text)
        specs.append(
            StrategySpec(
                key=relative,
                name=_title(text, path.stem),
                stage=_stage_from_level(status),
                enabled=True,
                market=_frontmatter_value(text, "market", "A-share"),
                horizon=_frontmatter_value(text, "horizon", "待归一化"),
                source=relative,
                description=_frontmatter_value(text, "description", "知识库策略条目，需补齐参数、样本和禁用条件。"),
                parameters=bullets[:4],
                required_data=["market_data", "kline_cache", "risk_kb"],
                gates=["知识库L2+", "回测L3", "风控L4"] if rank >= 2 else ["仅研究引用"],
                invalidation=["缺少结构化参数", "缺少样本回测"] if rank < 3 else ["触发策略卡片禁用条件"],
                risk_level="high" if "leader" in relative.lower() or "limit" in relative.lower() else "medium",
                min_kb_level=status.split()[0],
                execution_gate="PRODUCTION_ALLOWED" if rank >= 4 else "RESEARCH_ONLY",
                gate_reasons=[] if rank >= 4 else ["知识库策略未完成本系统回测和执行闸门绑定"],
                next_actions=["运行事件回测", "绑定 Risk-KB 禁用条件"] if rank < 4 else ["进入 paper/live 前二次确认"],
            )
        )
    return specs


def builtin_strategy_specs(backtest_result: dict[str, Any] | None = None) -> list[StrategySpec]:
    metrics = (backtest_result or {}).get("metrics", {}) if isinstance(backtest_result, dict) else {}
    volume_gate = evaluate_backtest_gate(metrics, "L2")
    parameter_result = _read_json(repo_root() / "reports/data/parameter-backtest-result.json", {})
    performance = _read_json(repo_root() / "reports/data/latest-recommendation-performance.json", {})
    refresh_report = _read_json(repo_root() / "reports/data/latest-refresh-report.json", {})
    volume_quality = evaluate_strategy_quality(
        metrics,
        min_kb_level="L2",
        parameter_result=parameter_result,
        performance=performance,
        refresh_report=refresh_report,
    )
    volume_reasons = volume_quality["blockers"] or volume_gate["gate_reasons"]
    volume_actions = sorted(
        set(
            [
                *volume_gate["next_actions"],
                "先修复数据刷新失败再评估实盘候选" if volume_quality["dimensions"]["data"]["score"] == 0 else "",
                "继续参数搜索，直到至少 1 组通过准入" if volume_quality["dimensions"]["robustness"]["passed"] == 0 else "",
                "建立 1/3/5 日推荐后验样本" if volume_quality["dimensions"]["forward"]["ready"] < 10 else "",
            ]
        )
        - {""}
    )
    return [
        StrategySpec(
            key="strong_pullback",
            name="强势股回调",
            stage="CANDIDATE",
            enabled=True,
            market="A-share",
            horizon="1-3个交易日",
            source="MVP rules",
            description="把短线候选转换成买区、止损、目标位和人工复核计划。",
            parameters=["站上5/10/20日均线", "不追高开7%以上", "回踩买区确认", "非ST/非退市"],
            required_data=["latest_quotes", "kline_cache", "recommendation_gate"],
            gates=["推荐闸门", "买区", "止损线", "单票仓位"],
            invalidation=["冲高回落超过阈值", "跌破止损线", "数据审计 BLOCK"],
            risk_level="medium",
            min_kb_level="L2",
            execution_gate="BACKTEST_REQUIRED",
            gate_reasons=["该组合策略还没有独立事件回测结果"],
            next_actions=["补回测入口", "绑定买区和止损的执行规则"],
        ),
        StrategySpec(
            key="volume_breakout",
            name="放量突破",
            stage=volume_gate["stage"],
            enabled=True,
            market="A-share",
            horizon="1-3个交易日",
            source="backend/strategy/trend_breakout.py",
            description="当前实际选股主策略，筛选涨幅、量比、均线和趋势评分共同确认的强势标的。",
            parameters=["涨幅3%-7%", "量比>=1.5", "均线多头", "趋势评分>=70"],
            required_data=["A-share quotes", "daily kline", "local kline cache"],
            gates=["数据审计", "成交额/换手", "风险等级", "模拟预检"],
            invalidation=["量比不足", "均线破坏", "涨幅离开强势区间", "最新行情过期"],
            risk_level="medium",
            min_kb_level="L2",
            backtest={
                "winRatePct": _metric(metrics, "winRatePct", "win_rate_pct"),
                "maxDrawdownPct": _metric(metrics, "maxDrawdownPct", "max_drawdown_pct"),
                "averageReturnPct": _metric(metrics, "averageReturnPct", "average_return_pct"),
                "tradeCount": _metric(metrics, "tradeCount", "closedTrades"),
                "worstReturnPct": _metric(metrics, "worstReturnPct", "worst_trade_return_pct"),
                "totalPnl": _metric(metrics, "totalPnl"),
            },
            execution_gate=volume_gate["execution_gate"],
            gate_reasons=volume_reasons,
            next_actions=volume_actions,
            quality=volume_quality,
            promotion=promotion_from_quality(volume_quality),
        ),
        StrategySpec(
            key="limit_pullback",
            name="涨停后低吸",
            stage="RESEARCH",
            enabled=True,
            market="A-share",
            horizon="1-5个交易日",
            source="quant-system/knowledge/Strategy-KB/leader/Limit-Up-Leader.md",
            description="涨停后不追板，等待开板承接或回踩确认，后续补事件驱动回测。",
            parameters=["涨停后不追板", "回踩5日线", "开板承接", "高波动降仓"],
            required_data=["limit_up_events", "intraday_quotes", "kline_cache", "sentiment_cycle"],
            gates=["情绪周期", "一字板过滤", "开板次数", "流动性"],
            invalidation=["一字板无法成交", "开板次数过多", "题材退潮"],
            risk_level="high",
            min_kb_level="L2",
            execution_gate="BACKTEST_REQUIRED",
            gate_reasons=["尚未完成事件驱动回测"],
            next_actions=["补涨停事件样本", "加入开板次数和情绪周期过滤"],
        ),
    ]


def build_strategy_registry() -> dict[str, Any]:
    backtest_result = _read_json(repo_root() / "reports/data/event-backtest-result.json", {})
    if not backtest_result:
        backtest_result = _read_json(repo_root() / "reports/data/backtest-result.json", {})
    builtin = builtin_strategy_specs(backtest_result)
    knowledge = _knowledge_strategy_specs()
    rows = [item.to_dict() for item in [*builtin, *knowledge]]
    quality_rows = [item for item in rows if item.get("quality")]
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "method": "builtin StrategySpec + Strategy-KB markdown scan",
        "summary": {
            "total": len(rows),
            "enabled": sum(1 for item in rows if item["enabled"]),
            "knowledgeStrategies": len(knowledge),
            "backtested": sum(1 for item in rows if item["stage"] in ("BACKTESTED", "PAPER_READY", "PRODUCTION_GUARDED")),
            "paperAllowed": sum(1 for item in rows if item["execution_gate"] in ("PAPER_ALLOWED", "PRODUCTION_ALLOWED")),
            "paperBlocked": sum(1 for item in rows if item["execution_gate"] == "PAPER_BLOCKED"),
            "productionReady": sum(1 for item in rows if item["stage"] == "PRODUCTION_GUARDED"),
            "qualityBlocked": sum(1 for item in quality_rows if item["quality"].get("status") == "BLOCK"),
            "averageQualityScore": round(
                sum(float(item["quality"].get("score", 0)) for item in quality_rows) / len(quality_rows),
                1,
            )
            if quality_rows
            else None,
        },
        "rows": rows,
    }
