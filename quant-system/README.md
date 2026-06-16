# A股量化选股系统 v1

第一版聚焦每日选股、策略回测、AI分析报告和多角色投资委员会复核。暂不做自动交易。

## 功能

- AkShare 主数据、Tushare 财务补充、巨潮资讯公告、东方财富资金流
- PostgreSQL 结构化存储和向量数据库检索表
- Yahoo Finance、Binance、World Bank、arXiv 等扩展数据源适配
- 趋势突破策略选股
- 生成股票池和趋势评分
- 六角色投资委员会：研究员、基本面分析师、技术分析师、舆情分析师、风险官、投资经理
- 简易持有期回测
- OpenAI 个股点评，可无 Key 运行规则点评
- FastAPI 接口
- APScheduler 每日任务骨架

## 快速开始

只跑选股脚本：

```bash
cd quant-system
.venv/bin/python backend/run_selection.py --trade-date 2026-06-05
```

默认读取已有的 `reports/data/latest-free-a-share-scan.brief.json`，输出三份结果：

- `backend/data/stock_pool_latest.json`
- `data/stock_pool_YYYY-MM-DD.csv`
- `data/quant.db` 里的 `stock_pool` 表

拉取最新行情并选股：

```bash
cd quant-system
.venv/bin/python backend/run_selection.py --trade-date 2026-06-15 --live-provider --scan-limit 500 --limit 30
```

实时模式会按顺序尝试：

1. AkShare `stock_zh_a_spot_em`
2. 东方财富 `push2` 直连接口
3. 本地 `reports/data/latest-free-a-share-scan.brief.json` 兜底

每个实时源有 25 秒超时保护，避免全市场接口长时间无响应。输出 JSON 的 `input` 字段会记录实际数据来源；如果落到本地兜底，需要按报告中的 `requestTime` 判断数据新鲜度。

简单回测：

```bash
.venv/bin/python backend/run_backtest.py --trade-date 2026-06-05 --hold-days 3
```

投资委员会复核：

```bash
.venv/bin/python backend/run_committee.py
```

输出：

- `reports/data/latest-investment-committee.json`
- `reports/data/latest-investment-committee.md`

委员会约束：

- 研究员只聚合客观事实，不做投资判断。
- 基本面分析师只分析收入、利润、毛利率、现金流、估值等可得证据；缺数据必须标记缺口。
- 技术分析师负责 K 线、均线、RSI、布林带、成交量和支撑压力。
- 舆情分析师负责财经新闻评论、社交讨论和热度；未接入时不得把“无数据”当作利好。
- 风险官专门寻找否决项，包括冲高回落、跌破止损、监管/诉讼/减持/解禁/业绩风险。
- 投资经理不能查询新数据，只读取前五位角色报告并输出投资委员会结论。

完整 API 服务：

```bash
cd quant-system
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:app --reload --port 8000
```

打开：

- `http://127.0.0.1:8000/health`
- `http://127.0.0.1:8000/api/stock-pool`
- `http://127.0.0.1:8000/api/committee/latest`
- `http://127.0.0.1:8000/api/backtest?codes=000001,600519`

