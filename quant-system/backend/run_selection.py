from __future__ import annotations

import argparse
import csv
import json
import os
import signal
import sys
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.data.providers import AkShareProvider, EastMoneyDirectProvider, ProviderUnavailable
from backend.db import create_database_engine, init_db, stock_pool


LIVE_PROVIDER_TIMEOUT_SECONDS = 25


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
        }
        for quote in quotes
    ]


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


def live_rows(limit: int | None = None, allow_fallback: bool = True) -> tuple[list[dict[str, Any]], str]:
    attempts = [
        ("eastmoney:push2-clist", EastMoneyDirectProvider),
    ]
    if os.getenv("QUANT_TRY_AKSHARE_LIVE", "false").lower() in {"1", "true", "yes"}:
        attempts.append(("akshare:stock_zh_a_spot_em", AkShareProvider))
    failures: list[str] = []
    for label, factory in attempts:
        try:
            with timeout(LIVE_PROVIDER_TIMEOUT_SECONDS, label):
                rows = quote_rows_from_provider(factory(), limit=limit)
        except (RuntimeError, ProviderUnavailable, OSError, TimeoutError) as exc:
            failures.append(f"{label} failed: {exc}")
            continue
        if rows:
            if failures:
                print("; ".join(failures), file=sys.stderr)
            return rows, label
        failures.append(f"{label} returned no rows")

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


def risk_level(price: float, pct: float, volume_ratio: float, turnover: float, penalty: float, score: float) -> str:
    if price < 5 or pct > 6.7 or volume_ratio > 4.2 or turnover > 18 or penalty >= 22 or score < 68:
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
        f"{signal.name}综合评分{signal.score:.1f}，{signal.action}；"
        f"买入区间{signal.buy_zone}，止损{signal.stop_loss:.2f}，目标{signal.target_price:.2f}。"
        f"{'，'.join(signal.reasons[:3])}。{tail}"
    )


def score_components(
    price: float,
    pct_chg: float,
    volume_ratio: float,
    turnover: float,
    market_cap: float,
    main_net: float,
) -> tuple[float, float, float, float, float, float]:
    momentum = band_score(pct_chg, ideal_low=3.8, ideal_high=6.2, hard_low=2.0, hard_high=8.5)
    volume = band_score(volume_ratio, ideal_low=1.35, ideal_high=2.6, hard_low=0.8, hard_high=4.8)
    turnover_score = band_score(turnover, ideal_low=3.0, ideal_high=10.0, hard_low=0.5, hard_high=20.0)

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
    if volume_ratio > 3.2:
        penalty += min(18, (volume_ratio - 3.2) * 10)
    if turnover > 14:
        penalty += min(16, (turnover - 14) * 2.5)
    if market_cap and market_cap < 3000000000:
        penalty += 10

    total = momentum * 0.28 + volume * 0.24 + liquidity * 0.22 + fund * 0.16 + 10 - penalty
    return clamp(total), momentum, volume, liquidity, fund, penalty


def classify(score: float, risk: str) -> tuple[str, str, str]:
    if score >= 82 and risk != "高":
        return "A", "TRADE", "单票不超过计划资金的12%，只在买入区间内分批"
    if score >= 74:
        return "B", "WATCH", "单票不超过计划资金的8%，等回踩或放量承接"
    return "C", "AVOID", "观察为主，除非次日重新放量转强"


def plan_prices(price: float, pct_chg: float, risk: str) -> tuple[str, float, float]:
    pullback = 0.012 if risk == "低" else 0.018 if risk == "中" else 0.026
    upper = price * (1 - pullback * 0.35)
    lower = price * (1 - pullback)
    stop_pct = 0.045 if risk == "低" else 0.055 if risk == "中" else 0.068
    target_pct = 0.08 if pct_chg < 5.8 else 0.065
    return f"{lower:.2f}-{upper:.2f}", round(price * (1 - stop_pct), 2), round(price * (1 + target_pct), 2)


def build_signal(row: dict[str, Any], trade_date: date) -> Signal | None:
    code = str(row.get("code", "")).zfill(6)
    name = str(row.get("name", ""))
    price = to_float(row.get("price") or row.get("current_price"))
    pct = to_float(row.get("pct") or row.get("pct_chg"))
    volume_ratio = to_float(row.get("volumeRatio") or row.get("volume_ratio") or row.get("vr"), default=1.0)
    turnover = to_float(row.get("turnover"), default=0.0)
    market_cap = to_float(row.get("marketCap") or row.get("floatCap") or row.get("market_cap"), default=0.0)
    main_net = to_float(row.get("mainNet") or row.get("main_net"), default=0.0)

    if not code or not name:
        return None
    if "ST" in name.upper() or "退" in name or price < 3:
        return None
    if not (3 <= pct <= 7):
        return None

    reasons: list[str] = ["当日涨幅处于3%-7%强势区间"]
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

    if main_net > 0:
        reasons.append("主力净流入为正")
    if penalty > 0:
        reasons.append(f"拥挤/流动性风险扣分 {penalty:.1f}")

    risk = risk_level(price, pct, volume_ratio, turnover, penalty, score)
    tier, action, position_hint = classify(score, risk)
    buy_zone, stop_loss, target_price = plan_prices(price, pct, risk)
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
        reasons=reasons,
    )
    signal.ai_comment = rule_comment(signal)
    return signal


