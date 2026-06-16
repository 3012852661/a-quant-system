from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    data_provider: str = Field("akshare", validation_alias=AliasChoices("QUANT_DATA_PROVIDER", "DATA_PROVIDER"))
    data_source_stack: str = Field(
        "akshare,tushare,cninfo,eastmoney_moneyflow,postgres,vector",
        validation_alias=AliasChoices("QUANT_DATA_SOURCE_STACK", "DATA_SOURCE_STACK"),
    )
    max_stocks: int = Field(500, validation_alias=AliasChoices("QUANT_MAX_STOCKS", "MAX_STOCKS"))
    enable_scheduler: bool = Field(False, validation_alias=AliasChoices("QUANT_ENABLE_SCHEDULER", "ENABLE_SCHEDULER"))
    openai_api_key: str | None = Field(None, validation_alias=AliasChoices("OPENAI_API_KEY", "QUANT_OPENAI_API_KEY"))
    openai_model: str = Field("gpt-4.1-mini", validation_alias=AliasChoices("OPENAI_MODEL", "QUANT_OPENAI_MODEL"))
    yahoo_symbols: str = Field(
        "600519.SS,000001.SZ,601318.SS,300750.SZ,000858.SZ",
        validation_alias=AliasChoices("QUANT_YAHOO_SYMBOLS", "YAHOO_SYMBOLS"),
    )
    binance_symbols: str = Field(
        "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT",
        validation_alias=AliasChoices("QUANT_BINANCE_SYMBOLS", "BINANCE_SYMBOLS"),
    )
    world_bank_indicators: str = Field(
        "CHN:NY.GDP.MKTP.CD,USA:NY.GDP.MKTP.CD",
        validation_alias=AliasChoices("QUANT_WORLD_BANK_INDICATORS", "WORLD_BANK_INDICATORS"),
    )
    arxiv_queries: str = Field(
        "cat:q-fin.ST",
        validation_alias=AliasChoices("QUANT_ARXIV_QUERIES", "ARXIV_QUERIES"),
    )
    google_scholar_queries: str = Field(
        "quantitative trading,market microstructure",
        validation_alias=AliasChoices("QUANT_GOOGLE_SCHOLAR_QUERIES", "GOOGLE_SCHOLAR_QUERIES"),
    )
    ifind_api_key: str | None = Field(None, validation_alias=AliasChoices("IFIND_API_KEY", "QUANT_IFIND_API_KEY"))
    tianyancha_api_key: str | None = Field(
        None,
        validation_alias=AliasChoices("TIANYANCHA_API_KEY", "QUANT_TIANYANCHA_API_KEY"),
    )
    ths_api_key: str | None = Field(None, validation_alias=AliasChoices("THS_API_KEY", "QUANT_THS_API_KEY"))
    tushare_token: str | None = Field(None, validation_alias=AliasChoices("TUSHARE_TOKEN", "QUANT_TUSHARE_TOKEN"))
    cninfo_base_url: str = Field(
        "https://www.cninfo.com.cn/new/hisAnnouncement/query",
        validation_alias=AliasChoices("CNINFO_BASE_URL", "QUANT_CNINFO_BASE_URL"),
    )
    database_url: str | None = Field(None, validation_alias=AliasChoices("DATABASE_URL", "QUANT_DATABASE_URL"))
    vector_database_url: str | None = Field(
        None,
        validation_alias=AliasChoices("VECTOR_DATABASE_URL", "QUANT_VECTOR_DATABASE_URL"),
    )
    vector_database_provider: str = Field(
        "pgvector",
        validation_alias=AliasChoices("VECTOR_DATABASE_PROVIDER", "QUANT_VECTOR_DATABASE_PROVIDER"),
    )
    vector_database_api_key: str | None = Field(
        None,
        validation_alias=AliasChoices("VECTOR_DATABASE_API_KEY", "QUANT_VECTOR_DATABASE_API_KEY"),
    )
    fallback_report_path: Path = Field(
        Path("reports/data/latest-free-a-share-scan.brief.json"),
        validation_alias=AliasChoices("QUANT_FALLBACK_REPORT_PATH", "FALLBACK_REPORT_PATH"),
    )


settings = Settings()
