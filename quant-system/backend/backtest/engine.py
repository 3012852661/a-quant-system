from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Callable


@dataclass(frozen=True)
class Bar:
    trade_date: date
    open: float
    close: float
    high: float
    low: float
    volume: float = 0.0
    amount: float | None = None


@dataclass(frozen=True)
class BacktestConfig:
    initial_cash: float = 100000.0
    hold_days: int = 3
    max_position_pct: float = 10.0
    fee_rate: float = 0.0003
    min_fee: float = 5.0
    stamp_tax_rate: float = 0.0005
    slippage_bps: float = 10.0
    max_volume_pct: float = 0.02
    lot_size: int = 100
    limit_pct: float = 9.8
    min_signal_pct: float = 3.0
    max_signal_pct: float = 7.0
    min_volume_ratio: float = 1.5
    min_trend_score: float = 70.0
    max_twenty_day_pct: float = 30.0
    min_price: float = 3.0
    stop_loss_pct: float = 4.0
    exclude_st: bool = True


KlineLoader = Callable[[str], list[Bar]]


def parse_date(value: Any) -> date | None:
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def to_bar(row: Any) -> Bar | None:
    if isinstance(row, str):
        parts = row.split(",")
        if len(parts) < 6:
            return None
        trade_date = parse_date(parts[0])
        if not trade_date:
            return None
        return Bar(
            trade_date=trade_date,
            open=_float(parts[1]),
            close=_float(parts[2]),
            high=_float(parts[3]),
            low=_float(parts[4]),
            volume=_float(parts[5]),
            amount=_float(parts[6], None) if len(parts) > 6 else None,
        )
    if isinstance(row, dict):
        trade_date = parse_date(row.get("date") or row.get("trade_date"))
        if not trade_date:
            return None
        return Bar(
            trade_date=trade_date,
            open=_float(row.get("open")),
            close=_float(row.get("close")),
            high=_float(row.get("high")),
            low=_float(row.get("low")),
            volume=_float(row.get("volume")),
            amount=_float(row.get("amount"), None),
        )
    return None


def _float(value: Any, default: float | None = 0.0) -> float:
    try:
        if value in (None, "", "-"):
            return 0.0 if default is None else default
        return float(value)
    except (TypeError, ValueError):
        return 0.0 if default is None else default


def _limit_up(bar: Bar, previous: Bar, limit_pct: float) -> bool:
    return previous.close > 0 and (bar.open / previous.close - 1) * 100 >= limit_pct


def _limit_down(bar: Bar, previous: Bar, limit_pct: float) -> bool:
    return previous.close > 0 and (bar.open / previous.close - 1) * 100 <= -limit_pct