def write_csv(signals: list[Signal], csv_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
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
        "buy_zone",
        "stop_loss",
        "target_price",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as file:
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
                    "buy_zone": item.buy_zone,
                    "stop_loss": item.stop_loss,
                    "target_price": item.target_price,
                }
            )


def write_recommendation(signals: list[Signal], path: Path) -> None:
    trade = [asdict(item) for item in signals if item.action == "TRADE"]
    watch = [asdict(item) for item in signals if item.action == "WATCH"]
    avoid = [asdict(item) for item in signals if item.action == "AVOID"]
    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "status": "BUY" if trade else "NO_BUY",
        "liveBuyAllowed": bool(trade),
        "recommendedBuys": trade[:5],
        "watchPlan": watch[:10],
        "qualityRadar": [asdict(item) for item in signals[:10]],
        "upliftTop": [asdict(item) for item in sorted(signals, key=lambda item: item.volume_score, reverse=True)[:10]],
        "reasons": [
            "综合评分采用涨幅强度、量能结构、流动性、市值、资金和拥挤风险",
            "TRADE 只代表进入候选买入池，仍需次日盘口承接确认",
            "高风险或低分标的自动降级为 WATCH / AVOID",
        ],
        "stats": {
            "total": len(signals),
            "trade": len(trade),
            "watch": len(watch),
            "avoid": len(avoid),
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


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
        "blockedReasons": [] if item.action == "TRADE" else item.reasons[:3],
    }


def write_workbench_reports(signals: list[Signal], root: Path, generated_at: str) -> None:
    reports_dir = root / "reports" / "data"
    reports_dir.mkdir(parents=True, exist_ok=True)
    rows = [signal_to_workbench_row(item) for item in signals]
    trade = [row for row in rows if row.get("action") == "TRADE"]
    watch = [row for row in rows if row.get("action") == "WATCH"]
    avoid = [row for row in rows if row.get("action") == "AVOID"]
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
        "marketState": {
            "status": "ACTIVE" if trade else "WATCH",
            "score": min(8, max(1, len(trade) * 2 + len(watch))),
            "note": "选股同步已完成，仍需结合盘中承接与风控确认。",
        },
        "strongNotLimit": strong_rows,
        "watch": strong_rows,
        "selected": strong_rows,
    }
    (reports_dir / "latest-free-a-share-scan.brief.json").write_text(
        json.dumps(scan_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    trading_signals = {
        "requestTime": generated_at,
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
    (reports_dir / "latest-trading-signals.json").write_text(
        json.dumps(trading_signals, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    open_watch = {
        "generatedAt": generated_at,
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
        "attackThemes": [],
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
            }
            for row in rows[:10]
        ],
    }
    (reports_dir / "latest-open-limit-watch.json").write_text(
        json.dumps(open_watch, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    (reports_dir / "backtest-result.json").write_text(
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
        ),
        encoding="utf-8",
    )
    (reports_dir / "paper-trading-state.json").write_text(
        json.dumps(
            {
                "generatedAt": generated_at,
                "metrics": {"openExposurePct": 0, "totalReturnPct": 0},
                "positions": [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
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
    parser.add_argument("--trade-date", default=None)
    parser.add_argument("--live-provider", action="store_true", help="Fetch live market rows from configured provider.")
    parser.add_argument("--no-live-fallback", action="store_true", help="Fail instead of using local snapshots when live providers are unavailable.")
    parser.add_argument("--scan-limit", type=int, default=None, help="Maximum live rows to fetch before scoring.")
    parser.add_argument("--no-db", action="store_true")
    parser.add_argument("--limit", type=int, default=30)
    args = parser.parse_args()

    trade_date = parse_trade_date(args.trade_date)
    if args.live_provider:
        try:
            rows, input_label = live_rows(args.scan_limit, allow_fallback=not args.no_live_fallback)
            input_label = f"{input_label}; scan_limit={args.scan_limit or 'all'}"
        except RuntimeError as exc:
            print(f"live providers unavailable: {exc}", file=sys.stderr)
            return 2
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

    signals = [signal for row in rows if (signal := build_signal(row, trade_date))]
    if args.live_provider and not signals:
        print(f"live provider returned {len(rows)} rows but no rows passed filters; aborting without writing outputs", file=sys.stderr)
        return 2
    signals.sort(key=lambda item: (item.action == "TRADE", item.score, item.volume_ratio, item.pct_chg), reverse=True)
    selected = signals[: args.limit]

    generated_at = datetime.now().isoformat(timespec="seconds")
    payload = {
        "run_at": generated_at,
        "trade_date": trade_date.isoformat(),
        "input": input_label,
        "count": len(selected),
        "signals": [asdict(item) for item in selected],
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    csv_path = Path(args.csv_dir) / f"stock_pool_{trade_date.isoformat()}.csv"
    write_csv(selected, csv_path)
    write_recommendation(selected, Path(args.recommendation))
    write_workbench_reports(selected, repo_root(), generated_at)
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
    if not args.no_db:
        print(f"database: {db_label}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
