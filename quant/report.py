from __future__ import annotations

import csv
from pathlib import Path


def market_cap_text(value: float) -> str:
    if value > 1_000_000:
        return f"{value / 100_000_000:.2f}亿"
    return f"{value:.2f}亿"


def write_daily_report(
    report_dir: Path,
    trade_date: str,
    rows: list[dict],
    source: str,
    db_path: Path,
) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    path = report_dir / f"{trade_date}.md"
    lines = [
        f"# A股每日股票池 - {trade_date}",
        "",
        f"- 数据源：`{source}`",
        f"- 入池数量：{len(rows)}",
        f"- SQLite：`{db_path}`",
        "",
        "## 股票池",
        "",
        "| 排名 | 代码 | 名称 | 价格 | 涨幅 | 换手率 | 量比 | 总市值 | score |",
        "|---:|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for idx, row in enumerate(rows, start=1):
        lines.append(
            "| {rank} | {code} | {name} | {price:.2f} | {pct:.2f}% | "
            "{turnover:.2f}% | {volume_ratio:.2f} | {market_cap} | {score:.2f} |".format(
                rank=idx,
                code=row["code"],
                name=row["name"],
                price=row["price"],
                pct=row["pct_chg"],
                turnover=row["turnover"],
                volume_ratio=row["volume_ratio"],
                market_cap=market_cap_text(row["market_cap"]),
                score=row["score"],
            )
        )
    if not rows:
        lines.append("| - | - | - | - | - | - | - | - | - |")
    lines.extend(
        [
            "",
            "## 策略条件",
            "",
            "- 排除 ST、退市、北交所",
            "- 股价 > 5",
            "- 涨幅 3% 到 7%",
            "- 换手率 3% 到 20%",
            "- 量比 > 1.5",
            "- 总市值 50亿到800亿",
            "- `score = pct_chg * 2 + volume_ratio * 5 + turnover * 0.5`",
            "",
            "> 仅用于研究和模拟跟踪，不构成投资建议。",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def write_daily_csv(csv_dir: Path, trade_date: str, rows: list[dict]) -> Path:
    csv_dir.mkdir(parents=True, exist_ok=True)
    path = csv_dir / f"stock_pool_{trade_date}.csv"
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
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({"trade_date": trade_date, **{key: row[key] for key in columns if key != "trade_date"}})
    return path


def write_backtest_report(report_dir: Path, result: dict) -> Path:
    report_dir.mkdir(parents=True, exist_ok=True)
    name = result["trade_date"] or "all"
    path = report_dir / f"backtest_{name}.md"
    lines = [
        f"# 策略回测 - {name}",
        "",
        f"- 股票池记录：{result['pool_rows']}",
        f"- 成交样本：{result['trades']}",
        f"- 持有天数：{result['hold_days']}",
        f"- 平均收益：{result['average_return_pct']:.2f}%",
        f"- 胜率：{result['win_rate_pct']:.2f}%",
        f"- 最大回撤：{result['max_drawdown_pct']:.2f}%",
        "",
        "## 样本交易",
        "",
        "| 代码 | 名称 | 选股日 | 买入日 | 卖出日 | 买入价 | 卖出价 | 收益率 |",
        "|---|---|---|---|---|---:|---:|---:|",
    ]
    for trade in result["trade_samples"]:
        lines.append(
            "| {code} | {name} | {trade_date} | {buy_date} | {sell_date} | "
            "{buy_price:.2f} | {sell_price:.2f} | {return_pct:.2f}% |".format(**trade)
        )
    if not result["trade_samples"]:
        lines.append("| - | - | - | - | - | - | - | - |")
    if result["skip_samples"]:
        lines.extend(["", "## 跳过样本", ""])
        lines.extend(f"- {item}" for item in result["skip_samples"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
