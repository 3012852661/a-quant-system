# A股量化选股系统 v1

第一版聚焦每日选股、策略回测、AI分析报告和多角色投资委员会复核。暂不做自动交易。

## 融合路线

系统演进按三阶段推进：第一阶段以 TradingAgents-CN 的多 Agent 研究范式打通 AI 研究层；第二阶段吸收 QuantDinger 的策略、回测、Paper Trading 和执行抽象，形成交易执行层；第三阶段融合成统一平台，覆盖分析、策略、回测、模拟、实盘、复盘、知识库、政策监控、自选监控和日报。

详细路线见 [TradingAgents-CN + QuantDinger 融合路线](docs/tradingagents-quantdinger-integration.md)。

## 功能

- AkShare 主数据、Tushare 财务补充、巨潮资讯公告、东方财富资金流
- PostgreSQL 结构化存储和向量数据库检索表
- Yahoo Finance、Binance、World Bank、arXiv 等扩展数据源适配
- 趋势突破策略选股
- 生成股票池和趋势评分
- 六角色投资委员会：研究员、基本面分析师、技术分析师、舆情分析师、风险官、投资经理
- 六层 AI Stock Agent 知识库：Strategy、Factor、Policy、Report、Case、Risk
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

事件驱动执行约束回测：

```bash
.venv/bin/python backend/run_event_backtest.py --hold-days 3 --limit 30
```

输出 `reports/data/event-backtest-result.json`。该引擎按 QuantDinger 的执行层思路加入 A 股规则：T+1、涨跌停不可成交、手续费、印花税、滑点和成交量参与率限制。它不会替换旧的轻量回测脚本，先作为第二阶段的真实执行约束验证器。

`run_backtest.py` 默认使用 `--mode auto`：先尝试“事件后验”口径，即股票池日期后下一个交易日买入、持有 N 日；如果股票池日期太新、没有未来 K 线，会自动切换为“历史滚动”口径，对同一批候选代码在本地 K 线缓存中抽取历史持有期样本。需要严格检查未来 K 线是否齐全时，可显式使用：

