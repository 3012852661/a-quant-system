from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class FactorSpec:
    key: str
    name: str
    category: str
    description: str


FACTOR_SPECS: tuple[FactorSpec, ...] = (
    FactorSpec(
        key="pv_divergence_5_20",
        name="5日量价背离",
        category="price_volume",
        description="5日涨幅截面排名 / 5日均量相对20日均量截面排名；高值代表价强但量能确认偏弱。",
    ),
    FactorSpec(
        key="pv_confirmation_5_20",
        name="5日量价共振",
        category="price_volume",
        description="5日涨幅截面排名 * 5日均量相对20日均量截面排名；高值代表价量同步转强。",
    ),
    FactorSpec(
        key="intraday_resilience_20",
        name="20日承接韧性",
        category="microstructure",
        description="收盘价在当日高低区间位置的20日均值；高值代表日内承接更强。",
    ),
)


def parse_date(value: Any) -> date | None:
    text = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def to_float(value: Any, default: float = np.nan) -> float:
    try:
        if value in (None, "", "-"):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def load_cached_kline_frame(kline_dir: Path, max_codes: int | None = None) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    paths = sorted(kline_dir.glob("*.daily.json"))
    if max_codes:
        paths = paths[:max_codes]
    for path in paths:
        code = path.name.split(".", 1)[0].zfill(6)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        raw_rows = payload.get("klines", payload if isinstance(payload, list) else [])
        for row in raw_rows:
            if isinstance(row, str):
                parts = row.split(",")
                if len(parts) < 6:
                    continue
                trade_date = parse_date(parts[0])
                if not trade_date:
                    continue
                rows.append(
                    {
                        "date": pd.Timestamp(trade_date),
                        "code": code,
                        "open": to_float(parts[1]),
                        "close": to_float(parts[2]),
                        "high": to_float(parts[3]),
                        "low": to_float(parts[4]),
                        "volume": to_float(parts[5]),
                    }
                )
            elif isinstance(row, dict):
                trade_date = parse_date(row.get("date") or row.get("trade_date"))
                if not trade_date:
                    continue
                rows.append(
                    {
                        "date": pd.Timestamp(trade_date),
                        "code": code,
                        "open": to_float(row.get("open")),
                        "close": to_float(row.get("close")),
                        "high": to_float(row.get("high")),
                        "low": to_float(row.get("low")),
                        "volume": to_float(row.get("volume")),
                    }
                )
    frame = pd.DataFrame(rows)
    if frame.empty:
        return frame
    frame = frame.dropna(subset=["date", "code", "open", "close", "high", "low", "volume"])
    frame = frame.sort_values(["date", "code"]).drop_duplicates(["date", "code"], keep="last")
    return frame


def load_latest_exposures(paths: list[Path]) -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    for path in paths:
        if not path.exists():
            continue
        try:
            if path.suffix.lower() == ".csv":
                frame = pd.read_csv(path, dtype={"code": str})
                items = frame.to_dict("records")
            else:
                payload = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(payload, dict):
                    items = payload.get("signals") or payload.get("rows") or payload.get("stocks") or []
                else:
                    items = payload if isinstance(payload, list) else []
        except (OSError, json.JSONDecodeError, UnicodeDecodeError, pd.errors.ParserError):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or item.get("代码") or "").zfill(6)
            if not code:
                continue
            rows.append(
                {
                    "code": code,
                    "name": item.get("name") or item.get("真实简称") or item.get("输入名称") or code,
                    "industry": item.get("industry") or item.get("primary_theme") or item.get("primaryTheme") or "",
                    "market_cap": to_float(item.get("marketCap") or item.get("market_cap") or item.get("floatCap"), np.nan),
                }
            )
    if not rows:
        return pd.DataFrame(columns=["code", "name", "industry", "market_cap"])
    frame = pd.DataFrame(rows).drop_duplicates("code", keep="last")
    return frame


def make_panel(frame: pd.DataFrame) -> dict[str, pd.DataFrame]:
    return {
        key: frame.pivot(index="date", columns="code", values=key).sort_index()
        for key in ("open", "close", "high", "low", "volume")
    }


