from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.agent_gateway import agent_capabilities, append_agent_audit
from backend.ai.commentary import enrich_with_openai
from backend.backtest.simple_backtest import run_hold_days_backtest
from backend.config import settings
from backend.data.models import StockQuote, StockSignal
from backend.data.providers import (
    CninfoAnnouncementProvider,
    EastMoneyMoneyFlowProvider,
    ProviderUnavailable,
    ReportFallbackProvider,
    TushareProvider,
    data_source_status,
    get_provider,
)
from backend.execution.audit import append_execution_audit
from backend.execution.paper import (
    apply_paper_order,
    default_trade_state as paper_default_trade_state,
    equity_of as paper_equity_of,
    normalize_position as paper_normalize_position,
)
from backend.risk.portfolio import order_risk_reasons, portfolio_snapshot
from backend.scheduler.jobs import create_scheduler, run_daily_selection
from backend.strategy.registry import build_strategy_registry
from backend.strategy.trend_breakout import run_trend_breakout

app = FastAPI(title="A股量化选股系统", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_INTRADAY_QUOTE_AGE_MINUTES = 2
MAX_PRICE_DIVERGENCE_PCT = 0.5


class OrderRequest(BaseModel):
    side: str = Field(pattern="^(BUY|SELL)$")
    code: str
    name: str | None = None
    quantity: int = Field(gt=0)
    price: float | None = Field(default=None, gt=0)
    dryRun: bool = False


class AgentPreflightRequest(BaseModel):
    side: str = Field(pattern="^(BUY|SELL)$")
    code: str
    name: str | None = None
    quantity: int = Field(gt=0)
    price: float | None = Field(default=None, gt=0)
    strategyKey: str | None = None
    rationale: str | None = None


def default_trade_state() -> dict:
    return paper_default_trade_state()

if settings.enable_scheduler:
    scheduler = create_scheduler()

    @app.on_event("startup")
    def start_scheduler() -> None:
        scheduler.start()

    @app.on_event("shutdown")
    def stop_scheduler() -> None:
        scheduler.shutdown(wait=False)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "quant-system"}


@app.get("/api/data-sources")
def data_sources() -> dict:
    return {
        "primaryProvider": settings.data_provider,
        "allowReportFallback": settings.allow_report_fallback,
        "stack": settings.data_source_stack,
        "sources": data_source_status(),
        "storage": {
            "structured": "postgresql" if settings.database_url else "sqlite",
            "databaseUrlConfigured": bool(settings.database_url),
            "vectorProvider": settings.vector_database_provider,
            "vectorUrlConfigured": bool(settings.vector_database_url),
        },
    }


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def read_json_report(relative_path: str, fallback: Any) -> Any:
    path = repo_root() / relative_path
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json_report(relative_path: str, payload: Any) -> None:
    path = repo_root() / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def latest_rows() -> list[dict]:
    scan = read_json_report("reports/data/latest-free-a-share-scan.brief.json", {})
    live_quotes = read_json_report("reports/data/live-tencent-candidate-quotes.json", {})
    rows: list[dict] = []
    if isinstance(live_quotes.get("rows"), list):
        rows.extend(live_quotes["rows"])
    for key in ("newLimitUps", "strongToLimit", "newStrong"):
        rows.extend(read_json_report("reports/data/latest-open-limit-watch.json", {}).get(key, []))
    for key in ("limitUpPool", "strongNotLimit", "fundTop", "attack", "watch", "avoid"):
        value = scan.get(key, [])
        if isinstance(value, list):
            rows.extend(value)
    seen: set[str] = set()
    unique: list[dict] = []
    for row in rows:
        code = str(row.get("code", "")).zfill(6)
        if code and code not in seen:
            seen.add(code)
            unique.append(row)
    return unique


def latest_quote(code: str) -> dict | None:
    normalized = code.zfill(6)
    return next((row for row in latest_rows() if str(row.get("code", "")).zfill(6) == normalized), None)


def tencent_time(value: Any) -> str:
    text = str(value or "")
    if len(text) == 14 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}T{text[8:10]}:{text[10:12]}:{text[12:14]}+08:00"
    return ""


def shanghai_minutes_now() -> int:
    now = datetime.now(timezone.utc).astimezone()
    return now.hour * 60 + now.minute