```bash
.venv/bin/python backend/run_backtest.py --trade-date 2026-06-23 --hold-days 3 --mode event-forward
.venv/bin/python backend/run_backtest.py --trade-date 2026-06-23 --hold-days 3 --mode historical-rolling
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

AI 研究层报告：

```bash
.venv/bin/python backend/run_research.py
.venv/bin/python backend/run_research.py --codes 000001,600519
.venv/bin/python backend/run_research.py --codes 000001,600519 --live-sources --source-page-size 5
.venv/bin/python backend/run_news_ingest.py --title "新闻标题" --source "来源" --summary "事实摘要"
.venv/bin/python backend/run_report_ingest.py --title "研报标题" --institution "机构" --summary "核心观点" --risk "风险提示"
```

研究层复用六角色投资委员会作为第一版多 Agent 分析链，额外输出统一 Evidence 和 ResearchReport。默认离线稳定运行，会把 `knowledge/Report-KB`、`knowledge/Policy-KB`、`knowledge/News-KB`、`knowledge/Case-KB` 纳入 Evidence，并把公告、财务、实时新闻、资金流的未接入状态写入数据缺口。加 `--live-sources` 后会尝试接入巨潮公告、Tushare 财务快照、配置式新闻源和东方财富资金流；新闻源支持人工入库，也支持授权 JSON/RSS 源。

- `reports/data/latest-research-report.json`
- `reports/data/latest-research-report.md`
- `reports/data/research-evidence/*.json`

策略注册表：

```bash
.venv/bin/python backend/run_strategy_registry.py
.venv/bin/python backend/run_strategy_review.py
```

输出 `reports/data/strategy-registry.json`。该文件把内置策略和 `knowledge/Strategy-KB` 里的策略卡片统一为 `StrategySpec`，作为第二阶段“策略 → 回测 → Paper Trading → 实盘适配”的中心契约。
`run_strategy_review.py` 会额外输出 `reports/data/strategy-quality-review.json/md`，把回测指标转换为 Paper/Production 准入闸门和阻塞原因。

策略生成、参数回测和失败复盘：

```bash
.venv/bin/python backend/run_parameter_backtest.py --base-key volume_breakout --limit 30 --window 160
.venv/bin/python backend/run_case_kb_from_failure.py
```

`run_parameter_backtest.py` 会基于失败策略自动生成参数变体并批量回测，输出 `reports/data/parameter-backtest-result.json`。如果仍未通过准入，`run_case_kb_from_failure.py` 会把失败原因、最佳参数组合和下一步动作写入 `knowledge/Case-KB`，供研究 Agent、风险官和后续策略生成引用。

因子实验与入库：

```bash
.venv/bin/python backend/run_factor_lab.py --horizon-days 3 --quantiles 5
```

输出：

- `reports/data/latest-factor-lab.json`：因子 IC/IR、五分位分层和样本摘要。
- `reports/data/latest-factor-lab.md`：可读版因子实验报告。
- `reports/data/latest-factor-scores.json`：最新截面因子得分，选股脚本会自动读取并小幅调整规则评分。
- `reports/data/factor-registry.json`：候选因子注册表，通过研究闸门的因子标记为 `CANDIDATE`。

当前内置 `5日量价背离`、`5日量价共振` 和 `20日承接韧性` 三类短线量价因子。流程包含 MAD 去极值、行业/市值中性化、Z-score 标准化、Rank IC/IR 和五分位分层检验。未生成因子分时，原有选股流程不受影响。

Agent Gateway：

```bash
curl http://127.0.0.1:8000/api/agent/v1/capabilities
```

网关用于把本系统作为外部 Agent 可调用的研究/执行平台。它采用 QuantDinger 风格的 `PAPER_ONLY` 安全边界：读接口开放研究报告、策略注册表和工作台快照；写接口只开放 `/api/agent/v1/orders/preflight`，并强制 `dryRun=true` 做风险预检。所有调用写入 `reports/data/agent-gateway-audit.jsonl`。

Paper Trading 执行层：

```bash
.venv/bin/python backend/run_paper_order.py --side BUY --code 000001 --quantity 100 --price 10
.venv/bin/python backend/run_paper_order.py --side BUY --code 000001 --quantity 100 --price 10 --execute
```

默认只做 dry-run 预检；加 `--execute` 后也只会写入本地 paper 账户。执行审计写入 `reports/data/execution-audit.jsonl`，实盘 broker adapter 默认禁用。

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
QUANT_DATA_PROVIDER=eastmoney_direct
QUANT_ALLOW_REPORT_FALLBACK=false
QUANT_DATA_SOURCE_STACK=akshare,tushare,cninfo,news,eastmoney_moneyflow,postgres,vector
QUANT_MAX_STOCKS=500
QUANT_ENABLE_SCHEDULER=false
QUANT_YAHOO_SYMBOLS=600519.SS,000001.SZ,601318.SS,300750.SZ,000858.SZ
QUANT_BINANCE_SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT
QUANT_WORLD_BANK_INDICATORS=CHN:NY.GDP.MKTP.CD,USA:NY.GDP.MKTP.CD
QUANT_ARXIV_QUERIES=cat:q-fin.ST
QUANT_GOOGLE_SCHOLAR_QUERIES=quantitative trading,market microstructure
QUANT_NEWS_JSON_URL=
QUANT_NEWS_RSS_URLS=
QUANT_NEWS_API_KEY=
QUANT_REFRESH_LIVE_SOURCES=true
QUANT_REFRESH_SOURCE_PAGE_SIZE=5
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

默认主行情源为东方财富 `push2` 直连，刷新失败会在 `reports/data/latest-refresh-report.json` 中记录并阻断今日数据闸门。只有显式设置 `QUANT_ALLOW_REPORT_FALLBACK=true` 或 `QUANT_DATA_PROVIDER=fallback` 时，系统才会读取仓库已有的 `reports/data/latest-free-a-share-scan.brief.json` 作为离线演示数据。

前端“刷新数据”和后台 `scripts/refresh_worker.mjs` 默认会用 `--live-sources` 生成研究报告，自动纳入新闻、公告、财务和资金流 Evidence。若需要完全离线刷新，可设置 `QUANT_REFRESH_LIVE_SOURCES=false`。

## 数据源

默认数据来源栈由 `QUANT_DATA_SOURCE_STACK` 描述：

1. `eastmoney_direct`：默认主数据，负责 A 股实时行情、日线、基础股票池。
2. `akshare`：可选主数据，负责 A 股实时行情、日线、基础股票池。
3. `tushare`：财务补充，负责利润表、财务指标、估值等；需要 `TUSHARE_TOKEN`。
4. `cninfo` / `juchao`：巨潮资讯公告检索和公告 PDF 链接。
5. `news`：实时新闻补充，读取授权 JSON API 或 RSS 源并转成 `news` Evidence。
6. `eastmoney_moneyflow`：东方财富资金流，负责主力净流入、大单/超大单分层。
7. `postgres`：结构化持久化，设置 `DATABASE_URL` 后选股落库自动从 SQLite 切换到 PostgreSQL。
8. `vector`：公告、研报、委员会证据的向量检索；默认按 `pgvector` 建模。

通过 `QUANT_DATA_PROVIDER` 切换策略主行情 provider：

- `eastmoney` / `eastmoney_direct`：默认 A 股实时行情与日线；AkShare 慢或不可用时不再依赖本地旧快照。
- `akshare`：可选 A 股行情与日线。
- `tushare`：Tushare Pro 股票基础、日线和财务快照；需要 `TUSHARE_TOKEN`。
- `eastmoney_moneyflow` / `moneyflow`：东方财富行情 + 资金流补充能力。
- `cninfo` / `juchao`：巨潮公告补充能力，通常不直接作为选股主行情。
- `news` / `configured_news`：配置式新闻源，读取 `QUANT_NEWS_JSON_URL` 或 `QUANT_NEWS_RSS_URLS`，研究层 `--live-sources` 时转成 Evidence。
- `fallback` / `report`：读取本地报告 JSON，适合离线演示。
- `yahoo` / `yahoo_finance`：读取 `QUANT_YAHOO_SYMBOLS` 中的 Yahoo Finance 标的，例如 `600519.SS`、`AAPL`。
- `binance`：读取 `QUANT_BINANCE_SYMBOLS` 中的现货交易对，例如 `BTCUSDT`。
- `world_bank` / `worldbank`：读取 `QUANT_WORLD_BANK_INDICATORS` 中的宏观指标，格式为 `COUNTRY:INDICATOR`。
- `arxiv`：读取 `QUANT_ARXIV_QUERIES` 研究论文流，适合补充策略研究线索。
- `ifind`、`ths` / `tonghuashun`、`tianyancha`：已预留凭证型接入口，需要对应账号、API Key 或本地授权 SDK 后再落具体客户端。
- `google_scholar` / `scholar`：已预留研究源入口；Google Scholar 没有稳定官方 API，建议后续通过合规第三方服务或人工检索结果入库。

当前趋势突破策略仍主要面向 A 股行情。`binance`、`world_bank`、`arxiv` 更适合作为扩展数据层或研究/风控辅助源，直接跑 `/api/stock-pool` 时可能因为策略条件不匹配而返回空结果。

配置式新闻源 JSON 支持数组，或包含 `items` / `news` / `data` 数组的对象。每条新闻建议包含：

```json
{
  "title": "新闻标题",
  "summary": "事实摘要",
  "published_at": "2026-06-27T09:30:00+08:00",
  "url": "https://example.com/news/1",
  "symbols": ["000001", "600519"],
  "source": "licensed-news-provider",
  "category": "company"
}
```

RSS 源从 `item.title`、`item.description`、`item.link`、`item.pubDate`、`item.category` 抽取字段；如果标题或摘要里包含研究标的代码，也会自动关联到 Evidence。

## Strategy KB / Agent 知识库

系统已内置 `quant-system/knowledge` 作为 AI 炒股 Agent 的策略知识层。它不是普通收藏夹，而是用于投委会、回测、风控和复盘的结构化知识库。

目录结构：

```text
knowledge/
├── Strategy-KB/   # 趋势、动量、龙头、多因子、AI、ETF 等策略
├── Factor-KB/     # Alpha158/Alpha360、价值、质量、成长、量价因子
├── Policy-KB/     # 政策、监管、交易制度、产业事件
├── Report-KB/     # 研报、财报、公告和行业框架
├── News-KB/       # 人工新闻、公司快讯、行业事件和影响路径
├── Case-KB/       # 每日交易计划、盘后复盘、失败案例
├── Risk-KB/       # 仓位、止损、数据质量、自动交易闸门
└── templates/     # 策略卡片模板
```

入库质量等级：

- `L0 raw`：原始资料或链接，只能收藏，不能被交易系统引用。
- `L1 note`：有摘要、关键词和来源，可被检索。
- `L2 normalized`：有统一字段、适用场景、参数和风险，可进入策略候选池。
- `L3 tested`：完成本系统回测，有样本数、收益、回撤、胜率。
- `L4 production-guarded`：绑定风控闸门和禁用条件，可进入自动交易预检。

推荐来源：

- GitHub：Qlib、FinRL、Backtrader、vn.py、各类 alpha strategy。
- 学术论文：arXiv、SSRN，用于因子、模型和组合优化。
- 量化平台：JoinQuant、BigQuant、RiceQuant，用于 A 股策略样例和参数。
- 技术指标：TA-Lib、TradingView，用于公式和脚本转换。
- 社区论坛：雪球、掘金量化、聚宽社区，只作为假设和案例来源。
- 经典书籍：用于方法论、风控和复盘框架。

工作台会自动扫描 `knowledge/` 下的 Markdown，展示知识库覆盖度。研究层会把 `Report-KB`、`Policy-KB`、`News-KB`、`Case-KB` 转成 Evidence；后续建议把 L3+ 条目接入投委会证据表，只允许 L4 条目进入自动交易预检。

当前执行链路已经读取知识库：模拟下单预检会返回 `kbReferences` 和 `kbWarnings`，自动交易预检会在 `knowledge.references` 中列出参考条目；如果知识库没有达到 `L2+`，自动执行会被阻塞。投委会风险官也会把 Strategy-KB / Risk-KB 参考写入角色报告。

### PostgreSQL / 向量库初始化

如果使用 PostgreSQL 和 pgvector：

```bash
psql "$DATABASE_URL" -f database/schema.sql
```

脚本落库时会优先读取 `DATABASE_URL`；未配置时继续写入 `quant-system/data/quant.db`，便于本地演示。

## API

- `GET /health`：健康检查
- `GET /api/data-sources`：查看 AkShare、Tushare、巨潮、东方财富资金流、PostgreSQL、向量库配置状态
- `GET /api/stock-pool?limit=30`：读取最近一次持久化股票池；加 `live=true` 时实时拉取行情并重新计算，实时源失败会降级返回持久化结果
- `GET /api/stocks/{code}/analysis`：读取最近一次持久化个股分析；加 `live=true` 时实时拉取行情并重新分析，实时源失败会降级返回持久化结果
- `GET /api/stocks/{code}/supplements`：获取 Tushare 财务、巨潮公告、东方财富资金流补充数据
- `GET /api/backtest?codes=000001,600519&hold_days=5`：基于本地报告和 K 线缓存做简易回测；加 `live=true` 时优先实时源，失败后降级到本地缓存
- `GET /api/committee/latest`：最近一次六角色投资委员会复核
- `GET /api/research/latest`：最近一次 AI 研究层报告，包含多 Agent 结论、证据索引、数据缺口和风险标记
- `GET /api/strategies`：策略注册表，包含内置策略、知识库策略、策略阶段、风控闸门和回测指标
- `GET /api/agent/v1/capabilities`：Agent Gateway 能力清单，默认 `PAPER_ONLY`
- `GET /api/agent/v1/research/latest`：供外部 Agent 读取的研究层报告
- `GET /api/agent/v1/strategies`：供外部 Agent 读取的策略注册表
- `POST /api/agent/v1/orders/preflight`：外部 Agent 下单预检，强制 dry-run，不产生真实成交
- `POST /api/jobs/run-daily`：手动触发每日任务

## 前端

```bash
cd quant-system/frontend
npm install
npm run dev
```

前端工作台会读取本地 `reports/data`、`quant-system/backend/data` 和 `quant-system/knowledge`。默认入口：

- `http://localhost:3000`
- 策略知识库面板在“知识库”区块，可查看六库覆盖度、来源计划和下一步入库任务。

## 公开部署

公开部署默认使用只读模式，适合作为外部可访问的行情/策略看板。

部署建议：

1. 在 Vercel 创建项目，Root Directory 选择 `quant-system/frontend`。
2. 环境变量设置：
   - `QUANT_PUBLIC_READONLY=true`
   - `QUANT_ENABLE_PUBLIC_WRITES=false`
   - `NEXT_PUBLIC_API_BASE=` 可留空，公开页面默认使用本地 Next API。
3. 部署前在本地刷新数据，然后提交或重新部署最新 `reports/data/*.json`。
4. 部署前必须验证：

```bash
cd quant-system/frontend
npm run verify:workbench
npm run build
```

公开模式行为：

- 页面和 `GET /api/workbench`、`GET /api/trading` 可访问。
- `POST /api/refresh-data` 禁止在线刷新，避免公网环境写文件或调用本机脚本。
- `POST /api/trading/orders` 禁止提交委托。
- `POST /api/autopilot` 禁止运行自动交易。
- `reports/data/kline-cache`、本地 `.env`、数据库文件不会随前端部署上传。

私有环境需要刷新或模拟交易时，在本机运行前端，并设置 `QUANT_PUBLIC_READONLY=false`。

## 风险提示

本项目只用于研究和模拟交易，不构成投资建议。第一阶段建议至少连续模拟 1-3 个月，再评估是否接入 QMT / PTrade。
