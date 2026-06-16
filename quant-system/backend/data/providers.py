from __future__ import annotations

import json
from datetime import date
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from backend.config import settings
from backend.data.models import Announcement, FinancialSnapshot, KLine, MoneyFlow, StockQuote


class MarketDataProvider(Protocol):
    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        ...

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        ...


class ProviderUnavailable(RuntimeError):
    pass


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _to_float(value: object, default: float = 0) -> float:
    try:
        if value in (None, "", "-"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_date(value: object) -> date:
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return date.today()


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _read_json(url: str) -> Any:
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
            "Referer": "https://quote.eastmoney.com/",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ProviderUnavailable(str(exc)) from exc


def _read_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "quant-system/0.1"})
    try:
        with urlopen(request, timeout=15) as response:
            return response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError) as exc:
        raise ProviderUnavailable(str(exc)) from exc


def _symbol_code(symbol: str) -> str:
    base = symbol.split(".", 1)[0].split("-", 1)[0].upper()
    return base.zfill(6) if base.isdigit() else base


def _ts_code(code: str) -> str:
    normalized = str(code).split(".", 1)[0].zfill(6)
    suffix = "SH" if normalized.startswith(("5", "6", "9")) else "SZ"
    return f"{normalized}.{suffix}"


def _eastmoney_secid(code: str) -> str:
    normalized = str(code).zfill(6)
    market = "1" if normalized.startswith(("5", "6", "9")) else "0"
    return f"{market}.{normalized}"


class AkShareProvider:
    def __init__(self) -> None:
        try:
            import akshare as ak  # type: ignore
        except ImportError as exc:
            raise RuntimeError("AkShare is not installed") from exc
        self.ak = ak

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        frame = self.ak.stock_zh_a_spot_em()
        frame = frame.head(limit or settings.max_stocks)
        quotes: list[StockQuote] = []
        for _, row in frame.iterrows():
            code = str(row.get("代码", "")).zfill(6)
            name = str(row.get("名称", ""))
            if not code or not name:
                continue
            quotes.append(
                StockQuote(
                    code=code,
                    name=name,
                    price=_to_float(row.get("最新价")),
                    pct=_to_float(row.get("涨跌幅")),
                    volume=_to_float(row.get("成交量"), default=0),
                    amount=_to_float(row.get("成交额"), default=0),
                    turnover=_to_float(row.get("换手率"), default=0),
                    volume_ratio=_to_float(row.get("量比"), default=0),
                    market_cap=_to_float(row.get("总市值"), default=0),
                    industry=str(row.get("所属行业", "") or "") or None,
                )
            )
        return quotes

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        frame = self.ak.stock_zh_a_hist(
            symbol=code,
            period="daily",
            start_date="20200101",
            end_date=date.today().strftime("%Y%m%d"),
            adjust="qfq",
        )
        frame = frame.tail(days)
        return [
            KLine(
                trade_date=_to_date(row["日期"]),
                open=_to_float(row["开盘"]),
                close=_to_float(row["收盘"]),
                high=_to_float(row["最高"]),
                low=_to_float(row["最低"]),
                volume=_to_float(row["成交量"]),
                amount=_to_float(row.get("成交额"), default=0),
            )
            for _, row in frame.iterrows()
        ]


