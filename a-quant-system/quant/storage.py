from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS stock_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  pct_chg REAL NOT NULL,
  turnover REAL NOT NULL,
  volume_ratio REAL NOT NULL,
  market_cap REAL NOT NULL,
  score REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trade_date, code)
);

CREATE INDEX IF NOT EXISTS idx_stock_pool_trade_date_score
ON stock_pool (trade_date DESC, score DESC);
"""


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(SCHEMA)


def save_stock_pool(db_path: Path, trade_date: str, rows: list[dict]) -> int:
    init_db(db_path)
    created_at = datetime.now().isoformat(timespec="seconds")
    with sqlite3.connect(db_path) as conn:
        conn.executemany(
            """
            INSERT INTO stock_pool (
              trade_date, code, name, price, pct_chg, turnover,
              volume_ratio, market_cap, score, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(trade_date, code) DO UPDATE SET
              name = excluded.name,
              price = excluded.price,
              pct_chg = excluded.pct_chg,
              turnover = excluded.turnover,
              volume_ratio = excluded.volume_ratio,
              market_cap = excluded.market_cap,
              score = excluded.score,
              created_at = excluded.created_at
            """,
            [
                (
                    trade_date,
                    row["code"],
                    row["name"],
                    row["price"],
                    row["pct_chg"],
                    row["turnover"],
                    row["volume_ratio"],
                    row["market_cap"],
                    row["score"],
                    created_at,
                )
                for row in rows
            ],
        )
    return len(rows)


def count_by_date(db_path: Path, trade_date: str) -> int:
    init_db(db_path)
    with sqlite3.connect(db_path) as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM stock_pool WHERE trade_date = ?",
            (trade_date,),
        ).fetchone()[0]


def load_stock_pool(db_path: Path, trade_date: str | None = None) -> list[dict]:
    init_db(db_path)
    sql = """
        SELECT trade_date, code, name, price, pct_chg, turnover,
               volume_ratio, market_cap, score, created_at
        FROM stock_pool
    """
    params: tuple[str, ...] = ()
    if trade_date:
        sql += " WHERE trade_date = ?"
        params = (trade_date,)
    sql += " ORDER BY trade_date, score DESC"
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def list_trade_dates(db_path: Path) -> list[str]:
    init_db(db_path)
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(
            "SELECT DISTINCT trade_date FROM stock_pool ORDER BY trade_date"
        ).fetchall()
    return [row[0] for row in rows]