def compute_raw_factors(panel: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    close = panel["close"]
    high = panel["high"]
    low = panel["low"]
    volume = panel["volume"]
    ret5 = close.pct_change(5, fill_method=None)
    volume_ratio = volume.rolling(5).mean() / volume.rolling(20).mean()
    price_rank = ret5.rank(axis=1, pct=True)
    volume_rank = volume_ratio.rank(axis=1, pct=True)
    day_range = (high - low).replace(0, np.nan)
    close_location = ((close - low) / day_range).clip(0, 1)
    return {
        "pv_divergence_5_20": price_rank / (volume_rank + 1e-5),
        "pv_confirmation_5_20": price_rank * volume_rank,
        "intraday_resilience_20": close_location.rolling(20).mean(),
    }


def winsorize_mad(factor: pd.DataFrame, n: float = 3.0) -> pd.DataFrame:
    median = factor.median(axis=1, skipna=True)
    abs_dev = factor.sub(median, axis=0).abs()
    mad = abs_dev.median(axis=1, skipna=True).replace(0, np.nan)
    lower = median - n * 1.4826 * mad
    upper = median + n * 1.4826 * mad
    return factor.clip(lower=lower, upper=upper, axis=0)


def neutralize_latest_exposures(factor: pd.DataFrame, exposures: pd.DataFrame) -> pd.DataFrame:
    if factor.empty or exposures.empty:
        return factor
    expo = exposures.set_index("code")
    codes = [code for code in factor.columns if code in expo.index]
    if len(codes) < 8:
        return factor
    result = factor.copy()
    cap = pd.to_numeric(expo.reindex(codes)["market_cap"], errors="coerce")
    log_cap = np.log(cap.where(cap > 0))
    industry = expo.reindex(codes)["industry"].fillna("").astype(str)
    dummies = pd.get_dummies(industry.where(industry != "", "unknown"), dtype=float)
    x = pd.concat([log_cap.rename("log_cap"), dummies], axis=1).replace([np.inf, -np.inf], np.nan)
    for idx in result.index:
        y = result.loc[idx, codes].astype(float)
        valid = y.notna() & x.notna().all(axis=1)
        if valid.sum() < max(8, min(20, x.shape[1] + 2)):
            continue
        x_valid = x.loc[valid].to_numpy(dtype=float)
        y_valid = y.loc[valid].to_numpy(dtype=float)
        x_valid = np.column_stack([np.ones(len(x_valid)), x_valid])
        try:
            beta, *_ = np.linalg.lstsq(x_valid, y_valid, rcond=None)
        except np.linalg.LinAlgError:
            continue
        fitted = x_valid @ beta
        result.loc[idx, list(y.loc[valid].index)] = y_valid - fitted
    return result


def standardize_zscore(factor: pd.DataFrame) -> pd.DataFrame:
    mean = factor.mean(axis=1, skipna=True)
    std = factor.std(axis=1, skipna=True).replace(0, np.nan)
    return factor.sub(mean, axis=0).div(std, axis=0)


def clean_factor(raw: pd.DataFrame, exposures: pd.DataFrame) -> pd.DataFrame:
    cleaned = winsorize_mad(raw)
    cleaned = neutralize_latest_exposures(cleaned, exposures)
    return standardize_zscore(cleaned)


def forward_returns(close: pd.DataFrame, horizon: int) -> pd.DataFrame:
    return close.shift(-horizon) / close - 1


def rank_ic_series(factor: pd.DataFrame, future_ret: pd.DataFrame) -> pd.Series:
    values: dict[pd.Timestamp, float] = {}
    common_dates = factor.index.intersection(future_ret.index)
    for current_date in common_dates:
        sample = pd.DataFrame({"factor": factor.loc[current_date], "ret": future_ret.loc[current_date]}).dropna()
        if len(sample) < 5:
            continue
        ranked = sample.rank(method="average")
        values[current_date] = float(ranked["factor"].corr(ranked["ret"]))
    return pd.Series(values).sort_index()


def quantile_forward_returns(factor: pd.DataFrame, future_ret: pd.DataFrame, bins: int = 5) -> dict[str, Any]:
    grouped: dict[int, list[float]] = {idx: [] for idx in range(1, bins + 1)}
    common_dates = factor.index.intersection(future_ret.index)
    for current_date in common_dates:
        sample = pd.DataFrame({"factor": factor.loc[current_date], "ret": future_ret.loc[current_date]}).dropna()
        if len(sample) < bins * 2:
            continue
        ranks = sample["factor"].rank(method="first")
        quantiles = pd.qcut(ranks, bins, labels=False, duplicates="drop")
        if quantiles.isna().all():
            continue
        sample = sample.assign(quantile=quantiles.astype(int) + 1)
        for quantile, rows in sample.groupby("quantile"):
            grouped[int(quantile)].append(float(rows["ret"].mean()))
    means = {f"q{idx}": round(float(np.nanmean(items) * 100), 4) if items else None for idx, items in grouped.items()}
    top = means.get(f"q{bins}")
    bottom = means.get("q1")
    return {
        "bins": bins,
        "mean_forward_return_pct_by_quantile": means,
        "top_minus_bottom_pct": round(top - bottom, 4) if top is not None and bottom is not None else None,
        "monotonic": _is_monotonic([means.get(f"q{idx}") for idx in range(1, bins + 1)]),
    }


def _is_monotonic(values: list[float | None]) -> bool:
    cleaned = [item for item in values if item is not None and not math.isnan(item)]
    return len(cleaned) >= 3 and all(left <= right for left, right in zip(cleaned, cleaned[1:]))


def evaluate_factor(cleaned: pd.DataFrame, close: pd.DataFrame, horizon: int, bins: int) -> dict[str, Any]:
    future_ret = forward_returns(close, horizon)
    ic = rank_ic_series(cleaned, future_ret)
    mean_ic = float(ic.mean()) if not ic.empty else 0.0
    std_ic = float(ic.std(ddof=1)) if len(ic) > 1 else 0.0
    ir = mean_ic / std_ic if std_ic else 0.0
    quantiles = quantile_forward_returns(cleaned, future_ret, bins=bins)
    return {
        "horizon_days": horizon,
        "observations": int(ic.count()),
        "mean_rank_ic": round(mean_ic, 4),
        "abs_mean_rank_ic": round(abs(mean_ic), 4),
        "rank_ic_ir": round(ir, 4),
        "rank_ic_positive_rate_pct": round(float((ic > 0).mean() * 100), 2) if not ic.empty else 0.0,
        "orientation": 1 if mean_ic >= 0 else -1,
        "passes_research_gate": bool(abs(mean_ic) >= 0.03 and abs(ir) >= 0.2 and ic.count() >= 20),
        "quantile_analysis": quantiles,
    }


def latest_scores(cleaned_factors: dict[str, pd.DataFrame], metrics: dict[str, Any], exposures: pd.DataFrame) -> pd.DataFrame:
    oriented: list[pd.DataFrame] = []
    for key, frame in cleaned_factors.items():
        latest_date = frame.dropna(how="all").index.max()
        if pd.isna(latest_date):
            continue
        orientation = int(metrics.get(key, {}).get("orientation") or 1)
        series = frame.loc[latest_date] * orientation
        oriented.append(series.rename(key).to_frame())
    if not oriented:
        return pd.DataFrame()
    merged = pd.concat(oriented, axis=1)
    merged["factorCompositeZ"] = merged.mean(axis=1, skipna=True)
    merged["factorCompositeScore"] = merged["factorCompositeZ"].rank(pct=True) * 100
    merged = merged.dropna(subset=["factorCompositeScore"])
    merged = merged.reset_index().rename(columns={"index": "code"})
    if not exposures.empty:
        merged = merged.merge(exposures[["code", "name", "industry", "market_cap"]], how="left", on="code")
    cols = ["code", "name", "industry", "market_cap", "factorCompositeZ", "factorCompositeScore"] + [
        spec.key for spec in FACTOR_SPECS if spec.key in merged.columns
    ]
    return merged[[col for col in cols if col in merged.columns]].sort_values("factorCompositeScore", ascending=False)


def build_factor_registry(metrics: dict[str, Any]) -> dict[str, Any]:
    factors: list[dict[str, Any]] = []
    spec_by_key = {spec.key: spec for spec in FACTOR_SPECS}
    for key, item in metrics.items():
        spec = spec_by_key.get(key)
        if not spec:
            continue
        factors.append(
            {
                "key": key,
                "name": spec.name,
                "category": spec.category,
                "description": spec.description,
                "status": "CANDIDATE" if item.get("passes_research_gate") else "WATCH_ONLY",
                "meanRankIc": item.get("mean_rank_ic"),
                "rankIcIr": item.get("rank_ic_ir"),
                "orientation": item.get("orientation"),
                "gate": "abs(IC)>=0.03, abs(IR)>=0.2, observations>=20",
            }
        )
    return {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": "reports/data/kline-cache",
        "factors": factors,
    }


def dataframe_records(frame: pd.DataFrame, limit: int | None = None) -> list[dict[str, Any]]:
    sample = frame.head(limit) if limit else frame
    cleaned = sample.replace([np.inf, -np.inf], np.nan)
    records = cleaned.astype(object).where(pd.notna(cleaned), None).to_dict("records")
    for record in records:
        for key, value in list(record.items()):
            if isinstance(value, (np.floating, float)):
                record[key] = round(float(value), 6)
    return records