class TushareProvider:
    """Tushare Pro adapter for financial statement and indicator supplements."""

    def __init__(self) -> None:
        if not settings.tushare_token:
            raise ProviderUnavailable("TUSHARE_TOKEN is not configured")
        try:
            import tushare as ts  # type: ignore
        except ImportError as exc:
            raise ProviderUnavailable("tushare is not installed") from exc
        ts.set_token(settings.tushare_token)
        self.pro = ts.pro_api()

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        frame = self.pro.stock_basic(exchange="", list_status="L", fields="ts_code,symbol,name,industry")
        rows = frame.head(limit or settings.max_stocks)
        return [
            StockQuote(
                code=str(row.get("symbol", "")).zfill(6),
                name=str(row.get("name", "")),
                price=0,
                pct=0,
                industry=str(row.get("industry") or "") or None,
            )
            for _, row in rows.iterrows()
            if str(row.get("symbol", "")).strip() and str(row.get("name", "")).strip()
        ]

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        end_date = date.today().strftime("%Y%m%d")
        frame = self.pro.daily(ts_code=_ts_code(code), end_date=end_date)
        frame = frame.sort_values("trade_date").tail(days)
        return [
            KLine(
                trade_date=_to_date(row.get("trade_date")),
                open=_to_float(row.get("open")),
                close=_to_float(row.get("close")),
                high=_to_float(row.get("high")),
                low=_to_float(row.get("low")),
                volume=_to_float(row.get("vol")),
                amount=_to_float(row.get("amount"), default=0) * 1000,
            )
            for _, row in frame.iterrows()
        ]

    def get_financial_snapshot(self, code: str, report_date: str | None = None) -> FinancialSnapshot:
        fields = "ts_code,end_date,ann_date,roe_dt,netprofit_margin,grossprofit_margin,debt_to_assets,eps"
        frame = self.pro.fina_indicator(ts_code=_ts_code(code), end_date=report_date, fields=fields)
        if frame.empty:
            raise ProviderUnavailable(f"Tushare returned no financial rows for {code}")
        row = frame.sort_values("end_date").tail(1).iloc[0]
        income = self.pro.income(ts_code=_ts_code(code), end_date=row.get("end_date"), fields="ts_code,end_date,revenue,n_income")
        income_row = income.tail(1).iloc[0] if not income.empty else {}
        return FinancialSnapshot(
            code=str(code).zfill(6),
            report_date=_to_date(row.get("end_date")),
            revenue=_to_float(income_row.get("revenue"), default=0) or None,
            net_profit=_to_float(income_row.get("n_income"), default=0) or None,
            gross_margin=_to_float(row.get("grossprofit_margin"), default=0) or None,
            roe=_to_float(row.get("roe_dt"), default=0) or None,
            debt_to_assets=_to_float(row.get("debt_to_assets"), default=0) or None,
            eps=_to_float(row.get("eps"), default=0) or None,
        )


