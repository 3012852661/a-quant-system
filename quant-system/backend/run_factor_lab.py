from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.factors.lab import (
    FACTOR_SPECS,
    build_factor_registry,
    clean_factor,
    compute_raw_factors,
    dataframe_records,
    evaluate_factor,
    latest_scores,
    load_cached_kline_frame,
    load_latest_exposures,
    make_panel,
)
from backend.run_selection import repo_root


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_markdown(path: Path, payload: dict) -> None:
    lines = [
        "# 因子实验报告",
        "",
        f"- 生成时间：{payload['generatedAt']}",
        f"- 样本股票数：{payload['summary']['codes']}",
        f"- 样本交易日：{payload['summary']['dates']}",
        f"- 预测持有期：{payload['summary']['horizonDays']} 个交易日",
        "",
        "## IC / IR",
        "",
        "| 因子 | Rank IC | IR | 样本数 | 闸门 |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for item in payload["factors"]:
        gate = "通过" if item["passesResearchGate"] else "观察"
        lines.append(
            f"| {item['name']} | {item['meanRankIc']:.4f} | {item['rankIcIr']:.4f} | "
            f"{item['observations']} | {gate} |"
        )
    lines.extend(["", "## 最新因子分 Top 20", ""])
    for row in payload.get("topScores", [])[:20]:
        name = row.get("name") or row.get("code")
        lines.append(f"- {row['code']} {name}：{row.get('factorCompositeScore', 0):.2f}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run factor cleaning, IC/IR and quantile analysis on cached A-share klines.")
    parser.add_argument("--horizon-days", type=int, default=3)
    parser.add_argument("--quantiles", type=int, default=5)
    parser.add_argument("--max-codes", type=int, default=None)
    parser.add_argument("--top", type=int, default=50)
    parser.add_argument("--output", default=str(repo_root() / "reports/data/latest-factor-lab.json"))
    parser.add_argument("--scores-output", default=str(repo_root() / "reports/data/latest-factor-scores.json"))
    parser.add_argument("--registry-output", default=str(repo_root() / "reports/data/factor-registry.json"))
    parser.add_argument("--markdown-output", default=str(repo_root() / "reports/data/latest-factor-lab.md"))
    args = parser.parse_args()

    root = repo_root()
    kline_frame = load_cached_kline_frame(root / "reports/data/kline-cache", max_codes=args.max_codes)
    if kline_frame.empty:
        raise RuntimeError("no cached klines found under reports/data/kline-cache")
    panel = make_panel(kline_frame)
    exposures = load_latest_exposures(
        [
            root / "quant-system/backend/data/stock_pool_latest.json",
            root / "reports/data/latest-trading-signals.json",
            root / "reports/data/latest-free-a-share-scan.brief.json",
        ]
        + sorted((root / "quant-system/data").glob("stock_pool_*.csv"), reverse=True)[:5]
    )
    raw_factors = compute_raw_factors(panel)
    cleaned_factors = {key: clean_factor(value, exposures) for key, value in raw_factors.items()}
    metrics = {
        key: evaluate_factor(value, panel["close"], horizon=args.horizon_days, bins=args.quantiles)
        for key, value in cleaned_factors.items()
    }
    score_frame = latest_scores(cleaned_factors, metrics, exposures)
    registry = build_factor_registry(metrics)
    active_factor_keys = [key for key, metric in metrics.items() if metric.get("passes_research_gate")]
    factors = []
    spec_by_key = {spec.key: spec for spec in FACTOR_SPECS}
    for key, metric in metrics.items():
        spec = spec_by_key[key]
        factors.append(
            {
                "key": key,
                "name": spec.name,
                "category": spec.category,
                "description": spec.description,
                "meanRankIc": metric["mean_rank_ic"],
                "absMeanRankIc": metric["abs_mean_rank_ic"],
                "rankIcIr": metric["rank_ic_ir"],
                "observations": metric["observations"],
                "orientation": metric["orientation"],
                "passesResearchGate": metric["passes_research_gate"],
                "quantileAnalysis": metric["quantile_analysis"],
            }
        )
    payload = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": "reports/data/kline-cache",
        "summary": {
            "codes": int(kline_frame["code"].nunique()),
            "dates": int(kline_frame["date"].nunique()),
            "horizonDays": args.horizon_days,
            "quantiles": args.quantiles,
            "researchGate": "abs(IC)>=0.03, abs(IR)>=0.2, observations>=20",
        },
        "factors": factors,
        "topScores": dataframe_records(score_frame, args.top),
    }
    write_json(Path(args.output), payload)
    write_json(
        Path(args.scores_output),
        {
            "generatedAt": payload["generatedAt"],
            "activeFactors": active_factor_keys,
            "selectionEnabled": bool(active_factor_keys),
            "scores": dataframe_records(score_frame),
        },
    )
    write_json(Path(args.registry_output), registry)
    write_markdown(Path(args.markdown_output), payload)
    print(f"factors: {len(factors)}")
    print(f"codes: {payload['summary']['codes']}")
    print(f"json: {args.output}")
    print(f"scores: {args.scores_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
