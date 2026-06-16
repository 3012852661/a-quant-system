from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from statistics import mean, pstdev
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, "", "-"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


@dataclass
class RoleReport:
    role: str
    stance: str
    score: float
    summary: str
    evidence: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    data_gaps: list[str] = field(default_factory=list)


@dataclass
class CommitteeDecision:
    code: str
    name: str
    decision: str
    confidence: float
    max_position_pct: float
    rationale: list[str]
    vetoes: list[str]
    role_reports: dict[str, RoleReport]


def load_latest_context() -> dict[str, Any]:
    root = repo_root()
    pool = read_json(root / "quant-system/backend/data/stock_pool_latest.json", {})
    live = read_json(root / "reports/data/live-tencent-candidate-quotes.json", {})
    recommendation = read_json(root / "reports/data/latest-quant-recommendation.json", {})
    return {
        "pool": pool,
        "live": live,
        "recommendation": recommendation,
    }


def load_klines(code: str, days: int = 120) -> list[dict[str, Any]]:
    path = repo_root() / "reports" / "data" / "kline-cache" / f"{code}.daily.json"
    payload = read_json(path, [])
    rows = payload.get("klines", []) if isinstance(payload, dict) else payload if isinstance(payload, list) else []
    parsed: list[dict[str, Any]] = []
    for row in rows[-days:]:
        if isinstance(row, str):
            parts = row.split(",")
            if len(parts) < 6:
                continue
            parsed.append(
                {
                    "date": parts[0],
                    "open": to_float(parts[1]),
                    "close": to_float(parts[2]),
                    "high": to_float(parts[3]),
                    "low": to_float(parts[4]),
                    "volume": to_float(parts[5]),
                }
            )
        elif isinstance(row, dict):
            parsed.append(
                {
                    "date": row.get("date") or row.get("trade_date"),
                    "open": to_float(row.get("open")),
                    "close": to_float(row.get("close")),
                    "high": to_float(row.get("high")),
                    "low": to_float(row.get("low")),
                    "volume": to_float(row.get("volume")),
                }
            )
    return [item for item in parsed if item["close"] > 0]


def simple_rsi(values: list[float], window: int = 14) -> float | None:
    if len(values) <= window:
        return None
    gains: list[float] = []
    losses: list[float] = []
    for previous, current in zip(values[-window - 1 : -1], values[-window:]):
        delta = current - previous
        gains.append(max(delta, 0))
        losses.append(abs(min(delta, 0)))
    avg_gain = mean(gains)
    avg_loss = mean(losses)
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - 100 / (1 + rs)


def ma(values: list[float], window: int) -> float | None:
    if len(values) < window:
        return None
    return mean(values[-window:])


def live_by_code(context: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(row.get("code", "")).zfill(6): row for row in context["live"].get("rows", [])}


def pool_by_code(context: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(row.get("code", "")).zfill(6): row for row in context["pool"].get("signals", [])}


def researcher(code: str, signal: dict[str, Any], live: dict[str, Any]) -> RoleReport:
    evidence = [
        f"候选池生成时间：{signal.get('trade_date', '-')}",
        f"原始动作：{signal.get('action', '-')}，原始评分：{signal.get('score', '-')}",
    ]
    if live:
        evidence.extend(
            [
                f"最新价 {live.get('price')}，涨跌幅 {live.get('pct')}%，时间 {live.get('time')}",
                f"日内高低 {live.get('high')} / {live.get('low')}，成交额约 {to_float(live.get('amountWan')) / 10000:.2f} 亿",
            ]
        )
    gaps = ["公告、财报、研报、行业新闻源尚未接入自动采集"] if not signal.get("announcements") else []
    return RoleReport(
        role="Researcher",
        stance="FACTS_ONLY",
        score=50,
        summary="已聚合本地候选池与最新候选报价；不输出投资判断。",
        evidence=evidence,
        data_gaps=gaps,
    )


def fundamental_analyst(signal: dict[str, Any], live: dict[str, Any]) -> RoleReport:
    pe = to_float(live.get("pe"))
    total_mv = to_float(live.get("totalMvYi"))
    turnover = to_float(live.get("turnover"))
    score = 50.0
    risks: list[str] = []
    evidence = [
        f"PE {pe:.2f}" if pe else "PE 缺失",
        f"总市值约 {total_mv:.2f} 亿" if total_mv else "总市值缺失",
        f"换手率 {turnover:.2f}%" if turnover else "换手率缺失",
    ]
    if pe > 80:
        score -= 18
        risks.append("估值分位可能偏高，需财报增长验证")
    elif 0 < pe < 35:
        score += 8
    if turnover > 12:
        score -= 8
        risks.append("换手较高，基本面资金承接需要额外验证")
    gaps = ["收入结构、毛利率、现金流、近三期利润增速未接入结构化数据"]
    return RoleReport(
        role="Fundamental Analyst",
        stance="NEEDS_MORE_DATA" if gaps else "OK",
        score=max(0, min(100, score)),
        summary="只能基于估值、市值和流动性做初筛，不能确认基本面改善。",
        evidence=evidence,
        risks=risks,
        data_gaps=gaps,
    )


