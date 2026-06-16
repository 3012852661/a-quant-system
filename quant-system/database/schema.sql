CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS stock_quotes (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(64) NOT NULL,
  price NUMERIC(12, 4) NOT NULL,
  pct NUMERIC(8, 4) NOT NULL,
  volume NUMERIC(20, 2),
  amount NUMERIC(20, 2),
  turnover NUMERIC(10, 4),
  volume_ratio NUMERIC(10, 4),
  main_net NUMERIC(20, 2),
  market_cap NUMERIC(20, 2),
  industry VARCHAR(64),
  source VARCHAR(32) NOT NULL DEFAULT 'akshare',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_quotes_code_time
ON stock_quotes (code, captured_at DESC);

CREATE TABLE IF NOT EXISTS stock_pool (
  id BIGSERIAL PRIMARY KEY,
  trade_date DATE NOT NULL,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(64) NOT NULL,
  price NUMERIC(12, 4) NOT NULL,
  pct_chg NUMERIC(8, 4) NOT NULL,
  turnover NUMERIC(10, 4) NOT NULL DEFAULT 0,
  volume_ratio NUMERIC(10, 4) NOT NULL DEFAULT 0,
  market_cap NUMERIC(20, 2) NOT NULL DEFAULT 0,
  score NUMERIC(8, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stock_pool_trade_date_code UNIQUE (trade_date, code)
);

CREATE INDEX IF NOT EXISTS idx_stock_pool_trade_date_score
ON stock_pool (trade_date DESC, score DESC);

CREATE TABLE IF NOT EXISTS financial_snapshots (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  report_date DATE,
  revenue NUMERIC(20, 2),
  net_profit NUMERIC(20, 2),
  gross_margin NUMERIC(10, 4),
  roe NUMERIC(10, 4),
  debt_to_assets NUMERIC(10, 4),
  eps NUMERIC(12, 4),
  source VARCHAR(32) NOT NULL DEFAULT 'tushare',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_financial_snapshots_code_report_source UNIQUE (code, report_date, source)
);

CREATE INDEX IF NOT EXISTS idx_financial_snapshots_code_report
ON financial_snapshots (code, report_date DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  title VARCHAR(256) NOT NULL,
  announcement_date DATE,
  url TEXT,
  category VARCHAR(64),
  source VARCHAR(32) NOT NULL DEFAULT 'cninfo',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_announcements_code_title_date UNIQUE (code, title, announcement_date)
);

CREATE INDEX IF NOT EXISTS idx_announcements_code_date
ON announcements (code, announcement_date DESC);

CREATE TABLE IF NOT EXISTS money_flows (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(64),
  trade_date DATE,
  main_net NUMERIC(20, 2),
  main_net_pct NUMERIC(10, 4),
  super_large_net NUMERIC(20, 2),
  large_net NUMERIC(20, 2),
  medium_net NUMERIC(20, 2),
  small_net NUMERIC(20, 2),
  source VARCHAR(32) NOT NULL DEFAULT 'eastmoney',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_money_flows_code_date_source UNIQUE (code, trade_date, source)
);

CREATE INDEX IF NOT EXISTS idx_money_flows_code_date
ON money_flows (code, trade_date DESC);

CREATE TABLE IF NOT EXISTS stock_signals (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(64) NOT NULL,
  current_price NUMERIC(12, 4) NOT NULL,
  pct NUMERIC(8, 4) NOT NULL,
  volume_ratio NUMERIC(10, 4) NOT NULL,
  trend_score NUMERIC(8, 2) NOT NULL,
  risk_level VARCHAR(8) NOT NULL,
  ai_comment TEXT NOT NULL,
  reasons JSONB NOT NULL,
  signal_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_signals_date_score
ON stock_signals (signal_date DESC, trend_score DESC);

CREATE TABLE IF NOT EXISTS vector_documents (
  id BIGSERIAL PRIMARY KEY,
  doc_id VARCHAR(128) NOT NULL UNIQUE,
  code VARCHAR(10),
  source VARCHAR(32) NOT NULL,
  title VARCHAR(256) NOT NULL,
  content TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding_model VARCHAR(64),
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vector_documents_code_source
ON vector_documents (code, source);

CREATE INDEX IF NOT EXISTS idx_vector_documents_embedding
ON vector_documents USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