class CninfoAnnouncementProvider:
    """Cninfo announcement search adapter."""

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        return []

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        return []

    def get_announcements(self, code: str, page_size: int = 20) -> list[Announcement]:
        payload = urlencode(
            {
                "stock": str(code).zfill(6),
                "tabName": "fulltext",
                "pageSize": str(min(max(page_size, 1), 50)),
                "pageNum": "1",
                "column": "szse",
                "plate": "",
                "searchkey": "",
                "secid": "",
                "category": "",
                "trade": "",
                "seDate": "",
                "sortName": "",
                "sortType": "",
                "isHLtitle": "true",
            }
        ).encode("utf-8")
        request = Request(
            settings.cninfo_base_url,
            data=payload,
            headers={
                "User-Agent": "quant-system/0.1",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Referer": "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=15) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise ProviderUnavailable(str(exc)) from exc
        announcements: list[Announcement] = []
        for row in data.get("announcements") or []:
            adjunct = str(row.get("adjunctUrl") or "")
            url = f"https://static.cninfo.com.cn/{adjunct}" if adjunct else None
            announcements.append(
                Announcement(
                    code=str(code).zfill(6),
                    title=" ".join(str(row.get("announcementTitle") or "").split()),
                    announcement_date=_to_date(row.get("announcementTime")),
                    url=url,
                    category=str(row.get("categoryName") or "") or None,
                )
            )
        return announcements


class EastMoneyMoneyFlowProvider:
    """EastMoney capital-flow supplement for main-fund tracking."""

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        return EastMoneyDirectProvider().list_a_shares(limit)

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        return EastMoneyDirectProvider().get_daily_kline(code, days)

    def get_money_flow(self, code: str, days: int = 1) -> list[MoneyFlow]:
        url = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?" + urlencode(
            {
                "secid": _eastmoney_secid(code),
                "lmt": str(min(max(days, 1), 120)),
                "klt": "101",
                "fields1": "f1,f2,f3,f7",
                "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            }
        )
        payload = _read_json(url)
        rows = payload.get("data", {}).get("klines") or []
        flows: list[MoneyFlow] = []
        for row in rows[-days:]:
            parts = str(row).split(",")
            if len(parts) < 11:
                continue
            flows.append(
                MoneyFlow(
                    code=str(code).zfill(6),
                    trade_date=_to_date(parts[0]),
                    main_net=_to_float(parts[1], default=0),
                    small_net=_to_float(parts[2], default=0),
                    medium_net=_to_float(parts[3], default=0),
                    large_net=_to_float(parts[4], default=0),
                    super_large_net=_to_float(parts[5], default=0),
                    main_net_pct=_to_float(parts[10], default=0),
                )
            )
        return flows


class YahooFinanceProvider:
    """Yahoo Finance adapter for a configured symbol watchlist."""

    def __init__(self, symbols: list[str] | None = None) -> None:
        self.symbols = symbols or _split_csv(settings.yahoo_symbols)
        self.symbol_by_code = {_symbol_code(symbol): symbol for symbol in self.symbols}
        if not self.symbols:
            raise ProviderUnavailable("Yahoo Finance symbols are empty")

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        symbols = self.symbols[: limit or settings.max_stocks]
        url = "https://query1.finance.yahoo.com/v7/finance/quote?" + urlencode({"symbols": ",".join(symbols)})
        payload = _read_json(url)
        rows = payload.get("quoteResponse", {}).get("result", [])
        quotes: list[StockQuote] = []
        for row in rows:
            symbol = str(row.get("symbol", ""))
            price = _to_float(row.get("regularMarketPrice"))
            pct = _to_float(row.get("regularMarketChangePercent"))
            if not symbol or price <= 0:
                continue
            quotes.append(
                StockQuote(
                    code=_symbol_code(symbol),
                    name=str(row.get("shortName") or row.get("longName") or symbol),
                    price=price,
                    pct=pct,
                    volume=_to_float(row.get("regularMarketVolume"), default=0),
                    amount=_to_float(row.get("regularMarketVolume"), default=0) * price,
                    turnover=0,
                    industry=str(row.get("market") or "") or None,
                )
            )
        return quotes

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        normalized = _symbol_code(code)
        symbol = self.symbol_by_code.get(normalized, code)
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?range=1y&interval=1d"
        payload = _read_json(url)
        result = (payload.get("chart", {}).get("result") or [{}])[0]
        timestamps = result.get("timestamp") or []
        quote_rows = (result.get("indicators", {}).get("quote") or [{}])[0]
        opens = quote_rows.get("open") or []
        closes = quote_rows.get("close") or []
        highs = quote_rows.get("high") or []
        lows = quote_rows.get("low") or []
        volumes = quote_rows.get("volume") or []
        klines: list[KLine] = []
        for index, ts in enumerate(timestamps[-days:]):
            source_index = len(timestamps) - len(timestamps[-days:]) + index
            close = _to_float(closes[source_index] if source_index < len(closes) else None)
            if close <= 0:
                continue
            klines.append(
                KLine(
                    trade_date=datetime.fromtimestamp(int(ts)).date(),
                    open=_to_float(opens[source_index] if source_index < len(opens) else close, close),
                    close=close,
                    high=_to_float(highs[source_index] if source_index < len(highs) else close, close),
                    low=_to_float(lows[source_index] if source_index < len(lows) else close, close),
                    volume=_to_float(volumes[source_index] if source_index < len(volumes) else 0),
                )
            )
        return klines


class BinanceProvider:
    """Binance spot adapter for crypto symbols such as BTCUSDT."""

    def __init__(self, symbols: list[str] | None = None) -> None:
        self.symbols = [item.upper() for item in (symbols or _split_csv(settings.binance_symbols))]
        if not self.symbols:
            raise ProviderUnavailable("Binance symbols are empty")

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        symbols = self.symbols[: limit or settings.max_stocks]
        rows = _read_json("https://api.binance.com/api/v3/ticker/24hr")
        wanted = set(symbols)
        quotes: list[StockQuote] = []
        for row in rows:
            symbol = str(row.get("symbol", "")).upper()
            if symbol not in wanted:
                continue
            quotes.append(
                StockQuote(
                    code=symbol,
                    name=symbol,
                    price=_to_float(row.get("lastPrice")),
                    pct=_to_float(row.get("priceChangePercent")),
                    volume=_to_float(row.get("volume"), default=0),
                    amount=_to_float(row.get("quoteVolume"), default=0),
                    turnover=0,
                    industry="crypto",
                )
            )
        return quotes

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        symbol = code.upper()
        url = "https://api.binance.com/api/v3/klines?" + urlencode(
            {"symbol": symbol, "interval": "1d", "limit": min(max(days, 1), 1000)}
        )
        rows = _read_json(url)
        klines: list[KLine] = []
        for row in rows:
            klines.append(
                KLine(
                    trade_date=datetime.fromtimestamp(int(row[0]) / 1000).date(),
                    open=_to_float(row[1]),
                    close=_to_float(row[4]),
                    high=_to_float(row[2]),
                    low=_to_float(row[3]),
                    volume=_to_float(row[5]),
                    amount=_to_float(row[7], default=0),
                )
            )
        return klines


class EastMoneyDirectProvider:
    """Direct EastMoney quote adapter used when AkShare is slow or unavailable."""

    fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
    fields = "f12,f14,f2,f3,f5,f6,f8,f10,f20,f21,f62,f100"

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        max_rows = limit or settings.max_stocks
        page_size = min(max(max_rows, 1), 200)
        quotes: list[StockQuote] = []
        page = 1
        while len(quotes) < max_rows:
            url = "https://push2.eastmoney.com/api/qt/clist/get?" + urlencode(
                {
                    "pn": page,
                    "pz": page_size,
                    "po": 1,
                    "np": 1,
                    "fltt": 2,
                    "invt": 2,
                    "fid": "f3",
                    "fs": self.fs,
                    "fields": self.fields,
                }
            )
            payload = _read_json(url)
            data = payload.get("data") or {}
            rows = data.get("diff") or []
            if not rows:
                break
            for row in rows:
                code = str(row.get("f12", "")).zfill(6)
                name = str(row.get("f14", ""))
                price = _to_float(row.get("f2"))
                if not code or not name or price <= 0:
                    continue
                quotes.append(
                    StockQuote(
                        code=code,
                        name=name,
                        price=price,
                        pct=_to_float(row.get("f3")),
                        volume=_to_float(row.get("f5"), default=0),
                        amount=_to_float(row.get("f6"), default=0),
                        turnover=_to_float(row.get("f8"), default=0),
                        volume_ratio=_to_float(row.get("f10"), default=0),
                        market_cap=_to_float(row.get("f20"), default=0),
                        main_net=_to_float(row.get("f62"), default=0),
                        industry=str(row.get("f100") or "") or None,
                    )
                )
                if len(quotes) >= max_rows:
                    break
            total = int(data.get("total") or 0)
            if total and page * page_size >= total:
                break
            page += 1
        if not quotes:
            raise ProviderUnavailable("EastMoney returned no quote rows")
        return quotes

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        normalized = str(code).zfill(6)
        market = "1" if normalized.startswith(("5", "6", "9")) else "0"
        url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?" + urlencode(
            {
                "secid": f"{market}.{normalized}",
                "fields1": "f1,f2,f3,f4,f5,f6",
                "fields2": "f51,f52,f53,f54,f55,f56,f57",
                "klt": "101",
                "fqt": "1",
                "end": "20500101",
                "lmt": str(min(max(days, 1), 320)),
            }
        )
        payload = _read_json(url)
        rows = payload.get("data", {}).get("klines") or []
        klines: list[KLine] = []
        for row in rows[-days:]:
            parts = str(row).split(",")
            if len(parts) < 7:
                continue
            close = _to_float(parts[2])
            if close <= 0:
                continue
            klines.append(
                KLine(
                    trade_date=_to_date(parts[0]),
                    open=_to_float(parts[1]),
                    close=close,
                    high=_to_float(parts[3]),
                    low=_to_float(parts[4]),
                    volume=_to_float(parts[5]),
                    amount=_to_float(parts[6], default=0),
                )
            )
        return klines


