from __future__ import annotations

import argparse
import csv
import json
import os
import re
import signal
import sys
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.data.providers import AkShareProvider, EastMoneyDirectProvider, ProviderUnavailable
from backend.db import create_database_engine, init_db, stock_pool


LIVE_PROVIDER_TIMEOUT_SECONDS = 25
SHANGHAI_TZ = timezone(timedelta(hours=8))


POLICY_THEME_WEIGHTS: tuple[tuple[str, int, str, str], ...] = (
    (
        r"半导体|先进封装|HBM|玻璃基板|Chiplet|PCB|存储|芯片|封测|算力|CPO|光模块|通信|服务器|君正|兆易|长电|通富|华天|沪电|鹏鼎|中京|兴森|晶方|深科技|太极实业|烽火",
        18,
        "半导体/PCB/通信算力",
        "政策主线：半导体、先进封装、PCB、AI算力、国产替代",
    ),
    (
        r"机器人|执行器|减速器|丝杠|汽车|智驾|热管理|动力|拓普|三花|中大力德|巨轮|潍柴|飞龙",
        15,
        "机器人/汽车链",
        "政策主线：机器人、智能汽车、汽车零部件",
    ),
    (
        r"新型显示|OLED|Mini.?LED|Micro.?LED|消费电子|京东方|TCL|木林森|深科技|光电|面板",
        13,
        "新型显示/消费电子",
        "政策主线：新型显示、消费电子、AI终端硬件",
    ),
    (
        r"电网|电力|新能源|风电|光伏|储能|电缆|电瓷|特高压|中天|杭电|大连电瓷",
        9,
        "电力/新能源/电网",
        "政策主线：电网设备、新能源基础设施",
    ),
    (
        r"有色|铜|铝|锗|钽|稀土|材料|新材|巨石|云南锗业|东方钽业|有研",
        8,
        "有色/小金属/材料",
        "政策主线：半导体材料、资源品和关键材料",
    ),
)


@dataclass
class Signal:
    trade_date: str
    code: str
    name: str
    current_price: float
    pct_chg: float
    turnover: float
    volume_ratio: float
    market_cap: float
    score: float
    risk_level: str
    tier: str
    action: str
    recommendation_type: str
    holding_period: str
    momentum_score: float
    volume_score: float
    liquidity_score: float
    fund_score: float
    penalty_score: float
    buy_zone: str
    stop_loss: float
    target_price: float
    position_hint: str
    ai_comment: str
    execution_status: str
    execution_note: str
    min_order_shares: int
    strategy_name: str
    strategy_stage: str
    strategy_thesis: str
    entry_conditions: list[str]
    invalidation_conditions: list[str]
    risk_points: list[str]
    primary_theme: str
    theme_rank: int
    theme_heat_score: float
    theme_leader_role: str
    open_pct: float
    high_fade_pct: float
    confirmation_status: str
    opening_checklist: list[str]
    no_buy_conditions: list[str]
    reasons: list[str]


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, "", "-"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_trade_date(value: str | None) -> date:
    if not value:
        return date.today()
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"invalid trade date: {value}")


def load_rows(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as file:
            return [dict(row) for row in csv.DictReader(file)]

    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]

    rows: list[dict[str, Any]] = []
    if isinstance(payload.get("signals"), list):
        rows.extend(item for item in payload["signals"] if isinstance(item, dict))
    for key in (
        "stocks",
        "rows",
        "recommendedBuys",
        "actionable",
        "tactical",
        "trade",
        "watch",
        "strongNotLimit",
        "qualityPool",
        "fundTop",
        "attack",
    ):
        value = payload.get(key)
        if isinstance(value, list):
            rows.extend(item for item in value if isinstance(item, dict))
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for row in rows:
        code = str(row.get("code", "")).zfill(6)
        if not code or code in seen:
            continue
        seen.add(code)
        unique.append(row)
    return unique


def quote_rows_from_provider(provider: Any, limit: int | None = None) -> list[dict[str, Any]]:
    quotes = provider.list_a_shares(limit=limit)
    return [
        {
            "code": quote.code,
            "name": quote.name,
            "price": quote.price,
            "pct": quote.pct,
            "volume": quote.volume,
            "amount": quote.amount,
            "turnover": quote.turnover,
            "volumeRatio": quote.volume_ratio,
            "marketCap": quote.market_cap,
            "mainNet": quote.main_net,
            "industry": quote.industry,
            "quoteTime": quote.quote_time,
        }
        for quote in quotes
    ]


def market_prefix(code: str) -> str:
    normalized = str(code).zfill(6)
    return "sh" if normalized.startswith(("5", "6", "9")) else "sz"


def known_universe(limit: int | None = None) -> list[dict[str, str]]:
    candidates = [
        repo_root() / "reports/data/user-watchlist.json",
        repo_root() / "reports/data/latest-user-watchlist-review.json",
        repo_root() / "reports/data/user-watchlist-attribution.json",
        repo_root() / "quant-system/backend/data/stock_pool_latest.json",
        repo_root() / "reports/data/live-tencent-candidate-quotes.json",
        repo_root() / "reports/data/latest-free-a-share-scan.brief.json",
        default_input_path(),
    ]
    candidates.extend(sorted((repo_root() / "quant-system/data").glob("stock_pool_*.csv"), reverse=True))
    candidates.append(repo_root() / "outputs/quant_analysis_20260615/量化分析全表_20260615.csv")
    seen: set[str] = set()
    universe: list[dict[str, str]] = []
    for path in candidates:
        if not has_rows(path):
            continue
        for row in load_rows(path):
            code = str(row.get("code") or row.get("代码") or "").zfill(6)
            name = str(row.get("name") or row.get("真实简称") or row.get("输入名称") or "")
            if not code or code in seen:
                continue
            seen.add(code)
            universe.append({"code": code, "name": name})
            if limit and len(universe) >= limit:
                return universe
    return universe


def parse_tencent_quote(text: str, name_by_code: dict[str, str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in text.split(";"):
        item = item.strip()
        if not item:
            continue
        value = item.split("=", 1)[1].strip().strip('"') if "=" in item else ""
        parts = value.split("~")
        if len(parts) < 50:
            continue
        code = str(parts[2] or "").zfill(6)
        price = to_float(parts[3])
        if not code or price <= 0:
            continue
        total_mv_yi = to_float(parts[45], default=0)
        amount_yi = to_float(parts[37], default=0) / 10000
        rows.append(
            {
                "code": code,
                "name": name_by_code.get(code) or parts[1] or "",
                "price": price,
                "pct": to_float(parts[32]),
                "change": to_float(parts[31]),
                "turnover": to_float(parts[38]),
                "amount": amount_yi * 100000000,
                "marketCap": total_mv_yi * 100000000,
                "volumeRatio": to_float(parts[49], default=1),
                "prevClose": to_float(parts[4], default=0),
                "open": to_float(parts[5], default=0),
                "high": to_float(parts[33], default=0),
                "low": to_float(parts[34], default=0),
                "mainNet": 0,
                "industry": "",
                "time": parts[30] or "",
                "quoteTime": parts[30] or "",
            }
        )
    return rows


def eastmoney_secid(code: str) -> str:
    normalized = str(code).zfill(6)
    market = "1" if normalized.startswith(("5", "6", "9")) else "0"
    return f"{market}.{normalized}"


def eastmoney_ulist_rows(limit: int | None = None) -> list[dict[str, Any]]:
    """Fetch realtime EastMoney quotes for the known candidate universe.

    This is not a full-market scan. It exists as a real quote verifier when
    EastMoney's paged market list is unstable but per-symbol quote lookup works.
    """

    universe = known_universe(limit or settings_limit())
    if not universe:
        raise RuntimeError("no known universe for EastMoney ulist quotes")
    name_by_code = {item["code"]: item["name"] for item in universe}
    rows: list[dict[str, Any]] = []
    fields = "f12,f14,f2,f3,f4,f5,f6,f8,f10,f15,f16,f17,f18,f20,f21,f23,f62,f184,f100,f124"
    for index in range(0, len(universe), 80):
        chunk = universe[index : index + 80]
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get?" + urlencode(
            {
                "fltt": 2,
                "secids": ",".join(eastmoney_secid(item["code"]) for item in chunk),
                "fields": fields,
            }
        )
        request = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://quote.eastmoney.com/",
                "Accept": "application/json,text/plain,*/*",
            },
        )
        try:
            with urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError(str(exc)) from exc
        for row in (payload.get("data") or {}).get("diff") or []:
            code = str(row.get("f12") or "").zfill(6)
            price = to_float(row.get("f2"))
            if not code or price <= 0:
                continue
            rows.append(
                {
                    "code": code,
                    "name": str(row.get("f14") or name_by_code.get(code) or ""),
                    "price": price,
                    "pct": to_float(row.get("f3")),
                    "change": to_float(row.get("f4")),
                    "volume": to_float(row.get("f5"), default=0),
                    "amount": to_float(row.get("f6"), default=0),
                    "turnover": to_float(row.get("f8"), default=0),
                    "volumeRatio": to_float(row.get("f10"), default=1),
                    "marketCap": to_float(row.get("f20"), default=0),
                    "floatCap": to_float(row.get("f21"), default=0),
                    "high": to_float(row.get("f15"), default=0),
                    "low": to_float(row.get("f16"), default=0),
                    "open": to_float(row.get("f17"), default=0),
                    "prevClose": to_float(row.get("f18"), default=0),
                    "mainNet": to_float(row.get("f62"), default=0),
                    "mainNetPct": to_float(row.get("f184"), default=0),
                    "industry": str(row.get("f100") or ""),
                    "quoteTime": row.get("f124"),
                }
            )
    if not rows:
        raise RuntimeError("EastMoney ulist returned no live quote rows")
    return rows[: limit or len(rows)]