def is_a_share_trading_time() -> bool:
    minutes = shanghai_minutes_now()
    return (9 * 60 + 30 <= minutes <= 11 * 60 + 30) or (13 * 60 <= minutes <= 15 * 60)


def minutes_since(value: Any) -> float:
    text = str(value or "")
    if not text:
        return float("inf")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        converted = tencent_time(text)
        if not converted:
            return float("inf")
        parsed = datetime.fromisoformat(converted)
    return max(0.0, (datetime.now(timezone.utc) - parsed.astimezone(timezone.utc)).total_seconds() / 60)


def latest_live_quote_time() -> str:
    live_quotes = read_json_report("reports/data/live-tencent-candidate-quotes.json", {})
    times = [tencent_time(row.get("time")) for row in live_quotes.get("rows", []) if tencent_time(row.get("time"))]
    return sorted(times)[-1] if times else ""


def trade_state() -> dict:
    state = read_json_report("reports/data/trade-ops-state.json", default_trade_state())
    base = default_trade_state()
    base.update(state)
    return base


def normalize_position(position: dict) -> dict:
    return paper_normalize_position(position, latest_quote)


def equity_of(state: dict) -> float:
    return paper_equity_of(state, latest_quote)


def trade_gate_reasons(order: OrderRequest, state: dict, recommendation: dict) -> list[str]:
    reasons: list[str] = []
    code = order.code.zfill(6)
    quote = latest_quote(code) or {}
    quote_price = float(quote.get("price") or 0)
    price = float(order.price or quote_price or 0)
    positions = [normalize_position(position) for position in state.get("positions", [])]
    refresh_report = read_json_report("reports/data/latest-refresh-report.json", {})
    latest_live_time = latest_live_quote_time()
    if order.quantity % 100 != 0:
        reasons.append("A股委托数量必须为100股整数倍")
    if order.side == "BUY":
        if refresh_report.get("warning"):
            reasons.append("最近一次刷新存在数据源警告，禁止新增买入")
        if refresh_report.get("ok") is False or refresh_report.get("criticalFailures"):
            reasons.append("最近一次刷新存在关键失败，禁止新增买入")
        if not quote:
            reasons.append("缺少该标的今日实时行情，禁止新增买入")
        if latest_live_time and is_a_share_trading_time():
            quote_age = minutes_since(latest_live_time)
            if quote_age > MAX_INTRADAY_QUOTE_AGE_MINUTES:
                reasons.append(f"盘中行情已 {quote_age:.1f} 分钟未更新，禁止新增买入")
        if not recommendation.get("liveBuyAllowed", False):
            reasons.append("推荐闸门未打开，禁止新增买入")
        trade_codes = {str(item.get("code", "")).zfill(6) for item in recommendation.get("recommendedBuys", [])}
        if trade_codes and code not in trade_codes:
            reasons.append("标的不在可买清单")
        if not price:
            reasons.append("缺少可用价格")
        if price and quote_price:
            divergence = abs(price / quote_price - 1) * 100
            if divergence > MAX_PRICE_DIVERGENCE_PCT:
                reasons.append(f"委托价与实时价偏差 {divergence:.2f}%，超过 {MAX_PRICE_DIVERGENCE_PCT}%")
        if price * order.quantity > float(state.get("cash", 0)):
            reasons.append("现金不足")
        if price:
            reasons.extend(
                order_risk_reasons(
                    order.model_dump(),
                    state,
                    positions,
                    price,
                    quote_price if quote_price else None,
                )
            )
    else:
        position = next((item for item in state.get("positions", []) if item["code"] == code), None)
        if not position:
            reasons.append("没有可卖持仓")
        elif order.quantity > int(position["quantity"]):
            reasons.append("卖出数量超过持仓")
    return reasons


def execute_order(order: OrderRequest, state: dict, recommendation: dict) -> dict:
    code = order.code.zfill(6)
    quote = latest_quote(code) or {}
    price = float(order.price or quote.get("price") or 0)
    name = order.name or quote.get("name") or code
    reasons = trade_gate_reasons(order, state, recommendation)
    return apply_paper_order(order.model_dump(), state, price=price, name=name, reasons=reasons)


def report_status(relative_path: str) -> dict:
    path = repo_root() / relative_path
    if not path.exists():
        return {"path": relative_path, "exists": False, "size": 0, "updatedAt": None}
    stat = path.stat()
    return {
        "path": relative_path,
        "exists": True,
        "size": stat.st_size,
        "updatedAt": stat.st_mtime,
    }