class WorldBankProvider:
    """Maps configured macro indicators into quote-like rows for dashboards."""

    def __init__(self, indicators: list[str] | None = None) -> None:
        self.indicators = indicators or _split_csv(settings.world_bank_indicators)
        if not self.indicators:
            raise ProviderUnavailable("World Bank indicators are empty")

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        quotes: list[StockQuote] = []
        for item in self.indicators[: limit or settings.max_stocks]:
            country, _, indicator = item.partition(":")
            if not country or not indicator:
                continue
            url = (
                f"https://api.worldbank.org/v2/country/{quote(country)}/indicator/{quote(indicator)}?"
                + urlencode({"format": "json", "per_page": 5, "MRV": 2})
            )
            payload = _read_json(url)
            rows = payload[1] if isinstance(payload, list) and len(payload) > 1 else []
            values = [row for row in rows if row.get("value") is not None]
            if not values:
                continue
            latest = values[0]
            previous = values[1] if len(values) > 1 else {}
            price = _to_float(latest.get("value"))
            prev = _to_float(previous.get("value"))
            pct = ((price / prev) - 1) * 100 if prev else 0
            quotes.append(
                StockQuote(
                    code=f"{country.upper()}:{indicator}",
                    name=f"{latest.get('country', {}).get('value', country)} {indicator} {latest.get('date')}",
                    price=price,
                    pct=pct,
                    volume=None,
                    amount=None,
                    turnover=None,
                    industry="macro",
                )
            )
        return quotes

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        country, _, indicator = code.partition(":")
        if not country or not indicator:
            return []
        url = (
            f"https://api.worldbank.org/v2/country/{quote(country)}/indicator/{quote(indicator)}?"
            + urlencode({"format": "json", "per_page": min(max(days, 1), 100)})
        )
        payload = _read_json(url)
        rows = payload[1] if isinstance(payload, list) and len(payload) > 1 else []
        klines: list[KLine] = []
        for row in reversed(rows):
            value = _to_float(row.get("value"))
            if value <= 0:
                continue
            klines.append(
                KLine(
                    trade_date=date(int(row.get("date", date.today().year)), 12, 31),
                    open=value,
                    close=value,
                    high=value,
                    low=value,
                    volume=0,
                    amount=value,
                )
            )
        return klines[-days:]