def quote_time_to_datetime(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.isdigit():
        if len(text) == 14:
            try:
                return datetime.strptime(text, "%Y%m%d%H%M%S").replace(tzinfo=SHANGHAI_TZ)
            except ValueError:
                return None
        try:
            return datetime.fromtimestamp(int(text), tz=SHANGHAI_TZ)
        except (OverflowError, OSError, ValueError):
            return None
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            parsed = datetime.strptime(text[:19], fmt)
            return parsed.replace(tzinfo=SHANGHAI_TZ)
        except ValueError:
            continue
    return None


def validate_live_rows(rows: list[dict[str, Any]], label: str, trade_date: date) -> None:
    if not rows:
        raise RuntimeError(f"{label} returned no quote rows")
    quote_times = [quote_time_to_datetime(row.get("quoteTime") or row.get("time")) for row in rows]
    dated = [item for item in quote_times if item is not None]
    if not dated:
        raise RuntimeError(f"{label} returned rows without verifiable quote timestamps")
    latest = max(dated)
    if latest.date() != trade_date:
        raise RuntimeError(f"{label} latest quote date {latest.date().isoformat()} != trade date {trade_date.isoformat()}")


def row_trade_date(row: dict[str, Any]) -> date | None:
    quote_time = quote_time_to_datetime(row.get("quoteTime") or row.get("time"))
    if quote_time:
        return quote_time.date()
    text = str(row.get("trade_date") or row.get("tradeDate") or "").strip()
    if not text:
        return None
    try:
        return parse_trade_date(text)
    except ValueError:
        return None


def validate_input_rows(rows: list[dict[str, Any]], label: str, trade_date: date, allow_stale: bool) -> date | None:
    dated = [item for row in rows if (item := row_trade_date(row)) is not None]
    if not dated:
        if allow_stale:
            return None
        raise RuntimeError(f"{label} lacks verifiable quote/trade dates; pass --allow-stale-input for offline demos")
    latest = max(dated)
    if latest != trade_date and not allow_stale:
        raise RuntimeError(
            f"{label} latest row date {latest.isoformat()} != requested trade date {trade_date.isoformat()}; "
            "refusing to stamp stale data as current"
        )
    return latest


def tencent_live_rows(limit: int | None = None) -> list[dict[str, Any]]:
    universe = known_universe(limit or settings_limit())
    if not universe:
        raise RuntimeError("no known universe for Tencent live quotes")
    name_by_code = {item["code"]: item["name"] for item in universe}
    rows: list[dict[str, Any]] = []
    chunk_size = 60
    for index in range(0, len(universe), chunk_size):
        chunk = universe[index : index + chunk_size]
        query = ",".join(f"{market_prefix(item['code'])}{item['code']}" for item in chunk)
        text = ""
        errors: list[str] = []
        for scheme in ("https", "http"):
            url = f"{scheme}://qt.gtimg.cn/?" + urlencode({"q": query})
            request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            for _ in range(3):
                try:
                    with urlopen(request, timeout=15) as response:
                        text = response.read().decode("gbk", errors="ignore")
                    break
                except (HTTPError, URLError, TimeoutError) as exc:
                    errors.append(str(exc))
            if text:
                break
        if not text:
            raise RuntimeError("; ".join(errors[-3:]) or "Tencent request failed")
        rows.extend(parse_tencent_quote(text, name_by_code))
    if not rows:
        raise RuntimeError("Tencent returned no live quote rows")
    return rows[: limit or len(rows)]


def user_watchlist_universe() -> list[dict[str, str]]:
    path = repo_root() / "reports/data/user-watchlist.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_rows = payload.get("stocks") if isinstance(payload, dict) else []
    if not isinstance(raw_rows, list):
        return []
    universe: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in raw_rows:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or row.get("股票代码") or "").replace(".", "").zfill(6)
        name = str(row.get("name") or row.get("股票名称") or "").strip()
        raw_theme = str(row.get("theme") or "").strip()
        theme = infer_watchlist_theme(name) if raw_theme in {"", "其他"} else raw_theme
        if not code or code in seen:
            continue
        seen.add(code)
        universe.append({"code": code, "name": name, "theme": theme})
    return universe


def infer_watchlist_theme(name: str) -> str:
    text = str(name or "")
    tags: list[str] = []
    if re.search(r"电力|华能|华电|风电|能源|新能|西电|电缆|电瓷|光伏|中环|三峡", text):
        tags.append("电力/新能源/电网")
    if re.search(r"半导体|芯|微|PCB|电子|通信|光电|科技|君正|兆易|长电|通富|沪电|鹏鼎|京东方|TCL|网宿|烽火|中京|兴森|晶方|木林森", text):
        tags.append("半导体/PCB/通信算力")
    if re.search(r"铜|铝|稀土|矿业|钽|锗|有研|金田|北方", text):
        tags.append("有色/小金属")
    if re.search(r"机器人|智能|汽车|动力|拓普|三花|潍柴|徐工|中大力德|巨轮", text):
        tags.append("机器人/汽车链")
    if re.search(r"传媒|广告|在线|互联|省广|引力|天地", text):
        tags.append("传媒互联网")
    if re.search(r"ST|退|皇庭|雅博|洲际", text):
        tags.append("ST/困境反转")
    return "、".join(tags)


def tencent_rows_for_universe(universe: list[dict[str, str]]) -> list[dict[str, Any]]:
    if not universe:
        return []
    name_by_code = {item["code"]: item["name"] for item in universe}
    theme_by_code = {item["code"]: item.get("theme", "") for item in universe}
    rows: list[dict[str, Any]] = []
    chunk_size = 60
    for index in range(0, len(universe), chunk_size):
        chunk = universe[index : index + chunk_size]
        query = ",".join(f"{market_prefix(item['code'])}{item['code']}" for item in chunk)
        url = "https://qt.gtimg.cn/?" + urlencode({"q": query})
        request = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(request, timeout=15) as response:
            text = response.read().decode("gbk", errors="ignore")
        for row in parse_tencent_quote(text, name_by_code):
            row["userWatchlistTheme"] = theme_by_code.get(str(row.get("code") or "").zfill(6), "")
            rows.append(row)
    return rows