def technical_analyst(code: str, signal: dict[str, Any], live: dict[str, Any]) -> RoleReport:
    klines = load_klines(code)
    evidence: list[str] = []
    risks: list[str] = []
    score = to_float(signal.get("score"), 50)
    price = to_float(live.get("price") or signal.get("current_price"))
    pct = to_float(live.get("pct") or signal.get("pct_chg"))
    high = to_float(live.get("high"))
    low = to_float(live.get("low"))
    open_price = to_float(live.get("open"))
    pullback = (price / high - 1) * 100 if price and high else 0
    intraday = (price / open_price - 1) * 100 if price and open_price else 0
    if klines:
        closes = [to_float(row["close"]) for row in klines]
        volumes = [to_float(row["volume"]) for row in klines]
        ma5 = ma(closes, 5)
        ma10 = ma(closes, 10)
        ma20 = ma(closes, 20)
        rsi14 = simple_rsi(closes, 14)
        upper = lower = None
        if len(closes) >= 20:
            basis = mean(closes[-20:])
            sigma = pstdev(closes[-20:])
            upper, lower = basis + 2 * sigma, basis - 2 * sigma
        evidence.append(f"MA5/10/20：{ma5:.2f}/{ma10:.2f}/{ma20:.2f}" if ma5 and ma10 and ma20 else "均线数据不足")
        evidence.append(f"RSI14：{rsi14:.1f}" if rsi14 is not None else "RSI 数据不足")
        if upper and lower:
            evidence.append(f"布林带上/下轨：{upper:.2f}/{lower:.2f}")
        if ma5 and ma10 and ma20 and not (price > ma5 > ma10 > ma20):
            score -= 18
            risks.append("价格/均线未形成多头排列")
        if volumes and len(volumes) >= 6:
            avg_volume = mean(volumes[-6:-1])
            vr = volumes[-1] / avg_volume if avg_volume else 0
            evidence.append(f"近 5 日量比估算：{vr:.2f}")
    else:
        evidence.append("K 线缓存缺失，使用日内行情做降级判断")
    evidence.extend(
        [
            f"最新涨跌幅 {pct:.2f}%",
            f"相对开盘 {intraday:.2f}%",
            f"距日内高点回撤 {pullback:.2f}%",
            f"距日内低点反弹 {(price / low - 1) * 100:.2f}%" if price and low else "日内低点缺失",
        ]
    )
    if not (3 <= pct <= 7):
        score -= 35
        risks.append("最新涨幅已离开 3%-7% 强势区间")
    if pullback < -3.5:
        score -= 18
        risks.append("从日内高点回撤超过 3.5%，冲高回落风险")
    if intraday < -1:
        score -= 12
        risks.append("价格低于开盘超过 1%，日内承接偏弱")
    return RoleReport(
        role="Technical Analyst",
        stance="STRONG" if score >= 75 else "WEAK" if score < 45 else "MIXED",
        score=max(0, min(100, score)),
        summary="技术面以最新涨幅、日内承接、回撤和均线/量能为核心约束。",
        evidence=evidence,
        risks=risks,
        data_gaps=[] if klines else ["K 线缓存缺失，MACD/KDJ 暂未计算"],
    )


def sentiment_analyst(signal: dict[str, Any], live: dict[str, Any]) -> RoleReport:
    pct = to_float(live.get("pct"))
    turnover = to_float(live.get("turnover"))
    amount_yi = to_float(live.get("amountWan")) / 10000
    score = 50.0
    evidence = [
        f"涨跌幅热度代理：{pct:.2f}%",
        f"成交额热度代理：{amount_yi:.2f} 亿",
        f"换手率热度代理：{turnover:.2f}%",
    ]
    risks: list[str] = []
    if pct > 5 and amount_yi > 30:
        score += 18
        evidence.append("价格与成交额热度较高")
    if pct < 0:
        score -= 20
        risks.append("价格转弱会快速压低短线情绪")
    if turnover > 12:
        score -= 8
        risks.append("高换手可能对应分歧放大")
    return RoleReport(
        role="Sentiment Analyst",
        stance="HOT" if score >= 65 else "COLD" if score < 40 else "NEUTRAL",
        score=max(0, min(100, score)),
        summary="当前舆情模块只使用价格/成交热度代理，不把社交情绪缺失误判为利好。",
        evidence=evidence,
        risks=risks,
        data_gaps=["新闻评论、社交平台讨论、财经社区情绪尚未接入"],
    )