class ArxivProvider:
    """Research feed adapter; rows are recency signals, not tradeable assets."""

    def __init__(self, queries: list[str] | None = None) -> None:
        self.queries = queries or _split_csv(settings.arxiv_queries)
        if not self.queries:
            raise ProviderUnavailable("arXiv queries are empty")

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        max_results = min(limit or settings.max_stocks, 50)
        quotes: list[StockQuote] = []
        for query in self.queries:
            url = "https://export.arxiv.org/api/query?" + urlencode(
                {"search_query": query, "sortBy": "submittedDate", "sortOrder": "descending", "max_results": max_results}
            )
            root = ElementTree.fromstring(_read_text(url))
            namespace = {"atom": "http://www.w3.org/2005/Atom"}
            for index, entry in enumerate(root.findall("atom:entry", namespace), start=1):
                title = " ".join((entry.findtext("atom:title", default="", namespaces=namespace)).split())
                published = entry.findtext("atom:published", default="", namespaces=namespace)[:10]
                quotes.append(
                    StockQuote(
                        code=f"ARXIV{index:04d}",
                        name=f"{published} {title[:80]}",
                        price=float(max_results - index + 1),
                        pct=0,
                        volume=0,
                        amount=0,
                        turnover=0,
                        industry="research",
                    )
                )
        return quotes[:max_results]

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        return []


