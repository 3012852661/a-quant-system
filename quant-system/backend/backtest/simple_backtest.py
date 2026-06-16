from __future__ import annotations

from backend.data.models import BacktestResult, BacktestTrade, KLine


def max_drawdown(returns: list[float]) -> float:
    equity = 1.0
    peak = 1.0
    worst = 0.0
    for item in returns:
        equity *= 1 + item / 100
        peak = max(peak, equity)
        drawdown = (equity / peak - 1) * 100
        worst = min(worst, drawdown)
    return round(abs(worst), 2)


def run_hold_days_backtest(
    codes: list[str],
    quote_lookup,
    kline_loader,
    hold_days: int = 5,
) -> BacktestResult:
    trades: list[BacktestTrade] = []
    for code in codes:
        quote = quote_lookup(code)
        klines: list[KLine] = kline_loader(code, 260)
        if len(klines) <= hold_days + 20:
            continue
        for idx in range(20, len(klines) - hold_days):
            buy = klines[idx]
            sell = klines[idx + hold_days]
            if buy.close <= 0:
                continue
            return_pct = (sell.close / buy.close - 1) * 100
            trades.append(
                BacktestTrade(
                    code=code,
                    name=quote.name if quote else code,
                    buy_date=buy.trade_date,
                    sell_date=sell.trade_date,
                    buy_price=round(buy.close, 2),
                    sell_price=round(sell.close, 2),
                    return_pct=round(return_pct, 2),
                )
            )

    returns = [trade.return_pct for trade in trades]
    total_return = 1.0
    for item in returns:
        total_return *= 1 + item / 100
    return BacktestResult(
        strategy=f"趋势突破持有{hold_days}日",
        trades=trades,
        total_return_pct=round((total_return - 1) * 100, 2) if trades else 0,
        win_rate_pct=round(sum(1 for item in returns if item > 0) / len(returns) * 100, 2) if trades else 0,
        average_return_pct=round(sum(returns) / len(returns), 2) if trades else 0,
        max_drawdown_pct=max_drawdown(returns),
    )
