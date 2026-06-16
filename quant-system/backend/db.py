from __future__ import annotations

from pathlib import Path

from sqlalchemy import (
    Column,
    Date,
    DateTime,
    Float,
    Integer,
    JSON,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    func,
)
from sqlalchemy.engine import Engine

from backend.config import settings


metadata = MetaData()

stock_pool = Table(
    "stock_pool",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("trade_date", Date, nullable=False),
    Column("code", String(10), nullable=False),
    Column("name", String(64), nullable=False),
    Column("price", Float, nullable=False),
    Column("pct_chg", Float, nullable=False),
    Column("turnover", Float, nullable=False, default=0),
    Column("volume_ratio", Float, nullable=False, default=0),
    Column("market_cap", Float, nullable=False, default=0),
    Column("score", Float, nullable=False, default=0),
    Column("created_at", DateTime, nullable=False, server_default=func.now()),
    UniqueConstraint("trade_date", "code", name="uq_stock_pool_trade_date_code"),
)

financial_snapshots = Table(
    "financial_snapshots",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("code", String(10), nullable=False),
    Column("report_date", Date, nullable=True),
    Column("revenue", Float, nullable=True),
    Column("net_profit", Float, nullable=True),
    Column("gross_margin", Float, nullable=True),
    Column("roe", Float, nullable=True),
    Column("debt_to_assets", Float, nullable=True),
    Column("eps", Float, nullable=True),
    Column("source", String(32), nullable=False, default="tushare"),
    Column("created_at", DateTime, nullable=False, server_default=func.now()),
    UniqueConstraint("code", "report_date", "source", name="uq_financial_snapshots_code_report_source"),
)

announcements = Table(
    "announcements",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("code", String(10), nullable=False),
    Column("title", String(256), nullable=False),
    Column("announcement_date", Date, nullable=True),
    Column("url", Text, nullable=True),
    Column("category", String(64), nullable=True),
    Column("source", String(32), nullable=False, default="cninfo"),
    Column("created_at", DateTime, nullable=False, server_default=func.now()),
    UniqueConstraint("code", "title", "announcement_date", name="uq_announcements_code_title_date"),
)

money_flows = Table(
    "money_flows",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("code", String(10), nullable=False),
    Column("name", String(64), nullable=True),
    Column("trade_date", Date, nullable=True),
    Column("main_net", Float, nullable=True),
    Column("main_net_pct", Float, nullable=True),
    Column("super_large_net", Float, nullable=True),
    Column("large_net", Float, nullable=True),
    Column("medium_net", Float, nullable=True),
    Column("small_net", Float, nullable=True),
    Column("source", String(32), nullable=False, default="eastmoney"),
    Column("created_at", DateTime, nullable=False, server_default=func.now()),
    UniqueConstraint("code", "trade_date", "source", name="uq_money_flows_code_date_source"),
)

vector_documents = Table(
    "vector_documents",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("doc_id", String(128), nullable=False, unique=True),
    Column("code", String(10), nullable=True),
    Column("source", String(32), nullable=False),
    Column("title", String(256), nullable=False),
    Column("content", Text, nullable=False),
    Column("metadata_json", JSON, nullable=False, default=dict),
    Column("embedding_model", String(64), nullable=True),
    Column("created_at", DateTime, nullable=False, server_default=func.now()),
)


def create_sqlite_engine(path: Path) -> Engine:
    path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(f"sqlite:///{path}", future=True)


def create_database_engine(default_sqlite_path: Path | None = None) -> Engine:
    if settings.database_url:
        return create_engine(settings.database_url, future=True, pool_pre_ping=True)
    if default_sqlite_path is None:
        default_sqlite_path = Path("data/quant.db")
    return create_sqlite_engine(default_sqlite_path)


def init_db(engine: Engine) -> None:
    metadata.create_all(engine)