## 环境变量

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
QUANT_DATA_PROVIDER=akshare
QUANT_DATA_SOURCE_STACK=akshare,tushare,cninfo,eastmoney_moneyflow,postgres,vector
QUANT_MAX_STOCKS=500
QUANT_ENABLE_SCHEDULER=false
QUANT_YAHOO_SYMBOLS=600519.SS,000001.SZ,601318.SS,300750.SZ,000858.SZ
QUANT_BINANCE_SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT
QUANT_WORLD_BANK_INDICATORS=CHN:NY.GDP.MKTP.CD,USA:NY.GDP.MKTP.CD
QUANT_ARXIV_QUERIES=cat:q-fin.ST
QUANT_GOOGLE_SCHOLAR_QUERIES=quantitative trading,market microstructure
IFIND_API_KEY=
TIANYANCHA_API_KEY=
THS_API_KEY=
TUSHARE_TOKEN=
DATABASE_URL=postgresql+psycopg://quant:quant@127.0.0.1:5432/quant
VECTOR_DATABASE_PROVIDER=pgvector
VECTOR_DATABASE_URL=postgresql+psycopg://quant:quant@127.0.0.1:5432/quant
VECTOR_DATABASE_API_KEY=
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000
```

没有安装 AkShare 或网络不可用时，系统会读取仓库已有的 `reports/data/latest-free-a-share-scan.brief.json` 作为演示数据，确保 API 可以先跑起来。

## 数据源

默认数据来源栈由 `QUANT_DATA_SOURCE_STACK` 描述：

1. `akshare`：主数据，负责 A 股实时行情、日线、基础股票池。
2. `tushare`：财务补充，负责利润表、财务指标、估值等；需要 `TUSHARE_TOKEN`。
3. `cninfo` / `juchao`：巨潮资讯公告检索和公告 PDF 链接。
4. `eastmoney_moneyflow`：东方财富资金流，负责主力净流入、大单/超大单分层。
5. `postgres`：结构化持久化，设置 `DATABASE_URL` 后选股落库自动从 SQLite 切换到 PostgreSQL。
6. `vector`：公告、研报、委员会证据的向量检索；默认按 `pgvector` 建模。

通过 `QUANT_DATA_PROVIDER` 切换策略主行情 provider：

- `akshare`：默认 A 股行情与日线。
- `tushare`：Tushare Pro 股票基础、日线和财务快照；需要 `TUSHARE_TOKEN`。
- `eastmoney` / `eastmoney_direct`：东方财富 `push2` 直连实时行情，适合 AkShare 慢或不可用时兜底。
- `eastmoney_moneyflow` / `moneyflow`：东方财富行情 + 资金流补充能力。
- `cninfo` / `juchao`：巨潮公告补充能力，通常不直接作为选股主行情。
- `fallback` / `report`：读取本地报告 JSON，适合离线演示。
- `yahoo` / `yahoo_finance`：读取 `QUANT_YAHOO_SYMBOLS` 中的 Yahoo Finance 标的，例如 `600519.SS`、`AAPL`。
- `binance`：读取 `QUANT_BINANCE_SYMBOLS` 中的现货交易对，例如 `BTCUSDT`。
- `world_bank` / `worldbank`：读取 `QUANT_WORLD_BANK_INDICATORS` 中的宏观指标，格式为 `COUNTRY:INDICATOR`。
- `arxiv`：读取 `QUANT_ARXIV_QUERIES` 研究论文流，适合补充策略研究线索。
- `ifind`、`ths` / `tonghuashun`、`tianyancha`：已预留凭证型接入口，需要对应账号、API Key 或本地授权 SDK 后再落具体客户端。
- `google_scholar` / `scholar`：已预留研究源入口；Google Scholar 没有稳定官方 API，建议后续通过合规第三方服务或人工检索结果入库。

当前趋势突破策略仍主要面向 A 股行情。`binance`、`world_bank`、`arxiv` 更适合作为扩展数据层或研究/风控辅助源，直接跑 `/api/stock-pool` 时可能因为策略条件不匹配而返回空结果。

### PostgreSQL / 向量库初始化

如果使用 PostgreSQL 和 pgvector：

```bash
psql "$DATABASE_URL" -f database/schema.sql
```

脚本落库时会优先读取 `DATABASE_URL`；未配置时继续写入 `quant-system/data/quant.db`，便于本地演示。

## API

- `GET /health`：健康检查
- `GET /api/data-sources`：查看 AkShare、Tushare、巨潮、东方财富资金流、PostgreSQL、向量库配置状态
- `GET /api/stock-pool?limit=30`：运行趋势突破选股并返回股票池
- `GET /api/stocks/{code}/analysis`：获取单只股票分析
- `GET /api/stocks/{code}/supplements`：获取 Tushare 财务、巨潮公告、东方财富资金流补充数据
- `GET /api/backtest?codes=000001,600519&hold_days=5`：简易回测
- `GET /api/committee/latest`：最近一次六角色投资委员会复核
- `POST /api/jobs/run-daily`：手动触发每日任务

## 前端

```bash
cd quant-system/frontend
npm install
npm run dev
```

默认读取 `http://127.0.0.1:8000` 的后端 API。

## 风险提示

本项目只用于研究和模拟交易，不构成投资建议。第一阶段建议至少连续模拟 1-3 个月，再评估是否接入 QMT / PTrade。