def _round_lot(quantity: float, lot_size: int) -> int:
    return max(0, int(quantity // lot_size) * lot_size)


def _fees(gross: float, side: str, config: BacktestConfig) -> float:
    commission = max(config.min_fee, gross * config.fee_rate)
    stamp = gross * config.stamp_tax_rate if side == "SELL" else 0.0
    return commission + stamp


def run_historical_event_backtest(
    candidates: list[dict[str, Any]],
    kline_loader: KlineLoader,
    config: BacktestConfig = BacktestConfig(),
    window: int = 160,
) -> dict[str, Any]:
    trades: list[dict[str, Any]] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        code = str(candidate.get("code") or "").zfill(6)
        if not code or code in seen:
            continue
        seen.add(code)
        if config.exclude_st and _blocked_name(str(candidate.get("name") or "")):
            skipped.append(f"{code} blocked name")
            continue
        bars = sorted(kline_loader(code), key=lambda item: item.trade_date)
        sample = bars[-window:] if window > 0 else bars
        if len(sample) <= config.hold_days + 2:
            skipped.append(f"{code} insufficient kline")
            continue
        idx = 21
        while idx < len(sample) - config.hold_days:
            entry = entry_signal(sample, idx, config)
            if not entry["ok"]:
                idx += 1
                continue
            trade = simulate_long_trade(candidate, sample, idx, config)
            if trade.get("status") == "FILLED":
                trades.append({**trade, "entrySignal": entry})
                idx += max(config.hold_days, 2)
            else:
                skipped.append(f"{code} {trade.get('status')} {trade.get('reason')}")
                idx += 1
    return summarize_trades(trades, skipped, config, mode="historical_event")


def _blocked_name(name: str) -> bool:
    upper = name.upper()
    return "ST" in upper or "退" in name


def _avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def entry_signal(bars: list[Bar], buy_idx: int, config: BacktestConfig) -> dict[str, Any]:
    signal_idx = buy_idx - 1
    if signal_idx < 20:
        return {"ok": False, "reason": "insufficient lookback"}
    signal_bar = bars[signal_idx]
    previous = bars[signal_idx - 1]
    if signal_bar.close < config.min_price:
        return {"ok": False, "reason": "price below minimum"}
    pct = (signal_bar.close / previous.close - 1) * 100 if previous.close > 0 else 0.0
    if pct < config.min_signal_pct or pct > config.max_signal_pct:
        return {"ok": False, "reason": "signal pct out of range", "pct": round(pct, 2)}

    closes = [float(item.close) for item in bars[: signal_idx + 1]]
    volumes = [float(item.volume) for item in bars[: signal_idx + 1]]
    ma5 = _avg(closes[-5:])
    ma10 = _avg(closes[-10:])
    ma20 = _avg(closes[-20:])
    if not (signal_bar.close > ma20 and ma5 > ma10 > ma20):
        return {"ok": False, "reason": "moving averages not aligned"}

    avg_volume_5 = _avg(volumes[-6:-1])
    volume_ratio = signal_bar.volume / avg_volume_5 if avg_volume_5 > 0 else 0.0
    if volume_ratio < config.min_volume_ratio:
        return {"ok": False, "reason": "volume ratio below threshold", "volumeRatio": round(volume_ratio, 2)}
    if volume_ratio > 4.0:
        return {"ok": False, "reason": "volume ratio overheated", "volumeRatio": round(volume_ratio, 2)}

    twenty_day_pct = (signal_bar.close / closes[-20] - 1) * 100 if closes[-20] > 0 else 0.0
    if twenty_day_pct > config.max_twenty_day_pct:
        return {"ok": False, "reason": "twenty day gain too high", "twentyDayPct": round(twenty_day_pct, 2)}
    high_fade_pct = (signal_bar.high / signal_bar.close - 1) * 100 if signal_bar.close > 0 else 0.0
    if high_fade_pct >= 4:
        return {"ok": False, "reason": "intraday fade too high", "highFadePct": round(high_fade_pct, 2)}
    gap_pct = (signal_bar.open / previous.close - 1) * 100 if previous.close > 0 else 0.0
    intraday_gain_pct = (signal_bar.close / signal_bar.open - 1) * 100 if signal_bar.open > 0 else 0.0
    if gap_pct >= 3 and intraday_gain_pct < 0.5:
        return {"ok": False, "reason": "gap strength not held", "gapPct": round(gap_pct, 2)}

    score = 0.0
    score += 20 if signal_bar.close > ma20 else 0
    score += 25 if ma5 > ma10 > ma20 else 0
    score += 15 if config.min_signal_pct <= pct <= config.max_signal_pct else 0
    score += 20 if volume_ratio >= config.min_volume_ratio else 0
    score += min(20, max(0.0, twenty_day_pct) / 2)
    score += 8 if 5 <= twenty_day_pct <= config.max_twenty_day_pct else 0
    if high_fade_pct >= 2.5:
        score -= 8
    if score < config.min_trend_score:
        return {"ok": False, "reason": "trend score below threshold", "score": round(score, 1)}
    return {
        "ok": True,
        "signalDate": signal_bar.trade_date.isoformat(),
        "pct": round(pct, 2),
        "volumeRatio": round(volume_ratio, 2),
        "twentyDayPct": round(twenty_day_pct, 2),
        "highFadePct": round(high_fade_pct, 2),
        "score": round(score, 1),
    }


def simulate_long_trade(candidate: dict[str, Any], bars: list[Bar], buy_idx: int, config: BacktestConfig) -> dict[str, Any]:
    code = str(candidate.get("code") or "").zfill(6)
    name = str(candidate.get("name") or code)
    buy_bar = bars[buy_idx]
    previous_buy = bars[buy_idx - 1]
    if _limit_up(buy_bar, previous_buy, config.limit_pct):
        return {"status": "SKIPPED", "code": code, "reason": "limit-up open not fillable"}
    if buy_bar.open <= 0:
        return {"status": "SKIPPED", "code": code, "reason": "invalid buy open"}

    buy_price = buy_bar.open * (1 + config.slippage_bps / 10000)
    budget = config.initial_cash * (config.max_position_pct / 100)
    volume_cap = _round_lot(buy_bar.volume * config.max_volume_pct, config.lot_size)
    quantity = _round_lot(budget / buy_price, config.lot_size)
    if volume_cap > 0:
        quantity = min(quantity, volume_cap)
    if quantity <= 0:
        return {"status": "SKIPPED", "code": code, "reason": "budget or volume cap below one lot"}

    sell_idx = min(buy_idx + config.hold_days, len(bars) - 1)
    stop_price = buy_price * (1 - config.stop_loss_pct / 100) if config.stop_loss_pct > 0 else 0.0
    stop_triggered = False
    if stop_price:
        for stop_idx in range(buy_idx + 1, sell_idx + 1):
            if bars[stop_idx].low <= stop_price:
                sell_idx = stop_idx
                stop_triggered = True
                break
    while sell_idx < len(bars):
        sell_bar = bars[sell_idx]
        previous_sell = bars[sell_idx - 1]
        if not _limit_down(sell_bar, previous_sell, config.limit_pct):
            break
        sell_idx += 1
    if sell_idx >= len(bars):
        return {"status": "SKIPPED", "code": code, "reason": "sell blocked by limit-down until sample end"}

    sell_bar = bars[sell_idx]
    sell_price = (stop_price if stop_triggered else sell_bar.open) * (1 - config.slippage_bps / 10000)
    buy_gross = buy_price * quantity
    sell_gross = sell_price * quantity
    total_fee = _fees(buy_gross, "BUY", config) + _fees(sell_gross, "SELL", config)
    pnl = sell_gross - buy_gross - total_fee
    capital = buy_gross + _fees(buy_gross, "BUY", config)
    return_pct = pnl / capital * 100 if capital > 0 else 0.0
    return {
        "status": "FILLED",
        "mode": "historical_event",
        "code": code,
        "name": name,
        "buy_date": buy_bar.trade_date.isoformat(),
        "sell_date": sell_bar.trade_date.isoformat(),
        "buy_price": round(buy_price, 3),
        "sell_price": round(sell_price, 3),
        "quantity": quantity,
        "gross": round(buy_gross, 2),
        "fee": round(total_fee, 2),
        "pnl": round(pnl, 2),
        "return_pct": round(return_pct, 2),
        "hold_days": (sell_bar.trade_date - buy_bar.trade_date).days,
        "exit_reason": "STOP_LOSS" if stop_triggered else "HOLD_DAYS",
    }


def summarize_trades(
    trades: list[dict[str, Any]],
    skipped: list[str],
    config: BacktestConfig,
    mode: str,
) -> dict[str, Any]:
    returns = [float(item["return_pct"]) for item in trades]
    pnl = [float(item["pnl"]) for item in trades]
    return {
        "mode": mode,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "config": config.__dict__,
        "metrics": {
            "closedTrades": len(trades),
            "skipped": len(skipped),
            "winRatePct": round(sum(1 for item in returns if item > 0) / len(returns) * 100, 2) if returns else None,
            "averageReturnPct": round(sum(returns) / len(returns), 2) if returns else None,
            "totalPnl": round(sum(pnl), 2) if pnl else 0,
            "bestReturnPct": round(max(returns), 2) if returns else None,
            "worstReturnPct": round(min(returns), 2) if returns else None,
            "maxDrawdownPct": max_drawdown(returns) if returns else None,
        },
        "trades": trades[:200],
        "skippedSamples": skipped[:50],
        "rules": [
            "T+1: sell index is always after buy index",
            "limit-up open blocks buys",
            "limit-down open delays sells",
            "commission, stamp tax and slippage included",
            "single order size capped by max volume participation",
            "entry signal is evaluated on the previous completed bar",
            "ST/delisting names are excluded by default",
            "fixed stop loss is applied before hold-days exit",
        ],
    }


def max_drawdown(returns: list[float]) -> float:
    equity = 1.0
    peak = 1.0
    worst = 0.0
    for item in returns:
        equity *= 1 + item / 100
        peak = max(peak, equity)
        worst = min(worst, (equity / peak - 1) * 100)
    return round(abs(worst), 2)
