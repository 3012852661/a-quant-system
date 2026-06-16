from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


RiskLevel = Literal["低", "中", "高"]


class StockQuote(BaseModel):
    code: str
    name: str
    price: float
    pct: float = Field(description="当日涨跌幅，单位 %")
    volume: float | None = None
    amount: float | None = None
    turnover: float | None = None
    volume_ratio: float | None = None
    market_cap: float | None = None
    main_net: float | None = None
    industry: str | None = None


class FinancialSnapshot(BaseModel):
    code: str
    report_date: date | None = None
    revenue: float | None = None
    net_profit: float | None = None
    gross_margin: float | None = None
    roe: float | None = None
    debt_to_assets: float | None = None
    eps: float | None = None
    source: str = "tushare"


class Announcement(BaseModel):
    code: str
    title: str
    announcement_date: date | None = None
    url: str | None = None
    category: str | None = None
    source: str = "cninfo"


class MoneyFlow(BaseModel):
    code: str
    name: str | None = None
    trade_date: date | None = None
    main_net: float | None = None
    main_net_pct: float | None = None
    super_large_net: float | None = None
    large_net: float | None = None
    medium_net: float | None = None
    small_net: float | None = None
    source: str = "eastmoney"


class KLine(BaseModel):
    trade_date: date
    open: float
    close: float
    high: float
    low: float
    volume: float
    amount: float | None = None


class StockSignal(BaseModel):
    code: str
    name: str
    current_price: float
    pct: float
    volume_ratio: float
    trend_score: float
    risk_level: RiskLevel
    ai_comment: str
    reasons: list[str]


class BacktestTrade(BaseModel):
    code: str
    name: str
    buy_date: date
    sell_date: date
    buy_price: float
    sell_price: float
    return_pct: float


class BacktestResult(BaseModel):
    strategy: str
    trades: list[BacktestTrade]
    total_return_pct: float
    win_rate_pct: float
    average_return_pct: float
    max_drawdown_pct: float
