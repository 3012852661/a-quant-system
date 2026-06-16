from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.ai.commentary import enrich_with_openai
from backend.backtest.simple_backtest import run_hold_days_backtest
from backend.config import settings
from backend.data.models import StockQuote, StockSignal
from backend.data.providers import (
    CninfoAnnouncementProvider,
    EastMoneyMoneyFlowProvider,
    ProviderUnavailable,
    TushareProvider,
    data_source_status,
    get_provider,
)
from backend.risk.portfolio import order_risk_reasons, portfolio_snapshot
from backend.scheduler.jobs import create_scheduler, run_daily_selection
from backend.strategy.trend_breakout import run_trend_breakout

app = FastAPI(title="A股量化选股系统", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OrderRequest(BaseModel):
    side: str = Field(pattern="^(BUY|SELL)$")
    code: str
    name: str | None = None
    quantity: int = Field(gt=0)
    price: float | None = Field(default=None, gt=0)
    dryRun: bool = False


def default_trade_state() -> dict:
    return {
        "mode": "PAPER",
        "cash": 100000.0,
        "initialCash": 100000.0,
        "positions": [],
        "orders": [],
        "trades": [],
    }

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
    rows: list[dict] = []
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


def trade_state() -> dict:
    state = read_json_report("reports/data/trade-ops-state.json", default_trade_state())
    base = default_trade_state()
    base.update(state)
    return base


def normalize_position(position: dict) -> dict:
    quote = latest_quote(position["code"])
    last_price = float(quote.get("price") or position.get("lastPrice") or position["avgPrice"]) if quote else float(
        position.get("lastPrice") or position["avgPrice"]
    )
    market_value = last_price * int(position["quantity"])
    cost = float(position["avgPrice"]) * int(position["quantity"])
    return {
        **position,
        "lastPrice": round(last_price, 3),
        "marketValue": round(market_value, 2),
        "unrealizedPct": round((market_value / cost - 1) * 100, 2) if cost > 0 else 0,
    }


def equity_of(state: dict) -> float:
    positions = [normalize_position(position) for position in state.get("positions", [])]
    return round(float(state.get("cash", 0)) + sum(float(item["marketValue"]) for item in positions), 2)


def trade_gate_reasons(order: OrderRequest, state: dict, recommendation: dict) -> list[str]:
    reasons: list[str] = []
    code = order.code.zfill(6)
    quote = latest_quote(code) or {}
    quote_price = float(quote.get("price") or 0)
    price = float(order.price or quote_price or 0)
    positions = [normalize_position(position) for position in state.get("positions", [])]
    if order.quantity % 100 != 0:
        reasons.append("A股委托数量必须为100股整数倍")
    if order.side == "BUY":
        if not recommendation.get("liveBuyAllowed", False):
            reasons.append("推荐闸门未打开，禁止新增买入")
        trade_codes = {str(item.get("code", "")).zfill(6) for item in recommendation.get("recommendedBuys", [])}
        if trade_codes and code not in trade_codes:
            reasons.append("标的不在可买清单")
        if not price:
            reasons.append("缺少可用价格")
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
    order_record = {
        "id": len(state.get("orders", [])) + 1,
        "side": order.side,
        "code": code,
        "name": name,
        "quantity": order.quantity,
        "price": round(price, 3) if price else None,
        "status": "CHECKED" if order.dryRun and not reasons else "REJECTED" if reasons else "FILLED",
        "dryRun": order.dryRun,
        "reasons": reasons,
    }
    if order.dryRun or reasons:
        state.setdefault("orders", []).append(order_record)
        return order_record

    gross = price * order.quantity
    if order.side == "BUY":
        state["cash"] = round(float(state.get("cash", 0)) - gross, 2)
        existing = next((item for item in state.get("positions", []) if item["code"] == code), None)
        if existing:
            total_qty = int(existing["quantity"]) + order.quantity
            existing["avgPrice"] = round(
                (float(existing["avgPrice"]) * int(existing["quantity"]) + gross) / total_qty,
                3,
            )
            existing["quantity"] = total_qty
        else:
            state.setdefault("positions", []).append(
                {
                    "code": code,
                    "name": name,
                    "quantity": order.quantity,
                    "avgPrice": round(price, 3),
                    "lastPrice": round(price, 3),
                }
            )
    else:
        state["cash"] = round(float(state.get("cash", 0)) + gross, 2)
        next_positions = []
        for position in state.get("positions", []):
            if position["code"] != code:
                next_positions.append(position)
                continue
            remaining = int(position["quantity"]) - order.quantity
            if remaining > 0:
                next_positions.append({**position, "quantity": remaining, "lastPrice": round(price, 3)})
        state["positions"] = next_positions

    state.setdefault("orders", []).append(order_record)
    state.setdefault("trades", []).append({**order_record, "gross": round(gross, 2)})
    return order_record


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
    }

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
            "status": recommendation.get("status", "UNKNOWN"),
            "liveBuyAllowed": recommendation.get("liveBuyAllowed", False),
            "recommendedBuys": recommendation.get("recommendedBuys", []),
            "reasons": recommendation.get("reasons", []),
            "watchPlan": recommendation.get("watchPlan", []),
            "qualityRadar": recommendation.get("qualityRadar", []),
            "upliftTop": recommendation.get("upliftTop", []),
        },
        "verification": {
            "backtest": backtest_result.get("metrics", {}),
            "paper": paper_state.get("metrics", {}),
        },
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


@app.get("/api/stock-pool", response_model=list[StockSignal])
def stock_pool(limit: int = Query(default=30, ge=1, le=100)) -> list[StockSignal]:
    provider = get_provider()
    quotes = provider.list_a_shares()
    signals = run_trend_breakout(quotes, provider.get_daily_kline, limit=limit)
    if not signals:
        return persisted_stock_signals(limit)
    return [enrich_with_openai(signal) for signal in signals]


@app.get("/api/stocks/{code}/analysis", response_model=StockSignal | dict)
def stock_analysis(code: str) -> StockSignal | dict:
    provider = get_provider()
    quotes = provider.list_a_shares()
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
    codes: str = Query(..., description="逗号分隔股票代码，如 000001,600519"),
    hold_days: int = Query(default=5, ge=1, le=30),
):
    provider = get_provider()
    quotes = provider.list_a_shares()
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