def read_jsonl_tail(relative_path: str, limit: int = 40) -> list[dict]:
    path = repo_root() / relative_path
    try:
        lines = path.read_text(encoding="utf-8").splitlines()[-limit:]
    except FileNotFoundError:
        return []
    rows: list[dict] = []
    for line in lines:
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def metric_value(metrics: dict, *keys: str) -> Any:
    for key in keys:
        if key in metrics:
            return metrics[key]
    return None


def build_strategy_center(backtest_result: dict, signals: dict, recommendation: dict) -> dict:
    metrics = backtest_result.get("metrics", {}) if isinstance(backtest_result, dict) else {}
    trade_ready = int(signals.get("stats", {}).get("tradeReady") or len(signals.get("trade", []) or []))
    rows = [
        {
            "key": "strong_pullback",
            "name": "强势股回调",
            "enabled": True,
            "status": "SEED",
            "horizon": "1-3个交易日",
            "source": "MVP 规则策略",
            "winRatePct": None,
            "maxDrawdownPct": None,
            "parameters": ["站上5/10/20日均线", "不追高开7%以上", "回踩买区确认", "非ST/非退市"],
            "gates": ["推荐闸门", "买区", "止损线", "单票仓位"],
            "note": "第一版主策略，用于把候选股转成买区、止损和人工确认计划。",
        },
        {
            "key": "volume_breakout",
            "name": "放量突破",
            "enabled": True,
            "status": "TESTED" if metric_value(metrics, "tradeCount", "closedTrades") else "ACTIVE",
            "horizon": recommendation.get("holdingPeriod") or "1-3个交易日",
            "source": "backend/strategy/trend_breakout.py",
            "winRatePct": metric_value(metrics, "winRatePct", "win_rate_pct"),
            "maxDrawdownPct": metric_value(metrics, "maxDrawdownPct", "max_drawdown_pct"),
            "parameters": ["涨幅3%-7%", "量比>=1.5", "均线多头", "趋势评分>=70"],
            "gates": ["数据审计", "成交额/换手", "风险等级", "模拟预检"],
            "note": "当前实际选股主策略，负责输出股票池、推荐雷达和回测样本。",
        },
        {
            "key": "limit_pullback",
            "name": "涨停后低吸",
            "enabled": False,
            "status": "PLANNED",
            "horizon": "1-5个交易日",
            "source": "knowledge/Strategy-KB/leader/Limit-Up-Leader.md",
            "winRatePct": None,
            "maxDrawdownPct": None,
            "parameters": ["涨停后不追板", "回踩5日线", "开板承接", "高波动降仓"],
            "gates": ["情绪周期", "一字板过滤", "开板次数", "流动性"],
            "note": "已在知识库建档，后续补回测脚本和 L3 指标后再启用。",
        },
    ]
    return {
        "summary": {
            "enabled": sum(1 for item in rows if item["enabled"]),
            "planned": sum(1 for item in rows if not item["enabled"]),
            "knowledgeStrategies": 0,
            "tradeReady": trade_ready,
            "productionReady": 0,
        },
        "rows": rows,
    }


def build_backtest_review(backtest_result: dict, paper_state: dict) -> dict:
    metrics = backtest_result.get("metrics", {}) if isinstance(backtest_result, dict) else {}
    trades = backtest_result.get("trades", []) if isinstance(backtest_result.get("trades", []), list) else []
    closed_trades = int(metric_value(metrics, "closedTrades", "tradeCount") or len(trades))
    return {
        "metrics": {
            "closedTrades": closed_trades,
            "buyCount": metric_value(metrics, "buyCount"),
            "winRatePct": metric_value(metrics, "winRatePct", "win_rate_pct"),
            "maxDrawdownPct": metric_value(metrics, "maxDrawdownPct", "max_drawdown_pct"),
            "averageReturnPct": metric_value(metrics, "averageReturnPct", "average_return_pct"),
            "totalReturnPct": metric_value(metrics, "totalReturnPct", "total_return_pct"),
            "profitLossRatio": metric_value(metrics, "profitLossRatio", "profit_loss_ratio"),
            "paperTotalReturnPct": paper_state.get("metrics", {}).get("totalReturnPct"),
            "paperOpenExposurePct": paper_state.get("metrics", {}).get("openExposurePct"),
        },
        "sampleReady": closed_trades >= 20,
        "rules": [
            {"label": "T+1", "status": "PLANNED", "detail": "后续回测引擎需禁止当日买入当日卖出。"},
            {"label": "涨跌停", "status": "PLANNED", "detail": "需模拟涨停买不进、跌停卖不出。"},
            {"label": "手续费/印花税", "status": "PLANNED", "detail": "当前简易持有期回测未完全计入真实交易成本。"},
            {"label": "滑点", "status": "PLANNED", "detail": "后续按成交额与波动率引入动态滑点。"},
            {"label": "成交量不足", "status": "PLANNED", "detail": "需要限制单笔成交额占当日成交额比例。"},
        ],
        "recentTrades": trades[:12],
    }