class CredentialedPlaceholderProvider:
    def __init__(self, source: str, api_key: str | None) -> None:
        if not api_key:
            raise ProviderUnavailable(f"{source} requires an API key or licensed SDK account")
        raise ProviderUnavailable(f"{source} adapter is configured but no SDK client has been wired yet")


class ReportFallbackProvider:
    """Fallback adapter over the existing local report files."""

    def __init__(self, report_path: Path | None = None) -> None:
        configured = report_path or settings.fallback_report_path
        self.report_path = configured if configured.is_absolute() else _repo_root() / configured

    def _load_report(self) -> dict:
        if not self.report_path.exists():
            return {}
        return json.loads(self.report_path.read_text(encoding="utf-8"))

    def list_a_shares(self, limit: int | None = None) -> list[StockQuote]:
        report = self._load_report()
        rows = []
        for key in (
            "actionable",
            "tactical",
            "watch",
            "qualityPool",
            "strongNotLimit",
            "fundTop",
            "selected",
            "candidates",
            "qualityRanking",
            "stocks",
        ):
            value = report.get(key)
            if isinstance(value, list):
                rows = value
                break
        quotes: list[StockQuote] = []
        for row in rows[: limit or settings.max_stocks]:
            quotes.append(
                StockQuote(
                    code=str(row.get("code", "")).zfill(6),
                    name=str(row.get("name", "")),
                    price=_to_float(row.get("price") or row.get("current_price")),
                    pct=_to_float(row.get("pct")),
                    volume=_to_float(row.get("volume"), default=0),
                    amount=_to_float(row.get("amount"), default=0),
                    turnover=_to_float(row.get("turnover"), default=0),
                    volume_ratio=_to_float(row.get("volumeRatio") or row.get("volume_ratio") or row.get("vr"), default=0),
                    market_cap=_to_float(row.get("marketCap") or row.get("market_cap"), default=0),
                    main_net=_to_float(row.get("mainNet") or row.get("main_net"), default=0),
                    industry=row.get("industry"),
                )
            )
        return [quote for quote in quotes if quote.code and quote.name]

    def get_daily_kline(self, code: str, days: int = 80) -> list[KLine]:
        cache_path = _repo_root() / "reports" / "data" / "kline-cache" / f"{code}.daily.json"
        if not cache_path.exists():
            return []
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        rows = payload.get("klines", payload if isinstance(payload, list) else [])
        klines: list[KLine] = []
        for row in rows[-days:]:
            if isinstance(row, str):
                parts = row.split(",")
                if len(parts) < 6:
                    continue
                klines.append(
                    KLine(
                        trade_date=_to_date(parts[0]),
                        open=_to_float(parts[1]),
                        close=_to_float(parts[2]),
                        high=_to_float(parts[3]),
                        low=_to_float(parts[4]),
                        volume=_to_float(parts[5]),
                    )
                )
            elif isinstance(row, dict):
                klines.append(
                    KLine(
                        trade_date=_to_date(row.get("date") or row.get("trade_date")),
                        open=_to_float(row.get("open")),
                        close=_to_float(row.get("close")),
                        high=_to_float(row.get("high")),
                        low=_to_float(row.get("low")),
                        volume=_to_float(row.get("volume")),
                        amount=_to_float(row.get("amount"), default=0),
                    )
                )
        return klines


