from __future__ import annotations

from backend.ai.commentary import build_rule_comment
from backend.data.models import KLine, StockQuote, StockSignal


LOW_PRICE_LIMIT = 3


def _is_blocked_name(name: str) -> bool:
    upper = name.upper()
    return "ST" in upper or "退" in name


def _moving_average(values: list[float], window: int) -> float | None:
    if len(values) < window:
        return None
    return sum(values[-window:]) / window


def _risk_level(quote: StockQuote, volume_ratio: float, twenty_day_pct: float) -> str:
    if quote.price < 5 or quote.pct > 6.5 or volume_ratio > 4 or twenty_day_pct > 45:
        return "高"
    if quote.pct > 5.5 or volume_ratio > 2.8 or twenty_day_pct > 30:
        return "中"
    return "低"


def score_trend(quote: StockQuote, klines: list[KLine]) -> StockSignal | None:
    if _is_blocked_name(quote.name) or quote.price < LOW_PRICE_LIMIT:
        return None
    if not (3 <= quote.pct <= 7):
        return None
    if len(klines) < 20:
        return None

    ordered = sorted(klines, key=lambda item: item.trade_date)
    close = [float(item.close) for item in ordered]
    volume = [float(item.volume) for item in ordered]
    ma5 = _moving_average(close, 5)
    ma10 = _moving_average(close, 10)
    ma20 = _moving_average(close, 20)
    if not ma5 or not ma10 or not ma20:
        return None

    latest_close = close[-1]
    avg_volume_window = volume[-6:-1] if len(volume) >= 6 else volume[-5:]
    avg_volume_5 = sum(avg_volume_window) / len(avg_volume_window) if avg_volume_window else 0
    latest_volume = volume[-1]
    volume_ratio = latest_volume / avg_volume_5 if avg_volume_5 > 0 else 0
    twenty_day_pct = (latest_close / close[-20] - 1) * 100

    reasons: list[str] = []
    score = 0.0
    if latest_close > ma20:
        score += 20
        reasons.append("股价站上20日均线")
    if ma5 > ma10 > ma20:
        score += 25
        reasons.append("5日线 > 10日线 > 20日线")
    if 3 <= quote.pct <= 7:
        score += 15
        reasons.append("当日涨幅处于3%-7%强势区间")
    if volume_ratio >= 1.5:
        score += 20
        reasons.append("成交量大于5日均量1.5倍")
    if twenty_day_pct > 0:
        score += min(20, twenty_day_pct / 2)
        reasons.append(f"近20日涨幅 {twenty_day_pct:.2f}%")

    if score < 70 or volume_ratio < 1.5 or latest_close <= ma20 or not (ma5 > ma10 > ma20):
        return None

    risk_level = _risk_level(quote, volume_ratio, twenty_day_pct)
    signal = StockSignal(
        code=quote.code,
        name=quote.name,
        current_price=quote.price,
        pct=quote.pct,
        volume_ratio=round(volume_ratio, 2),
        trend_score=round(min(score, 100), 1),
        risk_level=risk_level,  # type: ignore[arg-type]
        ai_comment="",
        reasons=reasons,
    )
    signal.ai_comment = build_rule_comment(signal)
    return signal


def run_trend_breakout(quotes: list[StockQuote], kline_loader, limit: int = 30) -> list[StockSignal]:
    signals: list[StockSignal] = []
    for quote in quotes:
        klines = kline_loader(quote.code, 80)
        signal = score_trend(quote, klines)
        if signal:
            signals.append(signal)
    signals.sort(key=lambda item: (item.trend_score, item.volume_ratio, item.pct), reverse=True)
    return signals[:limit]