def persisted_stock_signals(limit: int = 30) -> list[StockSignal]:
    payload = read_json_report("quant-system/backend/data/stock_pool_latest.json", {})
    rows = payload.get("signals", []) if isinstance(payload, dict) else []
    signals: list[StockSignal] = []
    for row in rows[:limit]:
        try:
            signal = StockSignal(
                code=str(row.get("code", "")).zfill(6),
                name=str(row.get("name", "")),
                current_price=float(row.get("current_price") or row.get("price") or 0),
                pct=float(row.get("pct_chg") or row.get("pct") or 0),
                volume_ratio=float(row.get("volume_ratio") or row.get("volumeRatio") or 0),
                trend_score=float(row.get("score") or row.get("trend_score") or 0),
                risk_level=row.get("risk_level") or "中",
                ai_comment=str(row.get("ai_comment") or ""),
                reasons=list(row.get("reasons") or []),
            )
        except (TypeError, ValueError):
            continue
        if signal.code and signal.name:
            signals.append(signal)
    return signals


def persisted_stock_signal(code: str) -> StockSignal | None:
    normalized = code.zfill(6)
    return next((signal for signal in persisted_stock_signals(100) if signal.code == normalized), None)


def mark_degraded_response(response: Response, source: str) -> None:
    response.headers["X-Quant-Degraded"] = "true"
    response.headers["X-Quant-Data-Source"] = source
    response.headers["X-Quant-Warning"] = "live market provider unavailable"


def market_data_unavailable(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "error": "market_data_unavailable",
            "message": "实时行情源暂不可用，且没有可用的本地降级数据。",
            "detail": str(exc),
        },
    )


@app.get("/api/trading")
def trading_state() -> dict:
    state = trade_state()
    positions = [normalize_position(position) for position in state.get("positions", [])]
    risk = portfolio_snapshot(state, positions)
    return {
        **state,
        "positions": positions,
        "risk": risk,
        "equity": equity_of(state),
        "cash": round(float(state.get("cash", 0)), 2),
        "orders": list(reversed(state.get("orders", [])))[0:50],
        "trades": list(reversed(state.get("trades", [])))[0:50],
    }


@app.post("/api/trading/orders")
def place_order(order: OrderRequest) -> dict:
    state = trade_state()
    recommendation = read_json_report("reports/data/latest-quant-recommendation.json", {})
    record = execute_order(order, state, recommendation)
    write_json_report("reports/data/trade-ops-state.json", state)
    append_execution_audit("trading.order", order.model_dump(), record)
    return {
        "order": record,
        "state": trading_state(),
    }