def risk_officer(signal: dict[str, Any], live: dict[str, Any], reports: dict[str, RoleReport]) -> RoleReport:
    price = to_float(live.get("price") or signal.get("current_price"))
    stop = to_float(signal.get("stop_loss"))
    target = to_float(signal.get("target_price"))
    pct = to_float(live.get("pct"))
    high = to_float(live.get("high"))
    buy_zone = str(signal.get("buy_zone") or "")
    zone_low = zone_high = 0.0
    if "-" in buy_zone:
        left, right = buy_zone.split("-", 1)
        zone_low, zone_high = to_float(left), to_float(right)
    vetoes: list[str] = []
    risks: list[str] = []
    evidence: list[str] = []
    if stop and price < stop:
        vetoes.append("跌破原策略止损线")
    if not (3 <= pct <= 7):
        vetoes.append("最新涨幅不在策略强势区间")
    if high and (price / high - 1) * 100 < -3.5:
        vetoes.append("日内冲高回落幅度过大")
    if zone_high and price > zone_high * 1.025:
        risks.append("价格显著高于原买入区，追高风险")
    if target and price > target * 0.985:
        risks.append("价格接近或进入原目标兑现区")
    for report in reports.values():
        if report.data_gaps:
            risks.append(f"{report.role} 数据缺口：{report.data_gaps[0]}")
    evidence.append(f"止损线 {stop or '-'}，目标位 {target or '-'}，买区 {buy_zone or '-'}")
    return RoleReport(
        role="Risk Officer",
        stance="VETO" if vetoes else "CAUTION" if risks else "OK",
        score=max(0, 100 - len(vetoes) * 35 - len(risks) * 8),
        summary="风险官只寻找反面证据；存在否决项时禁止新开仓。",
        evidence=evidence,
        risks=vetoes + risks,
        data_gaps=["监管、诉讼、减持、解禁、业绩预告风险尚未接入结构化源"],
    )


def portfolio_manager(code: str, name: str, reports: dict[str, RoleReport]) -> CommitteeDecision:
    risk_report = reports["Risk Officer"]
    technical = reports["Technical Analyst"]
    fundamental = reports["Fundamental Analyst"]
    sentiment = reports["Sentiment Analyst"]
    vetoes = [item for item in risk_report.risks if "数据缺口" not in item]
    rationale = [
        f"技术评分 {technical.score:.1f}，状态 {technical.stance}",
        f"基本面评分 {fundamental.score:.1f}，状态 {fundamental.stance}",
        f"情绪评分 {sentiment.score:.1f}，状态 {sentiment.stance}",
        f"风险状态 {risk_report.stance}",
    ]
    if risk_report.stance == "VETO":
        decision = "REJECT"
        max_position = 0.0
    elif technical.score >= 75 and risk_report.score >= 70 and fundamental.score >= 45:
        decision = "WATCH_NO_CHASE"
        max_position = 6.0
    else:
        decision = "WATCH_ONLY"
        max_position = 0.0
    confidence = mean([technical.score, fundamental.score, sentiment.score, risk_report.score])
    return CommitteeDecision(
        code=code,
        name=name,
        decision=decision,
        confidence=round(confidence, 1),
        max_position_pct=max_position,
        rationale=rationale,
        vetoes=vetoes,
        role_reports=reports,
    )


def analyze_stock(code: str, context: dict[str, Any]) -> CommitteeDecision | None:
    code = code.zfill(6)
    signal = pool_by_code(context).get(code)
    live = live_by_code(context).get(code, {})
    if not signal and not live:
        return None
    signal = signal or {"code": code, "name": live.get("name", code), "score": 0}
    name = str(live.get("name") or signal.get("name") or code).replace("XD", "")
    reports: dict[str, RoleReport] = {}
    reports["Researcher"] = researcher(code, signal, live)
    reports["Fundamental Analyst"] = fundamental_analyst(signal, live)
    reports["Technical Analyst"] = technical_analyst(code, signal, live)
    reports["Sentiment Analyst"] = sentiment_analyst(signal, live)
    reports["Risk Officer"] = risk_officer(signal, live, reports)
    return portfolio_manager(code, name, reports)


def run_committee(codes: list[str] | None = None) -> dict[str, Any]:
    context = load_latest_context()
    candidate_codes = codes or list(pool_by_code(context).keys()) or list(live_by_code(context).keys())
    decisions = [item for code in candidate_codes if (item := analyze_stock(code, context))]
    decisions.sort(key=lambda item: (item.decision != "REJECT", item.confidence), reverse=True)
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": {
            "stockPool": "quant-system/backend/data/stock_pool_latest.json",
            "liveQuotes": "reports/data/live-tencent-candidate-quotes.json",
        },
        "method": "Six-role committee: researcher, fundamental, technical, sentiment, risk, portfolio manager",
        "decisions": [serialize_decision(item) for item in decisions],
    }


def serialize_decision(decision: CommitteeDecision) -> dict[str, Any]:
    payload = asdict(decision)
    payload["role_reports"] = {key: asdict(value) for key, value in decision.role_reports.items()}
    return payload