PROVIDER_FACTORIES = {
    "akshare": AkShareProvider,
    "tushare": TushareProvider,
    "cninfo": CninfoAnnouncementProvider,
    "juchao": CninfoAnnouncementProvider,
    "eastmoney": EastMoneyDirectProvider,
    "eastmoney_direct": EastMoneyDirectProvider,
    "eastmoney_moneyflow": EastMoneyMoneyFlowProvider,
    "moneyflow": EastMoneyMoneyFlowProvider,
    "fallback": ReportFallbackProvider,
    "report": ReportFallbackProvider,
    "yahoo": YahooFinanceProvider,
    "yahoo_finance": YahooFinanceProvider,
    "binance": BinanceProvider,
    "world_bank": WorldBankProvider,
    "worldbank": WorldBankProvider,
    "arxiv": ArxivProvider,
    "ifind": lambda: CredentialedPlaceholderProvider("iFinD", settings.ifind_api_key),
    "ths": lambda: CredentialedPlaceholderProvider("同花顺", settings.ths_api_key),
    "tonghuashun": lambda: CredentialedPlaceholderProvider("同花顺", settings.ths_api_key),
    "tianyancha": lambda: CredentialedPlaceholderProvider("天眼查", settings.tianyancha_api_key),
    "google_scholar": lambda: CredentialedPlaceholderProvider(
        "Google Scholar",
        settings.google_scholar_queries,
    ),
    "scholar": lambda: CredentialedPlaceholderProvider("Google Scholar", settings.google_scholar_queries),
}


def configured_data_sources() -> list[str]:
    return _split_csv(settings.data_source_stack)


def data_source_status() -> list[dict[str, Any]]:
    configured = set(configured_data_sources())
    sources = [
        {
            "name": "akshare",
            "role": "主数据：A股行情、日线、股票池基础数据",
            "configured": "akshare" in configured,
            "ready": True,
            "detail": "QUANT_DATA_PROVIDER=akshare 时优先使用",
        },
        {
            "name": "tushare",
            "role": "财务补充：利润表、财务指标、估值扩展",
            "configured": "tushare" in configured,
            "ready": bool(settings.tushare_token),
            "detail": "需要 TUSHARE_TOKEN；Python 包 tushare 为可选依赖",
        },
        {
            "name": "cninfo",
            "role": "公告：巨潮资讯公告检索和 PDF 链接",
            "configured": "cninfo" in configured or "juchao" in configured,
            "ready": bool(settings.cninfo_base_url),
            "detail": settings.cninfo_base_url,
        },
        {
            "name": "eastmoney_moneyflow",
            "role": "资金流：主力净流入、大单/超大单分层",
            "configured": "eastmoney_moneyflow" in configured or "moneyflow" in configured,
            "ready": True,
            "detail": "使用东方财富 push2his 资金流接口",
        },
        {
            "name": "postgres",
            "role": "结构化存储：行情、财务、公告、资金流、信号",
            "configured": "postgres" in configured,
            "ready": bool(settings.database_url),
            "detail": "需要 DATABASE_URL 或 QUANT_DATABASE_URL",
        },
        {
            "name": "vector",
            "role": "向量数据库：公告、研报、投资委员会证据检索",
            "configured": "vector" in configured,
            "ready": bool(settings.vector_database_url) or settings.vector_database_provider == "pgvector",
            "detail": f"provider={settings.vector_database_provider}",
        },
    ]
    return sources


def get_provider() -> MarketDataProvider:
    provider_name = settings.data_provider.lower()
    factory = PROVIDER_FACTORIES.get(provider_name)
    if factory is None:
        return ReportFallbackProvider()
    try:
        return factory()
    except Exception:
        return ReportFallbackProvider()