@app.get("/api/workbench")
def workbench() -> dict:
    open_watch = read_json_report("reports/data/latest-open-limit-watch.json", {})
    signals = read_json_report("reports/data/latest-trading-signals.json", {})
    recommendation = read_json_report("reports/data/latest-quant-recommendation.json", {})
    scan = read_json_report("reports/data/latest-free-a-share-scan.brief.json", {})
    refresh_report = read_json_report("reports/data/latest-refresh-report.json", {})
    backtest_result = read_json_report("reports/data/backtest-result.json", {})
    paper_state = read_json_report("reports/data/paper-trading-state.json", {})
    committee = read_json_report("reports/data/latest-investment-committee.json", {})
    trading = trading_state()
    event_log = read_jsonl_tail("reports/data/open-limit-events.jsonl", 60)
    files = {
        "openWatch": report_status("reports/data/latest-open-limit-watch.json"),
        "signals": report_status("reports/data/latest-trading-signals.json"),
        "recommendation": report_status("reports/data/latest-quant-recommendation.json"),
        "backtest": report_status("reports/data/backtest-result.json"),
        "paper": report_status("reports/data/paper-trading-state.json"),
        "scan": report_status("reports/data/latest-free-a-share-scan.brief.json"),
        "committee": report_status("reports/data/latest-investment-committee.json"),
        "refreshReport": report_status("reports/data/latest-refresh-report.json"),
    }
    latest_live_time = latest_live_quote_time()
    hard_gate_reasons: list[str] = []
    if refresh_report.get("warning"):
        hard_gate_reasons.append("最近一次刷新存在数据源警告，候选仅供观察")
    if refresh_report.get("ok") is False or refresh_report.get("criticalFailures"):
        hard_gate_reasons.append("最近一次刷新存在关键失败，禁止新增买入")
    if latest_live_time and is_a_share_trading_time():
        quote_age = minutes_since(latest_live_time)
        if quote_age > MAX_INTRADAY_QUOTE_AGE_MINUTES:
            hard_gate_reasons.append(f"盘中行情已 {quote_age:.1f} 分钟未更新，禁止新增买入")
    effective_live_buy_allowed = bool(recommendation.get("liveBuyAllowed", False)) and not hard_gate_reasons
    recommended_buys = recommendation.get("recommendedBuys", [])
    if not effective_live_buy_allowed:
        recommended_buys = [
            {
                **item,
                "action": "WATCH" if item.get("action") == "TRADE" else item.get("action"),
                "blockedReasons": [*(item.get("blockedReasons") or []), *hard_gate_reasons][:5],
            }
            for item in recommended_buys
        ]

    return {
        "updatedAt": open_watch.get("generatedAt")
        or recommendation.get("generatedAt")
        or signals.get("generatedAt")
        or scan.get("requestTime"),
        "marketState": open_watch.get("marketState") or signals.get("marketState") or scan.get("marketState") or {},
        "openWatch": {
            "counts": open_watch.get("counts", {}),
            "newLimitUps": open_watch.get("newLimitUps", []),
            "strongToLimit": open_watch.get("strongToLimit", []),
            "removedLimitUps": open_watch.get("removedLimitUps", []),
            "newStrong": open_watch.get("newStrong", []),
            "attackThemes": open_watch.get("attackThemes", []),
            "attackCandidates": open_watch.get("attackCandidates", []),
            "sourceBrief": open_watch.get("sourceBrief"),
            "previousBrief": open_watch.get("previousBrief"),
            "events": list(reversed(event_log)),
        },
        "signals": {
            "stats": signals.get("stats", {}),
            "trade": signals.get("trade", []),
            "watch": signals.get("watch", []),
            "avoid": signals.get("avoid", []),
            "risk": signals.get("risk", {}),
            "requestTime": signals.get("requestTime"),
        },
        "recommendation": {
            "status": recommendation.get("status", "UNKNOWN") if effective_live_buy_allowed else "WATCH_ONLY",
            "liveBuyAllowed": effective_live_buy_allowed,
            "recommendedBuys": recommended_buys,
            "reasons": [*hard_gate_reasons, *(recommendation.get("reasons", []) or [])],
            "watchPlan": recommendation.get("watchPlan", []),
            "qualityRadar": recommendation.get("qualityRadar", []),
            "upliftTop": recommendation.get("upliftTop", []),
        },
        "verification": {
            "backtest": backtest_result.get("metrics", {}),
            "paper": paper_state.get("metrics", {}),
        },
        "strategyCenter": build_strategy_center(backtest_result, signals, recommendation),
        "backtestReview": build_backtest_review(backtest_result, paper_state),
        "trading": {
            "mode": trading.get("mode"),
            "cash": trading.get("cash"),
            "equity": trading.get("equity"),
            "positions": trading.get("positions", []),
            "orders": trading.get("orders", []),
            "trades": trading.get("trades", []),
        },
        "system": {
            "files": files,
            "modules": [
                {
                    "name": "数据快照",
                    "status": "OK" if files["scan"]["exists"] else "MISSING",
                    "detail": files["scan"]["path"],
                },
                {
                    "name": "事件监控",
                    "status": "OK" if files["openWatch"]["exists"] else "MISSING",
                    "detail": files["openWatch"]["path"],
                },
                {
                    "name": "标准信号",
                    "status": "OK" if files["signals"]["exists"] else "MISSING",
                    "detail": files["signals"]["path"],
                },
                {
                    "name": "推荐闸门",
                    "status": "OK" if files["recommendation"]["exists"] else "MISSING",
                    "detail": files["recommendation"]["path"],
                },
                {
                    "name": "投资委员会",
                    "status": "OK" if files["committee"]["exists"] else "MISSING",
                    "detail": files["committee"]["path"],
                },
                {
                    "name": "验证回测",
                    "status": "OK" if files["backtest"]["exists"] and files["paper"]["exists"] else "MISSING",
                    "detail": "backtest + paper",
                },
            ],
            "committee": {
                "generatedAt": committee.get("generatedAt"),
                "decisions": committee.get("decisions", [])[:10],
            },
        },
    }


