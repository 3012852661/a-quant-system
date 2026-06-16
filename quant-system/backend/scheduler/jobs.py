from __future__ import annotations

from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler

from backend.data.providers import get_provider
from backend.strategy.trend_breakout import run_trend_breakout


def run_daily_selection(limit: int = 30) -> dict:
    provider = get_provider()
    quotes = provider.list_a_shares()
    signals = run_trend_breakout(quotes, provider.get_daily_kline, limit=limit)
    return {
        "run_at": datetime.now().isoformat(timespec="seconds"),
        "count": len(signals),
        "signals": [item.model_dump() for item in signals],
    }


def create_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
    scheduler.add_job(
        run_daily_selection,
        "cron",
        day_of_week="mon-fri",
        hour=15,
        minute=20,
        id="daily-selection",
        replace_existing=True,
    )
    return scheduler