def supplement_eastmoney_metrics(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Best-effort enrichment for money flow and industry fields.

    Tencent quotes are fast and reliable for price, but they do not expose the
    main-fund fields used by the ranking model. EastMoney ulist is cheaper than
    a full-market scan and lets us avoid treating "funds unknown" as neutral.
    """

    if not rows:
        return rows
    by_code = {str(row.get("code") or "").zfill(6): dict(row) for row in rows}
    fields = "f12,f14,f2,f3,f6,f8,f10,f15,f16,f17,f18,f20,f21,f62,f184,f100,f124"
    codes = list(by_code)
    for index in range(0, len(codes), 80):
        chunk = codes[index : index + 80]
        url = "https://push2.eastmoney.com/api/qt/ulist.np/get?" + urlencode(
            {
                "fltt": 2,
                "secids": ",".join(eastmoney_secid(code) for code in chunk),
                "fields": fields,
            }
        )
        request = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://quote.eastmoney.com/",
                "Accept": "application/json,text/plain,*/*",
            },
        )
        try:
            with urlopen(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
            continue
        for item in (payload.get("data") or {}).get("diff") or []:
            code = str(item.get("f12") or "").zfill(6)
            if code not in by_code:
                continue
            by_code[code].update(
                {
                    "mainNet": to_float(item.get("f62"), default=0),
                    "mainNetPct": to_float(item.get("f184"), default=0),
                    "industry": str(item.get("f100") or by_code[code].get("industry") or ""),
                    "marketCap": to_float(item.get("f20"), default=to_float(by_code[code].get("marketCap"))),
                    "floatCap": to_float(item.get("f21"), default=to_float(by_code[code].get("floatCap"))),
                    "high": to_float(item.get("f15"), default=to_float(by_code[code].get("high"))),
                    "low": to_float(item.get("f16"), default=to_float(by_code[code].get("low"))),
                    "open": to_float(item.get("f17"), default=to_float(by_code[code].get("open"))),
                    "prevClose": to_float(item.get("f18"), default=to_float(by_code[code].get("prevClose"))),
                    "moneyFlowSource": "eastmoney:ulist",
                    "eastmoneyQuoteTime": item.get("f124"),
                }
            )
    for row in by_code.values():
        row.setdefault("moneyFlowSource", "unavailable")
    return [by_code[str(row.get("code") or "").zfill(6)] for row in rows]


def theme_tags(value: Any) -> list[str]:
    tags = [item.strip() for item in str(value or "").replace(",", "、").split("、") if item.strip()]
    return [item for item in tags if item != "其他"]


def watchlist_limit_state(code: str, name: str, pct: float) -> str:
    threshold = limit_up_threshold(code, name)
    if pct >= threshold - 0.05:
        return "LIMIT_UP"
    if pct >= threshold - 0.6:
        return "NEAR_LIMIT"
    if pct >= 5.0:
        return "STRONG"
    return "NORMAL"


def watchlist_emotion_score(row: dict[str, Any], theme_breadth: int) -> float:
    pct = to_float(row.get("pct"))
    volume_ratio = to_float(row.get("volumeRatio"), default=1.0)
    turnover = to_float(row.get("turnover"), default=0.0)
    score = 0.0
    if pct >= 9:
        score += 42
    elif pct >= 7:
        score += 32
    elif pct >= 5:
        score += 24
    elif pct >= 3:
        score += 15
    if volume_ratio >= 3:
        score += 22
    elif volume_ratio >= 2:
        score += 15
    elif volume_ratio >= 1.3:
        score += 8
    if turnover >= 10:
        score += 12
    elif turnover >= 5:
        score += 8
    elif turnover >= 3:
        score += 4
    if theme_breadth >= 10:
        score += 18
    elif theme_breadth >= 6:
        score += 12
    elif theme_breadth >= 3:
        score += 6
    return min(100.0, score)


def merge_user_watchlist_rows(rows: list[dict[str, Any]], trade_date: date) -> tuple[list[dict[str, Any]], int]:
    """Add the user's watchlist as a first-class realtime input lane.

    The full-market scanner may truncate before user-supplied names appear. The
    watchlist lane protects against that by always checking the user's universe
    and tagging strong rows so sorting can surface them for review.
    """

    try:
        watch_rows = tencent_rows_for_universe(user_watchlist_universe())
        validate_live_rows(watch_rows, "tencent:user-watchlist", trade_date)
        watch_rows = supplement_eastmoney_metrics(watch_rows)
    except (OSError, RuntimeError, TimeoutError, json.JSONDecodeError):
        return rows, 0

    theme_breadth: dict[str, int] = {}
    for row in watch_rows:
        if to_float(row.get("pct")) < 3.0:
            continue
        for tag in theme_tags(row.get("userWatchlistTheme")):
            theme_breadth[tag] = theme_breadth.get(tag, 0) + 1

    merged = {str(row.get("code") or "").zfill(6): dict(row) for row in rows}
    added_or_tagged = 0
    for row in watch_rows:
        code = str(row.get("code") or "").zfill(6)
        pct = to_float(row.get("pct"))
        volume_ratio = to_float(row.get("volumeRatio"), default=1.0)
        turnover = to_float(row.get("turnover"), default=0.0)
        threshold = limit_up_threshold(code, str(row.get("name") or ""))
        max_theme_breadth = max((theme_breadth.get(tag, 0) for tag in theme_tags(row.get("userWatchlistTheme"))), default=0)
        emotion_score = watchlist_emotion_score(row, max_theme_breadth)
        limit_state = watchlist_limit_state(code, str(row.get("name") or ""), pct)
        is_priority = (
            pct >= threshold - 0.6
            or pct >= 5.0
            or (pct >= 3.0 and volume_ratio >= 1.5)
            or (pct >= 3.0 and turnover >= 3.0)
            or (max_theme_breadth >= 6 and pct >= 3.0)
            or emotion_score >= 55
        )
        if not is_priority:
            continue
        tagged = {
            **row,
            "userWatchlistPriority": True,
            "userWatchlistThemeBreadth": max_theme_breadth,
            "userWatchlistEmotionScore": emotion_score,
            "userWatchlistLimitState": limit_state,
        }
        if code in merged:
            merged[code].update(tagged)
        else:
            merged[code] = tagged
        added_or_tagged += 1
    return list(merged.values()), added_or_tagged


def settings_limit() -> int:
    return int(os.getenv("QUANT_MAX_STOCKS", "500") or "500")


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp_path.write_text(text, encoding=encoding)
    os.replace(tmp_path, path)


@contextmanager
def timeout(seconds: int, label: str):
    def handle_timeout(signum, frame):  # type: ignore[no-untyped-def]
        raise TimeoutError(f"{label} timed out after {seconds}s")

    previous = signal.signal(signal.SIGALRM, handle_timeout)
    signal.alarm(seconds)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def live_rows(
    limit: int | None = None,
    allow_fallback: bool = False,
    trade_date: date | None = None,
) -> tuple[list[dict[str, Any]], str]:
    expected_trade_date = trade_date or date.today()
    attempts = [
        ("eastmoney:push2-clist", EastMoneyDirectProvider),
        ("akshare:stock_zh_a_spot_em", AkShareProvider),
    ]
    if os.getenv("QUANT_SKIP_AKSHARE_LIVE", "false").lower() in {"1", "true", "yes"}:
        attempts = [attempt for attempt in attempts if not attempt[0].startswith("akshare:")]
    failures: list[str] = []
    for label, factory in attempts:
        try:
            with timeout(LIVE_PROVIDER_TIMEOUT_SECONDS, label):
                rows = quote_rows_from_provider(factory(), limit=limit)
        except (RuntimeError, ProviderUnavailable, OSError, TimeoutError) as exc:
            failures.append(f"{label} failed: {exc}")
            continue
        if rows:
            try:
                validate_live_rows(rows, label, expected_trade_date)
            except RuntimeError as exc:
                failures.append(f"{label} stale/unverifiable: {exc}")
                continue
            if failures:
                print("; ".join(failures), file=sys.stderr)
            return rows, label
        failures.append(f"{label} returned no rows")

    try:
        with timeout(LIVE_PROVIDER_TIMEOUT_SECONDS, "eastmoney:ulist-known-universe"):
            rows = eastmoney_ulist_rows(limit)
            validate_live_rows(rows, "eastmoney:ulist-known-universe", expected_trade_date)
    except (RuntimeError, OSError, TimeoutError) as exc:
        failures.append(f"eastmoney:ulist-known-universe failed: {exc}")
    else:
        if rows:
            print("; ".join(failures), file=sys.stderr)
            return rows, "eastmoney:ulist-known-universe"
        failures.append("eastmoney:ulist-known-universe returned no rows")

    try:
        with timeout(LIVE_PROVIDER_TIMEOUT_SECONDS, "tencent:known-universe"):
            rows = tencent_live_rows(limit)
            validate_live_rows(rows, "tencent:known-universe", expected_trade_date)
    except (RuntimeError, OSError, TimeoutError) as exc:
        failures.append(f"tencent:known-universe failed: {exc}")
    else:
        if rows:
            print("; ".join(failures), file=sys.stderr)
            return rows, "tencent:known-universe"
        failures.append("tencent:known-universe returned no rows")

    fallback = default_input_path()
    if allow_fallback and has_rows(fallback):
        print("; ".join(failures), file=sys.stderr)
        return load_rows(fallback), f"fallback:{fallback}"
    raise RuntimeError("; ".join(failures) or "no live providers configured")


def has_rows(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        if path.suffix.lower() == ".csv":
            with path.open("r", encoding="utf-8-sig", newline="") as file:
                return any(True for _ in csv.DictReader(file))
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if isinstance(payload, list) and payload:
        return True
    if isinstance(payload.get("signals"), list) and payload["signals"]:
        return True
    return any(
        isinstance(payload.get(key), list) and payload[key]
        for key in ("actionable", "trade", "watch", "strongNotLimit", "selected", "qualityPool")
    )


def default_input_path() -> Path:
    root = repo_root()
    candidates = [
        root / "reports/data/latest-free-a-share-scan.brief.json",
        root / "quant-system/backend/data/stock_pool_latest.json",
        root / "quant-system/data/stock_pool_2026-06-05.csv",
    ]
    for candidate in candidates:
        if has_rows(candidate):
            return candidate
    return candidates[0]


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def band_score(value: float, ideal_low: float, ideal_high: float, hard_low: float, hard_high: float) -> float:
    if ideal_low <= value <= ideal_high:
        return 100
    if value < ideal_low:
        if value <= hard_low:
            return 0
        return (value - hard_low) / (ideal_low - hard_low) * 100
    if value >= hard_high:
        return 0
    return (hard_high - value) / (hard_high - ideal_high) * 100


def policy_theme_score(name: str, theme: str = "", industry: str = "") -> tuple[int, str, str]:
    text = f"{name} {theme} {industry}"
    best_score = 0
    best_theme = ""
    best_reason = ""
    for pattern, score, label, reason in POLICY_THEME_WEIGHTS:
        if re.search(pattern, text, re.IGNORECASE):
            if score > best_score:
                best_score = score
                best_theme = label
                best_reason = reason
    return best_score, best_theme, best_reason


def load_theme_context() -> dict[str, Any]:
    path = repo_root() / "reports/data/latest-user-watchlist-review.json"
    if not path.exists():
        return {"by_code": {}, "by_theme": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"by_code": {}, "by_theme": {}}

    by_theme: dict[str, dict[str, Any]] = {}
    for rank, item in enumerate(payload.get("themeBreadth") or [], start=1):
        if not isinstance(item, dict):
            continue
        theme = str(item.get("theme") or "").strip()
        if not theme:
            continue
        by_theme[theme] = {
            "themeRank": rank,
            "themeHeatScore": to_float(item.get("heatScore"), default=0),
            "themeTotal": to_float(item.get("total"), default=0),
            "themeLimitCount": to_float(item.get("limitCount"), default=0),
            "themeNearLimitCount": to_float(item.get("nearLimitCount"), default=0),
            "themeStrongCount": to_float(item.get("strongCount"), default=0),
            "themeFlaggedCount": to_float(item.get("flaggedCount"), default=0),
            "themeMissedCount": to_float(item.get("missedCount"), default=0),
            "themeLeaders": item.get("leaders") if isinstance(item.get("leaders"), list) else [],
        }

    by_code: dict[str, dict[str, Any]] = {}
    for row in payload.get("rows") or []:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or "").zfill(6)
        if not code:
            continue
        theme = str(row.get("primaryTheme") or row.get("theme") or "").split("、")[0].strip()
        theme_info = dict(by_theme.get(theme, {}))
        by_code[code] = {
            **theme_info,
            "userWatchlistTheme": str(row.get("theme") or theme),
            "primaryTheme": theme,
            "themeRank": row.get("themeRank") or theme_info.get("themeRank"),
            "themeLeaderRole": row.get("leaderRole") or "",
            "themeLeaderRank": 1
            if row.get("leaderRole") == "题材龙头"
            else 2
            if row.get("leaderRole") == "前排核心"
            else 3
            if row.get("leaderRole") == "前排跟踪"
            else 0,
            "themeNextAction": row.get("nextAction") or "",
            "userWatchlistEmotionScore": row.get("emotionScore") or 0,
            "userWatchlistLimitState": row.get("limitState") or "",
            "userWatchlistThemeBreadth": row.get("themeBreadth") or theme_info.get("themeFlaggedCount") or 0,
        }
    return {"by_code": by_code, "by_theme": by_theme}


def enrich_rows_with_theme_context(rows: list[dict[str, Any]], context: dict[str, Any]) -> list[dict[str, Any]]:
    by_code: dict[str, dict[str, Any]] = context.get("by_code") or {}
    by_theme: dict[str, dict[str, Any]] = context.get("by_theme") or {}
    enriched: list[dict[str, Any]] = []
    for row in rows:
        code = str(row.get("code") or "").zfill(6)
        merged = dict(row)
        context_row = by_code.get(code)
        if context_row:
            for key, value in context_row.items():
                if value in (None, ""):
                    continue
                if not merged.get(key):
                    merged[key] = value
            merged["themeContextSource"] = "latest-user-watchlist-review"
        else:
            _, policy_theme, _ = policy_theme_score(
                str(row.get("name") or ""),
                str(row.get("userWatchlistTheme") or ""),
                str(row.get("industry") or ""),
            )
            theme_info = by_theme.get(policy_theme)
            if theme_info:
                for key, value in theme_info.items():
                    merged.setdefault(key, value)
                merged.setdefault("primaryTheme", policy_theme)
                merged["themeContextSource"] = "theme-ladder"
        enriched.append(merged)
    return enriched


def load_latest_factor_scores(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if isinstance(payload, dict) and not payload.get("selectionEnabled", False):
        return {}
    rows = payload.get("scores") if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        return {}
    scores: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = str(row.get("code") or "").zfill(6)
        if not code:
            continue
        scores[code] = row
    return scores


def enrich_rows_with_factor_scores(rows: list[dict[str, Any]], factor_scores: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    if not factor_scores:
        return rows
    enriched: list[dict[str, Any]] = []
    for row in rows:
        code = str(row.get("code") or "").zfill(6)
        merged = dict(row)
        factor_row = factor_scores.get(code)
        if factor_row:
            merged["factorCompositeScore"] = factor_row.get("factorCompositeScore")
            merged["factorCompositeZ"] = factor_row.get("factorCompositeZ")
            merged["factorSource"] = "latest-factor-scores"
        enriched.append(merged)
    return enriched


def risk_level(price: float, pct: float, volume_ratio: float, turnover: float, penalty: float, score: float, hard_limit: bool) -> str:
    if hard_limit or price < 5 or pct > 6.7 or volume_ratio > 4.2 or turnover > 18 or penalty >= 22 or score < 68:
        return "高"
    if pct > 5.8 or volume_ratio > 2.8 or turnover > 12 or penalty >= 12 or score < 78:
        return "中"
    return "低"


def rule_comment(signal: Signal) -> str:
    tail = {
        "低": "形态较顺，但仍要等次日承接确认。",
        "中": "强度不错，追高风险抬升，适合等回踩确认。",
        "高": "短线拥挤或质量不足，仓位要轻，避免情绪高点接力。",
    }[signal.risk_level]
    return (
        f"{signal.name}{signal.strategy_name}评分{signal.score:.1f}，{signal.action}，计划持有{signal.holding_period}；"
        f"买入区间{signal.buy_zone}，止损{signal.stop_loss:.2f}，目标{signal.target_price:.2f}。"
        f"{signal.strategy_thesis}。{'，'.join(signal.entry_conditions[:2])}。{tail}"
    )


def score_components(
    price: float,
    pct_chg: float,
    volume_ratio: float,
    turnover: float,
    market_cap: float,
    main_net: float,
) -> tuple[float, float, float, float, float, float]:
    momentum = band_score(pct_chg, ideal_low=2.2, ideal_high=6.8, hard_low=-2.0, hard_high=9.5)
    volume = band_score(volume_ratio, ideal_low=1.1, ideal_high=3.0, hard_low=0.55, hard_high=5.6)
    turnover_score = band_score(turnover, ideal_low=2.0, ideal_high=12.0, hard_low=0.3, hard_high=24.0)

    if market_cap <= 0:
        cap_score = 55.0
    else:
        cap_yi = market_cap / 100000000
        cap_score = band_score(cap_yi, ideal_low=50, ideal_high=900, hard_low=15, hard_high=2500)
    liquidity = turnover_score * 0.55 + cap_score * 0.45

    fund = 50.0
    if main_net > 0:
        fund = 78.0
    elif main_net < 0:
        fund = 32.0

    penalty = 0.0
    if price < 5:
        penalty += 12
    if pct_chg > 6.5:
        penalty += min(12, (pct_chg - 6.5) * 8)
    if pct_chg > 8.8:
        penalty += min(28, (pct_chg - 8.8) * 12)
    if volume_ratio > 3.2:
        penalty += min(18, (volume_ratio - 3.2) * 10)
    if turnover > 14:
        penalty += min(16, (turnover - 14) * 2.5)
    if market_cap and market_cap < 3000000000:
        penalty += 10

    total = momentum * 0.34 + volume * 0.25 + liquidity * 0.18 + fund * 0.13 + 10 - penalty
    return clamp(total), momentum, volume, liquidity, fund, penalty


def human_context_adjustments(
    *,
    pct: float,
    volume_ratio: float,
    turnover: float,
    market_cap: float,
    main_net: float,
    main_net_pct: float,
    money_flow_source: str,
    open_pct: float,
    high_fade_pct: float,
    policy_score: int,
    theme_rank: float,
    theme_heat_score: float,
    theme_leader_rank: float,
    is_limit_review: bool,
) -> tuple[float, float | None, list[str], bool]:
    """Short-term A-share discretion layer.

    Base factors find strength. This layer asks the trader's questions: is it
    front-row, is money confirming, did it fade from the high, and is the
    strength tradable rather than crowded.
    """

    adjustment = 0.0
    score_cap: float | None = None
    reasons: list[str] = []
    force_middle_risk = False
    front_row = theme_leader_rank > 0 or (theme_rank and theme_rank <= 2)

    if pct < 0:
        adjustment -= 18
        score_cap = 68.0
        reasons.append("当日未转强，不能靠题材加分进入买入候选")
    elif pct < 1.2:
        adjustment -= 12
        score_cap = min(score_cap or 100.0, 74.0)
        reasons.append("涨幅不足，先当潜伏观察，不按短线买点处理")
    elif pct < 2.2:
        adjustment -= 6
        score_cap = min(score_cap or 100.0, 82.0)
        reasons.append("涨幅刚转强但确认不足，只保留回踩观察")

    if not is_limit_review and pct >= 7.2:
        adjustment -= 8
        score_cap = 86.0 if front_row or policy_score >= 13 else 80.0
        reasons.append("涨幅超过7%，按A股短线追高风险降权；非前排不按买点处理")
        force_middle_risk = True
    if high_fade_pct >= 5:
        adjustment -= 16
        score_cap = min(score_cap or 100.0, 74.0)
        reasons.append(f"冲高回落 {high_fade_pct:.1f}%，说明上方抛压重，降为观察")
        force_middle_risk = True
    elif high_fade_pct >= 2.5:
        adjustment -= 8
        score_cap = min(score_cap or 100.0, 82.0)
        reasons.append(f"冲高回落 {high_fade_pct:.1f}%，买点必须等次日修复")
        force_middle_risk = True
    if open_pct >= 3.5 and pct < open_pct - 0.8:
        adjustment -= 8
        score_cap = min(score_cap or 100.0, 80.0)
        reasons.append(f"高开后没有守住强度，开盘涨幅约 {open_pct:.1f}%")
        force_middle_risk = True

    if 0 < turnover < 0.6 and pct >= 3.5:
        adjustment -= 10
        score_cap = min(score_cap or 100.0, 78.0)
        reasons.append("换手不足但涨幅较强，容易是假强或流动性不足")
    elif 0 < turnover < 0.6 and pct < 2.2:
        adjustment -= 8
        score_cap = min(score_cap or 100.0, 72.0)
        reasons.append("低换手且当日强度不足，主题票也不能提前当买点")
    elif turnover >= 16:
        adjustment -= 9
        score_cap = min(score_cap or 100.0, 82.0)
        reasons.append("换手过高，筹码分歧偏大，不能当作低风险买点")
        force_middle_risk = True

    if volume_ratio >= 6:
        adjustment -= 14
        score_cap = min(score_cap or 100.0, 78.0)
        reasons.append("量比极端放大，短线拥挤度过高")
        force_middle_risk = True
    elif volume_ratio >= 4:
        adjustment -= 8
        score_cap = min(score_cap or 100.0, 84.0)
        reasons.append("量比偏热，优先等分歧承接")
        force_middle_risk = True

    if main_net < 0 and pct >= 3:
        adjustment -= 10
        reasons.append("上涨同时主力净流出，属于资金背离")
        force_middle_risk = True
        if main_net_pct <= -5:
            adjustment -= 6
            score_cap = min(score_cap or 100.0, 76.0)
            reasons.append(f"主力净流出占比 {abs(main_net_pct):.1f}%，买入闸门压低")
    elif main_net == 0 and money_flow_source == "unavailable" and pct >= 5:
        score_cap = min(score_cap or 100.0, 84.0)
        reasons.append("涨幅较高但资金数据缺失，不允许按资金确认票高评分")
        force_middle_risk = True

    if theme_heat_score >= 100 and not front_row and pct >= 4:
        adjustment -= 7
        score_cap = min(score_cap or 100.0, 82.0)
        reasons.append("强主题内非明确前排，按后排跟风票降权")
        force_middle_risk = True
    elif theme_heat_score >= 100 and pct < 2.2:
        adjustment -= 6
        score_cap = min(score_cap or 100.0, 74.0)
        reasons.append("板块热但个股没有同步表态，按后排潜伏观察")
    elif theme_rank and theme_rank > 3 and policy_score < 13 and pct >= 4:
        adjustment -= 5
        reasons.append("不在前三主线，强势持续性打折")

    if market_cap and market_cap < 3_500_000_000:
        adjustment -= 6
        reasons.append("小市值波动大，A股短线仓位和评分同步降级")

    return adjustment, score_cap, reasons, force_middle_risk


def classify(
    score: float,
    risk: str,
    pct_chg: float,
    volume_ratio: float,
    execution_status: str,
    policy_score: int = 0,
) -> tuple[str, str, str, str]:
    if execution_status == "BLOCKED_LIMIT_UP":
        return "C", "WATCH", "LIMIT_REVIEW", "封单/贴近涨停价，不能按普通买单假设成交；等开板或次日承接"
    if score >= 82 and execution_status in {"BUYABLE", "BUYABLE_CAUTION"} and 2.2 <= pct_chg <= 7.2 and 0.8 <= volume_ratio <= 4.0:
        if risk == "高":
            return "B", "WATCH", "SPECULATIVE_WATCH", "高风险只保留观察，除非盘中回踩后重新转强"
        return "A", "TRADE", "BUY_CANDIDATE", "单票不超过计划资金的10%，只在买入区间内分批"
    if (
        policy_score >= 13
        and score >= 86
        and risk != "高"
        and execution_status in {"BUYABLE", "BUYABLE_CAUTION"}
        and 3.0 <= pct_chg <= 9.6
        and 0.8 <= volume_ratio <= 5.5
    ):
        return "B", "TRADE", "THEME_DISAGREEMENT_BUY", "强主线分歧承接候选，单票不超过计划资金的5%，只等回踩不追冲高"
    if score >= 70:
        return "B", "WATCH", "WATCH_CANDIDATE", "单票不超过计划资金的6%，等回踩或放量承接"
    return "C", "AVOID", "RADAR_ONLY", "观察为主，除非次日重新放量转强"


def plan_prices(price: float, pct_chg: float, risk: str) -> tuple[str, float, float]:
    pullback = 0.012 if risk == "低" else 0.018 if risk == "中" else 0.026
    upper = price * (1 - pullback * 0.35)
    lower = price * (1 - pullback)
    stop_pct = 0.035 if risk == "低" else 0.045 if risk == "中" else 0.058
    target_pct = 0.065 if pct_chg < 5.8 else 0.052
    return f"{lower:.2f}-{upper:.2f}", round(price * (1 - stop_pct), 2), round(price * (1 + target_pct), 2)


def limit_up_threshold(code: str, name: str) -> float:
    if "ST" in name.upper():
        return 5.0
    if code.startswith(("83", "87", "88", "92")):
        return 30.0
    if code.startswith(("30", "68")):
        return 20.0
    return 10.0


def min_order_shares(code: str) -> int:
    if code.startswith("68"):
        return 200
    return 100


def execution_gate(code: str, name: str, pct: float, threshold: float) -> tuple[str, str]:
    buffer = threshold - pct
    risk_flags: list[str] = []
    upper = name.upper()
    if "ST" in upper:
        risk_flags.append("ST 风险警示，涨跌幅通常按 5% 处理")
    if "退" in name:
        risk_flags.append("退市/退市整理风险，必须极小仓且可随时放弃")
    if buffer <= 0.08:
        return "BLOCKED_LIMIT_UP", f"距离涨停阈值仅 {buffer:.2f} 个百分点，按难以买入处理"
    if buffer <= 0.6:
        risk_flags.append(f"距离涨停阈值 {buffer:.2f} 个百分点，只能按小仓排队/回落成交")
        return "BUYABLE_CAUTION", "；".join(risk_flags) or "接近涨停，成交不确定"
    return "BUYABLE", "；".join(risk_flags) or "未贴近涨停价，按限价单可执行候选处理"


def build_strategy_analysis(
    *,
    pct: float,
    volume_ratio: float,
    turnover: float,
    main_net: float,
    risk: str,
    execution_status: str,
    threshold: float,
    policy_theme: str = "",
    policy_score: int = 0,
) -> tuple[str, str, str, list[str], list[str], list[str]]:
    if execution_status == "BLOCKED_LIMIT_UP":
        return (
            "涨停后承接复盘",
            "POST_LIMIT_REVIEW",
            "涨停或贴近涨停说明情绪强，但当前不能按普通买单假设成交；核心观察开板承接和次日回踩",
            [
                "次日不追高开，优先等回落后仍能维持分时均价上方",
                "回踩不破前一交易日强势区间下沿，再考虑小仓试错",
                f"当前涨幅接近 {threshold:.0f}% 涨停阈值，默认不作为主动买入信号",
            ],
            [
                "高开低走并跌破昨日收盘价",
                "开板后放量回落，承接资金不足",
                "题材同板块前排转弱或市场情绪退潮",
            ],
            [
                "封板/近板后的实际成交不确定，模型价格不能当作可成交买点",
                "情绪接力失败时回撤速度快",
                "只适合复盘题材强度，不进入今日推荐买入",
            ],
        )

    if policy_score >= 13 and pct >= 5.0:
        entry_conditions = [
            f"主线方向为{policy_theme or '政策热门链'}，优先看板块前排和同主题宽度",
            "只做分歧承接，不做开盘直线追高",
        ]
        strategy_name = "主线分歧承接"
        strategy_stage = "THEME_PULLBACK_ENTRY"
        thesis = "先确认政策热门主线和板块情绪，再用回踩承接、前排强弱和止损纪律决定是否执行"
    else:
        entry_conditions = [
            "当日涨幅处于2%-6.5%的可跟踪强势区间",
            "量比温和放大，优先选择承接而非极端放量",
        ]
        strategy_name = "强势回踩/放量突破"
        strategy_stage = "ENTRY_SETUP"
        thesis = "先筛出温和转强且有流动性的标的，再用买区、止损和次日承接确认是否执行"
    if turnover > 0:
        entry_conditions.append("换手率处于可交易区间，避免流动性过弱或过度拥挤")
    if main_net > 0:
        entry_conditions.append("主力净流入为正，资金方向与价格同向")
    else:
        entry_conditions.append("主力净流入未确认，买入前需要盘中资金回流")

    invalidation = [
        "跌破买入区间下沿后不能快速收回",
        "跌破止损线或放量跌破前一日低点",
        "量比继续放大但价格不创新高，视为分歧加重",
    ]
    risk_points = [
        "短线信号只覆盖1-3个交易日，不能替代中线基本面判断",
        "若指数转弱或板块前排跳水，信号自动降级为观察",
    ]
    if risk != "低":
        risk_points.append("风险等级不是低，必须降低仓位并等待回踩确认")
    if volume_ratio > 2.8:
        risk_points.append("量能偏热，追价容易买在分歧点")

    return (strategy_name, strategy_stage, thesis, entry_conditions, invalidation, risk_points)


def build_opening_confirmation(
    *,
    name: str,
    buy_zone: str,
    stop_loss: float,
    pct: float,
    volume_ratio: float,
    turnover: float,
    risk: str,
    execution_status: str,
    policy_score: int,
    primary_theme: str,
    theme_rank: float,
    theme_heat_score: float,
    theme_leader_role: str,
    open_pct: float,
    high_fade_pct: float,
) -> tuple[str, list[str], list[str]]:
    if execution_status == "BLOCKED_LIMIT_UP":
        return (
            "POST_LIMIT_CONFIRM",
            [
                "竞价不追高；只看是否高开后仍有封单或快速回封能力",
                "开板回落后必须有承接，不能放量跌破昨日强势区间下沿",
                f"若回踩接近买区 {buy_zone} 且板块前排未跳水，才允许小仓试错",
            ],
            [
                "高开低走并跌破昨日收盘价",
                "开板后放量回落且不能回到分时均线上方",
                "同主题前排龙头炸板后不能回封",
            ],
        )

    checklist: list[str] = []
    no_buy: list[str] = []
    if policy_score >= 13 or theme_heat_score >= 100:
        checklist.append(f"竞价先看{primary_theme or '主线板块'}前排，不允许前排集体低开走弱")
    else:
        checklist.append("竞价先看大盘和所属板块是否同步转强")

    if theme_rank and theme_rank <= 2:
        checklist.append(f"板块仍需保持前{int(theme_rank)}主线地位，不能只剩个股独涨")
    if theme_leader_role:
        checklist.append(f"板块地位为{theme_leader_role}，优先验证是否继续强于同主题后排")
    else:
        checklist.append("非明确前排票，必须等前排确认后再买")

    checklist.append(f"开盘30分钟只在 {buy_zone} 回踩承接买，不能追直线拉升")
    checklist.append(f"买入后跌破 {stop_loss:.2f} 或放量跌破买区下沿，执行止损")

    if risk == "高":
        checklist.append("高风险信号只允许试错仓，首次仓位不超过计划资金3%-5%")
    elif risk == "中":
        checklist.append("中风险信号分批买，首次仓位不超过计划资金5%-8%")
    else:
        checklist.append("低风险信号也必须等回踩确认，不能开盘满仓")

    if pct >= 7:
        no_buy.append("高开超过3%且5分钟内不能封板或创新高，不追")
    else:
        no_buy.append("高开冲高但量价背离，不追")
    if volume_ratio >= 4 or turnover >= 12:
        no_buy.append("继续极端放量但价格不再创新高，视为分歧加重")
    if high_fade_pct >= 3:
        no_buy.append(f"昨日冲高回落约{high_fade_pct:.1f}%，早盘不能快速修复则放弃")
    if open_pct >= 4 and pct < open_pct:
        no_buy.append(f"昨日高开回落，开盘涨幅约{open_pct:.1f}%，次日不能弱转强则放弃")
    no_buy.append("所属主线前排炸板或集体跳水，放弃")
    no_buy.append("跌破买区下沿后3-5分钟不能快速收回，放弃")

    status = "THEME_OPEN_CONFIRM" if policy_score >= 13 or theme_heat_score >= 100 else "STANDARD_OPEN_CONFIRM"
    return status, checklist, no_buy


def build_signal(row: dict[str, Any], trade_date: date) -> Signal | None:
    code = str(row.get("code", "")).zfill(6)
    name = str(row.get("name", ""))
    price = to_float(row.get("price") or row.get("current_price"))
    pct = to_float(row.get("pct") or row.get("pct_chg"))
    volume_ratio = to_float(row.get("volumeRatio") or row.get("volume_ratio") or row.get("vr"), default=1.0)
    turnover = to_float(row.get("turnover"), default=0.0)
    market_cap = to_float(row.get("marketCap") or row.get("floatCap") or row.get("market_cap"), default=0.0)
    main_net = to_float(row.get("mainNet") or row.get("main_net"), default=0.0)
    main_net_pct = to_float(row.get("mainNetPct") or row.get("main_net_pct"), default=0.0)
    money_flow_source = str(row.get("moneyFlowSource") or "").strip()
    user_watchlist_priority = bool(row.get("userWatchlistPriority"))
    user_theme = str(row.get("userWatchlistTheme") or "").strip()
    industry = str(row.get("industry") or "").strip()
    if user_theme in {"", "其他"} and industry:
        user_theme = industry
    user_theme_breadth = to_float(row.get("userWatchlistThemeBreadth"), default=0.0)
    user_emotion_score = to_float(row.get("userWatchlistEmotionScore"), default=0.0)
    user_limit_state = str(row.get("userWatchlistLimitState") or "")
    primary_theme = str(row.get("primaryTheme") or "").strip()
    theme_heat_score = to_float(row.get("themeHeatScore"), default=0.0)
    theme_rank = to_float(row.get("themeRank"), default=0.0)
    theme_leader_role = str(row.get("themeLeaderRole") or "").strip()
    theme_leader_rank = to_float(row.get("themeLeaderRank"), default=0.0)
    theme_limit_count = to_float(row.get("themeLimitCount"), default=0.0)
    theme_strong_count = to_float(row.get("themeStrongCount"), default=0.0)
    theme_flagged_count = to_float(row.get("themeFlaggedCount"), default=0.0)
    open_price = to_float(row.get("open") or row.get("openPrice"), default=0.0)
    high_price = to_float(row.get("high"), default=0.0)
    prev_close = to_float(row.get("prevClose") or row.get("preClose"), default=0.0)
    open_pct = (open_price / prev_close - 1) * 100 if open_price > 0 and prev_close > 0 else 0.0
    high_fade_pct = (high_price / price - 1) * 100 if high_price > price > 0 else 0.0
    policy_score, policy_theme, policy_reason = policy_theme_score(name, user_theme or primary_theme, industry)

    if not code or not name:
        return None
    threshold = limit_up_threshold(code, name)
    execution_status, execution_note = execution_gate(code, name, pct, threshold)
    is_limit_review = execution_status == "BLOCKED_LIMIT_UP"
    if not (-2 <= pct <= threshold + 0.5):
        return None

    reasons: list[str] = ["短线候选：按1-3个交易日节奏跟踪"]
    if is_limit_review:
        reasons.append("涨停/近涨停强制进入题材复盘，不追板")
    elif 2.2 <= pct <= 6.8:
        reasons.append("当日涨幅处于短线强势区间")
    elif pct > 6.8:
        reasons.append("当日涨幅偏高，追高风险上升")
    else:
        reasons.append("涨幅未充分转强，优先观察承接")
    score, momentum, volume_score, liquidity, fund, penalty = score_components(
        price,
        pct,
        volume_ratio,
        turnover,
        market_cap,
        main_net,
    )

    reasons.append(f"涨幅强度得分 {momentum:.1f}")
    reasons.append(f"量能结构得分 {volume_score:.1f}")
    if turnover > 0:
        reasons.append(f"流动性得分 {liquidity:.1f}")
    if 1.35 <= volume_ratio <= 2.6:
        reasons.append("量能温和放大，未明显过热")
    elif volume_ratio >= 1.5:
        reasons.append("成交量大于均量1.5倍")
    elif volume_ratio >= 1:
        reasons.append("量能不弱")

    factor_score = to_float(row.get("factorCompositeScore"), default=0.0)
    if factor_score >= 80:
        score += 4
        reasons.append(f"量价因子截面得分 {factor_score:.1f}，历史方向验证后处于前20%")
    elif factor_score >= 65:
        score += 2
        reasons.append(f"量价因子截面得分 {factor_score:.1f}，对短线候选小幅加分")
    elif 0 < factor_score <= 20:
        score -= 6
        reasons.append(f"量价因子截面得分 {factor_score:.1f}，低分票降权")
    elif 0 < factor_score <= 35:
        score -= 3
        reasons.append(f"量价因子截面得分 {factor_score:.1f}，量价结构偏弱")

    if main_net > 0:
        reasons.append("主力净流入为正")
        if main_net_pct >= 8:
            score += 4
            reasons.append(f"主力净流入占比 {main_net_pct:.1f}%，资金确认较强")
    elif main_net < 0:
        reasons.append("主力净流出，强势票只能降仓或等回流确认")
        score -= 8
        if main_net_pct <= -5:
            score -= 6
            reasons.append(f"主力净流出占比 {abs(main_net_pct):.1f}%，资金背离")
    elif money_flow_source == "unavailable":
        reasons.append("主力资金未补全，不能把无资金数据当作流入确认")
    if penalty > 0:
        reasons.append(f"拥挤/流动性风险扣分 {penalty:.1f}")
    if policy_score:
        score += policy_score
        reasons.append(policy_reason)
        reasons.append(f"政策/热门主线加分 {policy_score}")
        if policy_score >= 13 and pct >= 7.0 and turnover >= 5.0 and volume_ratio >= 1.3 and not is_limit_review:
            score = max(score, 86.0)
            reasons.append("政策主线强攻放量，按主线分歧承接模型给最低可交易分")
    if theme_heat_score > 0:
        if theme_heat_score >= 150:
            score += 14
        elif theme_heat_score >= 100:
            score += 10
        elif theme_heat_score >= 60:
            score += 6
        else:
            score += 3
        reasons.append(
            f"板块热度确认：{primary_theme or policy_theme or user_theme} 热度{theme_heat_score:.0f}，"
            f"涨停/近涨停{int(theme_limit_count)}只，强势{int(theme_strong_count)}只"
        )
    if theme_rank:
        if theme_rank == 1:
            score += 8
            reasons.append("今日第一主线，优先级上调")
        elif theme_rank == 2:
            score += 5
            reasons.append("今日第二主线，保留进攻优先级")
        elif theme_rank <= 3:
            score += 3
            reasons.append("今日前三主线，纳入主线跟踪")
    if theme_leader_rank:
        if theme_leader_rank == 1:
            score += 8
        elif theme_leader_rank == 2:
            score += 6
        elif theme_leader_rank == 3:
            score += 4
        reasons.append(f"板块地位：{theme_leader_role}")
    elif theme_flagged_count >= 10 and policy_score >= 13:
        score += 3
        reasons.append("强主题内跟随票，只能做分歧承接，不按龙头追价")
    if open_pct:
        if open_pct >= 2 and pct >= open_pct:
            score += 4
            reasons.append(f"开盘强且收盘维持强势，开盘涨幅约 {open_pct:.1f}%")
        elif open_pct >= 4 and pct < open_pct:
            score -= 4
            reasons.append(f"高开后回落，开盘涨幅约 {open_pct:.1f}%")
    if high_fade_pct >= 3:
        score -= 6
        reasons.append(f"冲高回落 {high_fade_pct:.1f}%，次日只看承接修复")
    human_adjustment, human_cap, human_reasons, force_middle_risk = human_context_adjustments(
        pct=pct,
        volume_ratio=volume_ratio,
        turnover=turnover,
        market_cap=market_cap,
        main_net=main_net,
        main_net_pct=main_net_pct,
        money_flow_source=money_flow_source,
        open_pct=open_pct,
        high_fade_pct=high_fade_pct,
        policy_score=policy_score,
        theme_rank=theme_rank,
        theme_heat_score=theme_heat_score,
        theme_leader_rank=theme_leader_rank,
        is_limit_review=is_limit_review,
    )
    if human_adjustment:
        score += human_adjustment
    if human_reasons:
        reasons.extend(human_reasons)
    if human_cap is not None and score > human_cap:
        score = human_cap
        reasons.append(f"A股短线人工闸门评分上限 {human_cap:.0f}")
    if user_watchlist_priority:
        score += 12
        if user_theme_breadth >= 10:
            score += 10
        elif user_theme_breadth >= 6:
            score += 7
        elif user_theme_breadth >= 3:
            score += 4
        if user_emotion_score >= 70:
            score += 8
        elif user_emotion_score >= 55:
            score += 5
        if user_limit_state == "STRONG" and not is_limit_review:
            score = max(score, 80.0)
        if user_limit_state == "NEAR_LIMIT" and execution_status != "BLOCKED_LIMIT_UP":
            score = max(score, 76.0)
        reasons.append("用户票池强势信号优先：涨停/近涨停/题材放量必须进入主池复核")
        if user_theme and user_theme != "其他":
            reasons.append(f"用户票池主线：{user_theme}")
        if user_theme_breadth:
            reasons.append(f"用户票池同主题强势宽度 {int(user_theme_breadth)}")
        if user_emotion_score:
            reasons.append(f"用户票池情绪分 {user_emotion_score:.0f}")
        if user_limit_state:
            reasons.append(f"用户票池状态 {user_limit_state}")
    if human_cap is not None and score > human_cap:
        score = human_cap
        reasons.append(f"A股短线人工闸门最终评分上限 {human_cap:.0f}")
    if "ST" in name.upper():
        score -= 10
        reasons.append("ST风险警示，仓位和买入价必须降级")
    if "退" in name:
        score -= 25
        reasons.append("退市风险标签，只能作为高风险可执行性观察")
    if price < 3:
        score -= 8
        reasons.append("低价股波动和流动性风险较高")
    score = clamp(score)

    if is_limit_review:
        score = min(score, 76.0 if user_watchlist_priority else 69.0)
        reasons.append(f"涨停阈值 {threshold:.0f}%，当前涨幅 {pct:.2f}%")
    else:
        reasons.append(execution_note)
    if user_watchlist_priority and money_flow_source == "unavailable" and not is_limit_review:
        cap = 94.0 if policy_score >= 13 and user_limit_state == "STRONG" else 88.0 if user_limit_state == "STRONG" else 84.0
        if score > cap:
            score = cap
            reasons.append(f"主力资金未确认，评分上限压到 {cap:.0f}")

    risk = risk_level(price, pct, volume_ratio, turnover, penalty, score, is_limit_review)
    if user_watchlist_priority and money_flow_source == "unavailable" and pct >= 5 and risk == "低":
        risk = "中"
        reasons.append("用户票池强势但资金未确认，风险上调为中")
    if user_watchlist_priority and main_net < 0 and pct >= 5 and risk == "低":
        risk = "中"
        reasons.append("用户票池强势但资金净流出，风险上调为中")
    if theme_heat_score >= 100 and theme_leader_rank == 0 and pct >= 3 and risk == "低":
        risk = "中"
        reasons.append("强主题内非前排跟随票，风险上调为中；优先等前排确认后再做承接")
    if force_middle_risk and risk == "低":
        risk = "中"
        reasons.append("人工闸门发现过热/背离/后排风险，风险上调为中")
    if (
        user_watchlist_priority
        and not is_limit_review
        and user_theme_breadth >= 6
        and user_emotion_score >= 55
        and risk == "高"
        and pct < threshold - 1.0
        and price >= 5
        and main_net >= 0
    ):
        risk = "中"
        reasons.append("强主题内未贴近涨停，风险从过热降为中；只允许回踩承接，不允许追价")
    tier, action, recommendation_type, position_hint = classify(
        score,
        risk,
        pct,
        volume_ratio,
        execution_status,
        policy_score=policy_score,
    )
    buy_zone, stop_loss, target_price = plan_prices(price, pct, risk)
    strategy_name, strategy_stage, strategy_thesis, entry_conditions, invalidation_conditions, risk_points = build_strategy_analysis(
        pct=pct,
        volume_ratio=volume_ratio,
        turnover=turnover,
        main_net=main_net,
        risk=risk,
        execution_status=execution_status,
        threshold=threshold,
        policy_theme=policy_theme,
        policy_score=policy_score,
    )
    effective_theme = primary_theme or policy_theme or user_theme or industry
    confirmation_status, opening_checklist, no_buy_conditions = build_opening_confirmation(
        name=name,
        buy_zone=buy_zone,
        stop_loss=stop_loss,
        pct=pct,
        volume_ratio=volume_ratio,
        turnover=turnover,
        risk=risk,
        execution_status=execution_status,
        policy_score=policy_score,
        primary_theme=effective_theme,
        theme_rank=theme_rank,
        theme_heat_score=theme_heat_score,
        theme_leader_role=theme_leader_role,
        open_pct=open_pct,
        high_fade_pct=high_fade_pct,
    )
    signal = Signal(
        trade_date=trade_date.isoformat(),
        code=code,
        name=name,
        current_price=round(price, 2),
        pct_chg=round(pct, 2),
        turnover=round(turnover, 2),
        volume_ratio=round(volume_ratio, 2),
        market_cap=round(market_cap, 2),
        score=round(score, 2),
        risk_level=risk,
        tier=tier,
        action=action,
        recommendation_type=recommendation_type,
        holding_period="1-3个交易日",
        momentum_score=round(momentum, 1),
        volume_score=round(volume_score, 1),
        liquidity_score=round(liquidity, 1),
        fund_score=round(fund, 1),
        penalty_score=round(penalty, 1),
        buy_zone=buy_zone,
        stop_loss=stop_loss,
        target_price=target_price,
        position_hint=position_hint,
        ai_comment="",
        execution_status=execution_status,
        execution_note=execution_note,
        min_order_shares=min_order_shares(code),
        strategy_name=strategy_name,
        strategy_stage=strategy_stage,
        strategy_thesis=strategy_thesis,
        entry_conditions=entry_conditions,
        invalidation_conditions=invalidation_conditions,
        risk_points=risk_points,
        primary_theme=effective_theme,
        theme_rank=int(theme_rank),
        theme_heat_score=round(theme_heat_score, 1),
        theme_leader_role=theme_leader_role,
        open_pct=round(open_pct, 2),
        high_fade_pct=round(high_fade_pct, 2),
        confirmation_status=confirmation_status,
        opening_checklist=opening_checklist,
        no_buy_conditions=no_buy_conditions,
        reasons=reasons,
    )
    signal.ai_comment = rule_comment(signal)
    return signal


def signal_sort_priority(signal: Signal) -> int:
    if signal.recommendation_type == "THEME_DISAGREEMENT_BUY":
        return 7
    if signal.score < 60:
        return 0
    if any("用户票池强势信号优先" in reason for reason in signal.reasons):
        if signal.recommendation_type == "LIMIT_REVIEW":
            return 6
        return 5
    if signal.action == "TRADE":
        return 4
    if signal.recommendation_type == "LIMIT_REVIEW":
        return 1
    if signal.action == "WATCH":
        return 3
    return 0


def risk_sort_priority(signal: Signal) -> int:
    return {"中": 3, "低": 2, "高": 1}.get(signal.risk_level, 0)


def apply_trade_budget(signals: list[Signal], max_trade: int = 5) -> None:
    trade_count = 0
    for item in signals:
        if item.action != "TRADE":
            continue
        trade_count += 1
        if trade_count <= max_trade:
            continue
        item.action = "WATCH"
        item.tier = "B"
        item.recommendation_type = "WATCH_CANDIDATE"
        item.position_hint = "已超过当日核心推荐数量，只放入观察池；等待回踩或前排确认后再重评"
        item.reasons.append("当日核心推荐名额已满，A股短线不扩大买入名单")
        item.ai_comment = rule_comment(item)


def write_csv(signals: list[Signal], csv_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = csv_path.with_name(f".{csv_path.name}.{os.getpid()}.tmp")
    columns = [
        "trade_date",
        "code",
        "name",
        "price",
        "pct_chg",
        "turnover",
        "volume_ratio",
        "market_cap",
        "score",
        "risk_level",
        "tier",
        "action",
        "recommendation_type",
        "holding_period",
        "execution_status",
        "execution_note",
        "min_order_shares",
        "strategy_name",
        "strategy_stage",
        "primary_theme",
        "theme_rank",
        "theme_leader_role",
        "confirmation_status",
        "buy_zone",
        "stop_loss",
        "target_price",
    ]
    with tmp_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        for item in signals:
            writer.writerow(
                {
                    "trade_date": item.trade_date,
                    "code": item.code,
                    "name": item.name,
                    "price": item.current_price,
                    "pct_chg": item.pct_chg,
                    "turnover": item.turnover,
                    "volume_ratio": item.volume_ratio,
                    "market_cap": item.market_cap,
                    "score": item.score,
                    "risk_level": item.risk_level,
                    "tier": item.tier,
                    "action": item.action,
                    "recommendation_type": item.recommendation_type,
                    "holding_period": item.holding_period,
                    "execution_status": item.execution_status,
                    "execution_note": item.execution_note,
                    "min_order_shares": item.min_order_shares,
                    "strategy_name": item.strategy_name,
                    "strategy_stage": item.strategy_stage,
                    "primary_theme": item.primary_theme,
                    "theme_rank": item.theme_rank,
                    "theme_leader_role": item.theme_leader_role,
                    "confirmation_status": item.confirmation_status,
                    "buy_zone": item.buy_zone,
                    "stop_loss": item.stop_loss,
                    "target_price": item.target_price,
                }
            )
    os.replace(tmp_path, csv_path)


def write_recommendation(signals: list[Signal], path: Path, data_quality: dict[str, Any] | None = None) -> None:
    trade = [asdict(item) for item in signals if item.action == "TRADE"]
    watch = [asdict(item) for item in signals if item.action == "WATCH"]
    avoid = [asdict(item) for item in signals if item.action == "AVOID"]
    recommended_source = [
        item for item in signals if item.action == "TRADE" and item.risk_level != "高" and item.recommendation_type == "BUY_CANDIDATE"
    ]
    if len(recommended_source) < 5:
        recommended_source.extend(
            item
            for item in signals
            if item.action == "TRADE"
            and item not in recommended_source
            and item.recommendation_type in {"BUY_CANDIDATE", "SPECULATIVE_BUY_CANDIDATE", "THEME_DISAGREEMENT_BUY"}
        )
    recommended = [asdict(item) for item in recommended_source[:5]]
    status = "BUY" if recommended else "WATCH_ONLY" if watch else "NO_SIGNAL"
    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "style": "SHORT_TERM",
        "holdingPeriod": "1-3个交易日",
        "status": status,
        "liveBuyAllowed": bool(trade),
        "dataQuality": data_quality or {},
        "recommendedBuys": recommended,
        "watchPlan": watch[:10],
        "qualityRadar": [asdict(item) for item in signals[:10]],
        "upliftTop": [asdict(item) for item in sorted(signals, key=lambda item: item.volume_score, reverse=True)[:10]],
        "reasons": [
            "短线评分采用政策主线、主题宽度、动量、量能结构、流动性、市值、资金和拥挤风险，并附带策略入场/失效条件",
            "强政策主线票允许进入主线分歧承接候选，但必须低仓位等待回踩，不按开盘追高处理",
            "recommendedBuys 只包含执行闸门为 BUYABLE/BUYABLE_CAUTION 且满足买区纪律的 TRADE 候选",
            "ST、低价、退市整理、近板可以进入分析，但贴近涨停导致难成交时只能进入 LIMIT_REVIEW",
        ],
        "stats": {
            "total": len(signals),
            "trade": len(trade),
            "watch": len(watch),
            "avoid": len(avoid),
            "recommended": len(recommended),
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))


def signal_to_workbench_row(item: Signal) -> dict[str, Any]:
    return {
        **asdict(item),
        "pct": item.pct_chg,
        "price": item.current_price,
        "score": item.score,
        "reason": "；".join(item.reasons[:3]),
        "entry": {"buyZone": item.buy_zone},
        "exit": {"target": item.target_price, "stop": item.stop_loss},
        "sizing": {"hint": item.position_hint},
        "execution": {
            "status": item.execution_status,
            "note": item.execution_note,
            "minOrderShares": item.min_order_shares,
            "tPlusOne": "A股普通股票买入后当日不能卖出，次一交易日起才能卖出",
        },
        "holdingPeriod": item.holding_period,
        "recommendationType": item.recommendation_type,
        "strategy": {
            "name": item.strategy_name,
            "stage": item.strategy_stage,
            "thesis": item.strategy_thesis,
            "entryConditions": item.entry_conditions,
            "invalidationConditions": item.invalidation_conditions,
            "riskPoints": item.risk_points,
        },
        "theme": {
            "primary": item.primary_theme,
            "rank": item.theme_rank,
            "heatScore": item.theme_heat_score,
            "leaderRole": item.theme_leader_role,
        },
        "openingConfirmation": {
            "status": item.confirmation_status,
            "previousOpenPct": item.open_pct,
            "previousHighFadePct": item.high_fade_pct,
            "checklist": item.opening_checklist,
            "noBuyConditions": item.no_buy_conditions,
        },
        "blockedReasons": [] if item.action == "TRADE" else item.reasons[:3],
    }


def write_workbench_reports(
    signals: list[Signal],
    root: Path,
    generated_at: str,
    data_quality: dict[str, Any] | None = None,
) -> None:
    reports_dir = root / "reports" / "data"
    reports_dir.mkdir(parents=True, exist_ok=True)
    rows = [signal_to_workbench_row(item) for item in signals]
    trade = [row for row in rows if row.get("action") == "TRADE"]
    watch = [row for row in rows if row.get("action") == "WATCH"]
    avoid = [row for row in rows if row.get("action") == "AVOID"]
    theme_context = load_theme_context()
    attack_themes = [
        {
            "theme": theme,
            "rank": int(info.get("themeRank") or 0),
            "heatScore": round(to_float(info.get("themeHeatScore")), 1),
            "limitCount": int(to_float(info.get("themeLimitCount"))),
            "nearLimitCount": int(to_float(info.get("themeNearLimitCount"))),
            "strongCount": int(to_float(info.get("themeStrongCount"))),
            "flaggedCount": int(to_float(info.get("themeFlaggedCount"))),
            "leaders": info.get("themeLeaders") or [],
        }
        for theme, info in sorted(
            (theme_context.get("by_theme") or {}).items(),
            key=lambda item: to_float(item[1].get("themeHeatScore")),
            reverse=True,
        )[:6]
    ]
    strong_rows = [
        {
            "code": item.code,
            "name": item.name,
            "pct": item.pct_chg,
            "price": item.current_price,
            "turnover": item.turnover,
            "amount": 0,
            "mainNet": 0,
            "industry": "",
        }
        for item in signals
    ]

    scan_payload = {
        "requestTime": generated_at,
        "dataQuality": data_quality or {},
        "marketState": {
            "status": "ACTIVE" if trade else "WATCH",
            "score": min(8, max(1, len(trade) * 2 + len(watch))),
            "note": "选股同步已完成，仍需结合盘中承接与风控确认。",
        },
        "strongNotLimit": strong_rows,
        "watch": strong_rows,
        "selected": strong_rows,
    }
    atomic_write_text(
        reports_dir / "latest-free-a-share-scan.brief.json",
        json.dumps(scan_payload, ensure_ascii=False, indent=2),
    )

    trading_signals = {
        "requestTime": generated_at,
        "dataQuality": data_quality or {},
        "marketState": scan_payload["marketState"],
        "stats": {"total": len(rows), "tradeReady": len(trade), "watch": len(watch), "avoid": len(avoid)},
        "trade": trade,
        "watch": watch,
        "avoid": avoid,
        "risk": {
            "high": sum(1 for item in signals if item.risk_level == "高"),
            "middle": sum(1 for item in signals if item.risk_level == "中"),
            "low": sum(1 for item in signals if item.risk_level == "低"),
        },
    }
    atomic_write_text(
        reports_dir / "latest-trading-signals.json",
        json.dumps(trading_signals, ensure_ascii=False, indent=2),
    )

    open_watch = {
        "generatedAt": generated_at,
        "dataQuality": data_quality or {},
        "marketState": scan_payload["marketState"],
        "counts": {
            "newLimitUp": 0,
            "limitUp": 0,
            "strongToLimit": 0,
            "strongNotLimit": len(strong_rows),
        },
        "newLimitUps": [],
        "strongToLimit": [],
        "removedLimitUps": [],
        "newStrong": strong_rows[:20],
        "attackThemes": attack_themes,
        "attackCandidates": [
            {
                "grade": row.get("tier"),
                "code": row.get("code"),
                "name": row.get("name"),
                "theme": row.get("industry") or "-",
                "pct": row.get("pct"),
                "trigger": row.get("reason"),
                "stop": row.get("stop_loss"),
                "maxPosition": row.get("position_hint"),
                "confirmation": row.get("openingConfirmation"),
            }
            for row in rows[:10]
        ],
    }
    atomic_write_text(
        reports_dir / "latest-open-limit-watch.json",
        json.dumps(open_watch, ensure_ascii=False, indent=2),
    )

    atomic_write_text(
        reports_dir / "backtest-result.json",
        json.dumps(
            {
                "generatedAt": generated_at,
                "metrics": {
                    "buyCount": len(trade),
                    "closedTrades": 0,
                    "winRatePct": None,
                    "averageReturnPct": None,
                    "maxDrawdownPct": None,
                },
                "note": "当前同步只生成候选池；回测需要未来 K 线缓存后再更新。",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    atomic_write_text(
        reports_dir / "paper-trading-state.json",
        json.dumps(
            {
                "generatedAt": generated_at,
                "metrics": {"openExposurePct": 0, "totalReturnPct": 0},
                "positions": [],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def save_to_database(signals: list[Signal], db_path: Path) -> str:
    engine = create_database_engine(db_path)
    init_db(engine)
    rows = [
        {
            "trade_date": parse_trade_date(item.trade_date),
            "code": item.code,
            "name": item.name,
            "price": item.current_price,
            "pct_chg": item.pct_chg,
            "turnover": item.turnover,
            "volume_ratio": item.volume_ratio,
            "market_cap": item.market_cap,
            "score": item.score,
        }
        for item in signals
    ]
    if not rows:
        return engine.url.render_as_string(hide_password=True)
    insert_factory = pg_insert if engine.dialect.name == "postgresql" else sqlite_insert
    stmt = insert_factory(stock_pool).values(rows)
    update_columns = {
        "name": stmt.excluded.name,
        "price": stmt.excluded.price,
        "pct_chg": stmt.excluded.pct_chg,
        "turnover": stmt.excluded.turnover,
        "volume_ratio": stmt.excluded.volume_ratio,
        "market_cap": stmt.excluded.market_cap,
        "score": stmt.excluded.score,
    }
    stmt = stmt.on_conflict_do_update(
        index_elements=["trade_date", "code"],
        set_=update_columns,
    )
    with engine.begin() as conn:
        conn.execute(stmt)
    return engine.url.render_as_string(hide_password=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run A-share trend stock selection.")
    parser.add_argument("--input", default=str(default_input_path()))
    parser.add_argument("--output", default=str(repo_root() / "quant-system/backend/data/stock_pool_latest.json"))
    parser.add_argument("--csv-dir", default=str(repo_root() / "quant-system/data"))
    parser.add_argument("--db", default=str(repo_root() / "quant-system/data/quant.db"))
    parser.add_argument("--recommendation", default=str(repo_root() / "reports/data/latest-quant-recommendation.json"))
    parser.add_argument("--factor-scores", default=str(repo_root() / "reports/data/latest-factor-scores.json"))
    parser.add_argument("--trade-date", default=None)
    parser.add_argument("--live-provider", action="store_true", help="Fetch live market rows from configured provider.")
    parser.add_argument(
        "--allow-live-fallback",
        action="store_true",
        help="Allow local snapshot fallback when all live providers fail. Disabled by default to avoid stale realtime reports.",
    )
    parser.add_argument(
        "--no-live-fallback",
        action="store_true",
        help="Deprecated compatibility flag; live fallback is already disabled unless --allow-live-fallback is set.",
    )
    parser.add_argument("--scan-limit", type=int, default=None, help="Maximum live rows to fetch before scoring.")
    parser.add_argument(
        "--allow-stale-input",
        action="store_true",
        help="Allow non-live input whose row dates do not match --trade-date. Use only for offline demos/tests.",
    )
    parser.add_argument("--no-db", action="store_true")
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args()

    trade_date = parse_trade_date(args.trade_date)
    source_trade_date: date | None = None
    if args.live_provider:
        try:
            rows, input_label = live_rows(
                args.scan_limit,
                allow_fallback=args.allow_live_fallback and not args.no_live_fallback,
                trade_date=trade_date,
            )
            input_label = f"{input_label}; scan_limit={args.scan_limit or 'all'}"
            if input_label.startswith("fallback:"):
                source_trade_date = validate_input_rows(rows, input_label, trade_date, allow_stale=True)
            else:
                source_trade_date = trade_date
        except RuntimeError as exc:
            print(f"live providers unavailable: {exc}", file=sys.stderr)
            return 2
        rows, watchlist_added = merge_user_watchlist_rows(rows, trade_date)
        if watchlist_added:
            input_label = f"{input_label}; user_watchlist_priority={watchlist_added}"
        if not rows:
            print("live provider returned no rows; aborting without writing outputs", file=sys.stderr)
            return 2
    else:
        input_path = Path(args.input)
        if not input_path.exists():
            print(f"input file not found: {input_path}", file=sys.stderr)
            return 1
        rows = load_rows(input_path)
        input_label = str(input_path)
        try:
            source_trade_date = validate_input_rows(rows, input_label, trade_date, args.allow_stale_input)
        except RuntimeError as exc:
            print(f"input data rejected: {exc}", file=sys.stderr)
            return 2

    rows = enrich_rows_with_theme_context(rows, load_theme_context())
    factor_scores = load_latest_factor_scores(Path(args.factor_scores))
    rows = enrich_rows_with_factor_scores(rows, factor_scores)
    signals = [signal for row in rows if (signal := build_signal(row, trade_date))]
    if args.live_provider and not signals:
        print(f"live provider returned {len(rows)} rows but no rows passed filters; aborting without writing outputs", file=sys.stderr)
        return 2
    signals.sort(
        key=lambda item: (signal_sort_priority(item), risk_sort_priority(item), item.score, item.volume_ratio, item.pct_chg),
        reverse=True,
    )
    apply_trade_budget(signals, max_trade=5)
    selected = signals[: args.limit]

    data_quality = {
        "is_realtime": not input_label.startswith("fallback:") and args.live_provider,
        "allow_fallback": bool(args.live_provider and args.allow_live_fallback and not args.no_live_fallback),
        "allow_stale_input": bool(args.allow_stale_input),
        "source": input_label.split(";", 1)[0],
        "source_trade_date": source_trade_date.isoformat() if source_trade_date else None,
        "requested_trade_date": trade_date.isoformat(),
        "is_stale": bool(source_trade_date and source_trade_date != trade_date),
        "factor_scores_loaded": len(factor_scores),
    }
    generated_at = datetime.now().isoformat(timespec="seconds")
    payload = {
        "run_at": generated_at,
        "trade_date": trade_date.isoformat(),
        "input": input_label,
        "data_quality": data_quality,
        "count": len(selected),
        "signals": [asdict(item) for item in selected],
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(output_path, json.dumps(payload, ensure_ascii=False, indent=2))
    csv_path = Path(args.csv_dir) / f"stock_pool_{trade_date.isoformat()}.csv"
    write_csv(selected, csv_path)
    write_recommendation(selected, Path(args.recommendation), data_quality)
    write_workbench_reports(selected, repo_root(), generated_at, data_quality)
    if not args.no_db:
        db_label = save_to_database(selected, Path(args.db))

    print(f"selected {len(selected)} stocks")
    for item in selected[:10]:
        print(
            f"{item.code} {item.name} price={item.current_price} pct={item.pct_chg}% "
            f"turnover={item.turnover} vr={item.volume_ratio} score={item.score} risk={item.risk_level}"
        )
    print(f"output: {output_path}")
    print(f"csv: {csv_path}")
    print(f"input: {input_label}")
    if not args.no_db:
        print(f"database: {db_label}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