@app.get("/api/committee/latest")
def committee_latest() -> dict:
    return read_json_report("reports/data/latest-investment-committee.json", {"decisions": []})


@app.get("/api/research/latest")
def research_latest() -> dict:
    return read_json_report("reports/data/latest-research-report.json", {"decisions": [], "evidence": []})


@app.get("/api/strategies")
def strategy_registry() -> dict:
    persisted = read_json_report("reports/data/strategy-registry.json", {})
    return persisted if persisted.get("rows") else build_strategy_registry()


@app.get("/api/agent/v1/capabilities")
def agent_v1_capabilities() -> dict:
    payload = agent_capabilities()
    append_agent_audit("capabilities", {}, {"ok": True, "status": "OK"})
    return payload


@app.get("/api/agent/v1/research/latest")
def agent_v1_research_latest() -> dict:
    payload = read_json_report("reports/data/latest-research-report.json", {"decisions": [], "evidence": []})
    append_agent_audit("research.latest", {}, {"ok": True, "status": "OK"})
    return payload


@app.get("/api/agent/v1/strategies")
def agent_v1_strategies() -> dict:
    payload = strategy_registry()
    append_agent_audit("strategies", {}, {"ok": True, "status": "OK"})
    return payload


@app.get("/api/agent/v1/workbench")
def agent_v1_workbench() -> dict:
    payload = read_json_report("reports/data/latest-workbench-snapshot.json", {})
    if not payload:
        payload = {
            "research": read_json_report("reports/data/latest-research-report.json", {"decisions": []}),
            "strategies": strategy_registry(),
            "committee": read_json_report("reports/data/latest-investment-committee.json", {"decisions": []}),
            "trading": trading_state(),
        }
    append_agent_audit("workbench", {}, {"ok": True, "status": "OK"})
    return payload


@app.get("/api/agent/v1/audit/latest")
def agent_v1_audit_latest(limit: int = Query(default=40, ge=1, le=200)) -> dict:
    rows = read_jsonl_tail("reports/data/agent-gateway-audit.jsonl", limit)
    return {"mode": "PAPER_ONLY", "rows": rows}


@app.post("/api/agent/v1/orders/preflight")
def agent_v1_order_preflight(request: AgentPreflightRequest) -> dict:
    order = OrderRequest(
        side=request.side,
        code=request.code,
        name=request.name,
        quantity=request.quantity,
        price=request.price,
        dryRun=True,
    )
    state = trade_state()
    recommendation = read_json_report("reports/data/latest-quant-recommendation.json", {})
    order_record = execute_order(order, state, recommendation)
    result = {
        "ok": order_record.get("status") == "CHECKED",
        "status": order_record.get("status"),
        "mode": "PAPER_ONLY",
        "forcedDryRun": True,
        "order": order_record,
        "reasons": order_record.get("reasons", []),
        "strategyKey": request.strategyKey,
        "rationale": request.rationale,
    }
    append_agent_audit("orders.preflight", request.model_dump(), result)
    return result


@app.get("/api/stock-pool", response_model=list[StockSignal])
def stock_pool(
    response: Response,
    limit: int = Query(default=30, ge=1, le=100),
    live: bool = Query(default=False, description="实时拉取行情并重新计算；默认读取最近一次持久化股票池。"),
) -> list[StockSignal]:
    if not live:
        signals = persisted_stock_signals(limit)
        if signals:
            response.headers["X-Quant-Data-Source"] = "quant-system/backend/data/stock_pool_latest.json"
            return signals

    try:
        provider = get_provider()
        quotes = provider.list_a_shares()
    except ProviderUnavailable as exc:
        signals = persisted_stock_signals(limit)
        if not signals:
            raise market_data_unavailable(exc) from exc
        mark_degraded_response(response, "quant-system/backend/data/stock_pool_latest.json")
        return signals
    signals = run_trend_breakout(quotes, provider.get_daily_kline, limit=limit)
    return [enrich_with_openai(signal) for signal in signals]


