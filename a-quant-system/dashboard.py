from __future__ import annotations

import argparse
import html
import sqlite3
from pathlib import Path


def load_rows(db_path: Path) -> list[dict]:
    if not db_path.exists():
        return []
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in conn.execute(
                """
                SELECT trade_date, code, name, price, pct_chg, turnover,
                       volume_ratio, market_cap, score, created_at
                FROM stock_pool
                ORDER BY trade_date DESC, score DESC
                LIMIT 100
                """
            ).fetchall()
        ]


def render_rows(rows: list[dict]) -> str:
    if not rows:
        return '<tr><td class="empty" colspan="10">暂无正式股票池记录。真实行情获取成功后才会入库。</td></tr>'
    cells = []
    for row in rows:
        cells.append(
            "<tr>"
            f"<td>{html.escape(str(row['trade_date']))}</td>"
            f"<td class=\"mono\">{html.escape(str(row['code']))}</td>"
            f"<td>{html.escape(str(row['name']))}</td>"
            f"<td>{row['price']:.2f}</td>"
            f"<td class=\"up\">{row['pct_chg']:.2f}%</td>"
            f"<td>{row['turnover']:.2f}%</td>"
            f"<td>{row['volume_ratio']:.2f}</td>"
            f"<td>{row['market_cap'] / 100000000:.2f}亿</td>"
            f"<td><span class=\"score\">{row['score']:.2f}</span></td>"
            f"<td>{html.escape(str(row['created_at']))}</td>"
            "</tr>"
        )
    return "\n".join(cells)


def build_html(rows: list[dict], db_path: Path) -> str:
    count = len(rows)
    latest_date = rows[0]["trade_date"] if rows else "-"
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>A股量化系统验证页</title>
  <style>
    body {{ margin: 0; background: #f5f6f8; color: #141922; font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }}
    .shell {{ width: min(1440px, 100%); margin: 0 auto; padding: 24px; }}
    h1 {{ margin: 0 0 6px; font-size: 26px; }}
    .sub {{ margin: 0 0 18px; color: #667085; }}
    .metrics {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }}
    .metric {{ background: #fff; border: 1px solid #d9dee7; border-radius: 8px; padding: 14px; }}
    .metric span {{ display: block; color: #667085; font-size: 13px; margin-bottom: 8px; }}
    .metric strong {{ font-size: 26px; }}
    .notice {{ background: #fff8e6; border: 1px solid #e7c875; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; color: #6f4b00; }}
    .tableWrap {{ overflow-x: auto; border: 1px solid #d9dee7; border-radius: 8px; background: #fff; }}
    table {{ width: 100%; min-width: 1080px; border-collapse: collapse; }}
    th, td {{ padding: 12px 14px; border-bottom: 1px solid #d9dee7; text-align: left; font-size: 14px; }}
    th {{ background: #eef1f5; color: #384152; font-size: 12px; }}
    .mono {{ font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }}
    .up {{ color: #c93636; font-weight: 700; }}
    .score {{ color: #2557a7; background: #e9effb; border-radius: 6px; padding: 4px 8px; font-weight: 700; }}
    .empty {{ height: 140px; color: #667085; text-align: center; vertical-align: middle; }}
    @media (max-width: 760px) {{ .metrics {{ grid-template-columns: 1fr; }} .shell {{ padding: 16px; }} }}
  </style>
</head>
<body>
  <main class="shell">
    <h1>A股量化系统验证页</h1>
    <p class="sub">只展示正式 SQLite 中的真实行情入库结果，不展示开发数据。</p>
    <section class="metrics">
      <div class="metric"><span>正式记录数</span><strong>{count}</strong></div>
      <div class="metric"><span>最新交易日</span><strong>{html.escape(str(latest_date))}</strong></div>
      <div class="metric"><span>数据库</span><strong>stock_pool.db</strong></div>
    </section>
    <div class="notice">真实数据原则：AkShare 获取失败时系统失败退出，不写库、不生成正式日报、不自动 fallback。</div>
    <section class="tableWrap">
      <table>
        <thead>
          <tr>
            <th>交易日</th><th>代码</th><th>名称</th><th>价格</th><th>涨幅</th>
            <th>换手率</th><th>量比</th><th>总市值</th><th>score</th><th>入库时间</th>
          </tr>
        </thead>
        <tbody>{render_rows(rows)}</tbody>
      </table>
    </section>
  </main>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate local verification dashboard.")
    parser.add_argument("--db", default="data/stock_pool.db")
    parser.add_argument("--output", default="reports/status.html")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    db_path = root / args.db
    output_path = root / args.output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    rows = load_rows(db_path)
    output_path.write_text(build_html(rows, db_path), encoding="utf-8")
    print(f"dashboard: {output_path}")
    print(f"formal_rows: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