@app.get("/api/stocks/{code}/analysis", response_model=StockSignal | dict)
def stock_analysis(
    code: str,
    response: Response,
    live: bool = Query(default=False, description="实时拉取行情并重新分析；默认读取最近一次持久化信号。"),
) -> StockSignal | dict:
    if not live:
        signal = persisted_stock_signal(code)
        if signal:
            response.headers["X-Quant-Data-Source"] = "quant-system/backend/data/stock_pool_latest.json"
            return signal

    try:
        provider = get_provider()
        quotes = provider.list_a_shares()
    except ProviderUnavailable as exc:
        signal = persisted_stock_signal(code)
        if signal:
            mark_degraded_response(response, "quant-system/backend/data/stock_pool_latest.json")
            return signal
        raise market_data_unavailable(exc) from exc
    quote = next((item for item in quotes if item.code == code.zfill(6)), None)
    if not quote:
        return {"error": "stock not found"}
    signals = run_trend_breakout([quote], provider.get_daily_kline, limit=1)
    if not signals:
        return {"error": "stock does not match trend breakout strategy", "stock": quote.model_dump()}
    return enrich_with_openai(signals[0])


@app.get("/api/stocks/{code}/supplements")
def stock_supplements(code: str) -> dict:
    normalized = code.zfill(6)
    result: dict[str, Any] = {"code": normalized, "financial": None, "announcements": [], "moneyFlow": []}
    errors: list[str] = []

    try:
        result["financial"] = TushareProvider().get_financial_snapshot(normalized).model_dump()
    except (ProviderUnavailable, RuntimeError, OSError) as exc:
        errors.append(f"tushare: {exc}")

    try:
        result["announcements"] = [
            item.model_dump() for item in CninfoAnnouncementProvider().get_announcements(normalized, page_size=20)
        ]
    except (ProviderUnavailable, RuntimeError, OSError) as exc:
        errors.append(f"cninfo: {exc}")

    try:
        result["moneyFlow"] = [item.model_dump() for item in EastMoneyMoneyFlowProvider().get_money_flow(normalized, days=5)]
    except (ProviderUnavailable, RuntimeError, OSError) as exc:
        errors.append(f"eastmoney_moneyflow: {exc}")

    result["errors"] = errors
    return result


@app.get("/api/backtest")
def backtest(
    response: Response,
    codes: str = Query(..., description="逗号分隔股票代码，如 000001,600519"),
    hold_days: int = Query(default=5, ge=1, le=30),
    live: bool = Query(default=False, description="实时拉取行情源；默认使用本地报告和K线缓存。"),
):
    if live:
        try:
            provider = get_provider()
            quotes = provider.list_a_shares()
        except ProviderUnavailable:
            provider = ReportFallbackProvider()
            quotes = provider.list_a_shares()
            mark_degraded_response(response, "reports/data/latest-free-a-share-scan.brief.json")
    else:
        provider = ReportFallbackProvider()
        quotes = provider.list_a_shares()
        response.headers["X-Quant-Data-Source"] = "reports/data/latest-free-a-share-scan.brief.json"

    if not quotes:
        return {
            "strategy": "hold_days",
            "trades": [],
            "total_return_pct": 0,
            "win_rate_pct": 0,
            "average_return_pct": 0,
            "max_drawdown_pct": 0,
            "warning": "没有可用的本地报告数据。",
        }
    quote_map: dict[str, StockQuote] = {item.code: item for item in quotes}
    code_list = [item.strip().zfill(6) for item in codes.split(",") if item.strip()]
    return run_hold_days_backtest(
        code_list,
        lambda code: quote_map.get(code),
        provider.get_daily_kline,
        hold_days=hold_days,
    )


@app.post("/api/jobs/run-daily")
def run_daily_job(limit: int = Query(default=30, ge=1, le=100)) -> dict:
    return run_daily_selection(limit=limit)
