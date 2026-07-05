# TradingAgents-CN + QuantDinger 融合路线

本文档把系统演进拆成三层：先用 TradingAgents-CN 的多 Agent 研究范式打通 AI 研究层，再吸收 QuantDinger 的策略、回测、模拟交易和执行抽象，最后沉淀成本仓库自己的统一交易研究平台。

参考上游：

- TradingAgents-CN: https://github.com/hsliuping/TradingAgents-CN
- QuantDinger: https://github.com/brokermr810/QuantDinger

## 总体原则

1. 研究层和执行层分离：Agent 可以给结论、证据、风险和策略假设，但不能直接绕过风控下单。
2. 数据先可追溯再智能化：所有行情、新闻、公告、研报、策略结论都必须带来源、时间、置信度和数据缺口。
3. 默认 Paper Trading：实盘接口只作为受控适配器存在，未通过回测、模拟和风控闸门的策略不得进入实盘。
4. 上游能力做映射，不直接耦合：保留本仓库现有 `backend`、`frontend`、`knowledge`、`reports/data` 结构，按接口吸收两套系统的思想和组件。

## 第一阶段：AI 研究层

目标：以 TradingAgents-CN 的多 Agent 分析链为核心，把 A 股数据、新闻、公告、研报、策略报告和知识库证据跑通，形成稳定的研究报告生产线。

### 需要落地的模块

- `backend/research/`
  - 统一研究任务编排，输入股票代码、行业、主题或自选列表。
  - 管理 Agent 运行上下文、证据包、角色报告和最终策略报告。
- `backend/research/agents.py`
  - 研究员：只聚合事实。
  - 基本面分析师：财务、估值、经营质量。
  - 技术分析师：K 线、均线、量价、支撑压力。
  - 新闻舆情分析师：新闻、公告、社交热度、研报摘要。
  - 政策分析师：监管、产业政策、交易制度影响。
  - 风险官：数据质量、事件风险、否决项、仓位闸门。
  - 投资经理：只读取前序报告，输出可执行但不可直接下单的研究结论。
- `backend/research/evidence.py`
  - 将行情、公告、研报、新闻、知识库条目统一成 Evidence 对象。
  - 字段包括 `source`、`source_url`、`published_at`、`collected_at`、`confidence`、`symbols`、`summary`。
- `backend/research/report.py`
  - 生成 JSON 和 Markdown 两种报告。
  - 报告必须包含数据缺口、相反证据、风险否决项和可复核引用。
- `knowledge/`
  - 继续使用现有 Strategy、Factor、Policy、Report、Case、Risk 六库。
  - L2+ 条目可进入投委会证据；L3+ 条目可进入策略候选；L4 条目才允许被执行层引用。

### 当前仓库已有基础

- `backend/committee/roles.py` 已有六角色投资委员会雏形。
- `backend/data/providers.py` 已有 A 股、Tushare、巨潮、东方财富资金流、扩展数据源适配。
- `knowledge/` 已有六层知识库目录和策略卡片。
- `reports/data/latest-investment-committee.json` 和 Markdown 报告已形成研究层输出样式。

### 第一阶段验收标准

- 对单只股票和自选列表都能生成完整研究报告。
- 每个结论至少能追溯到行情、公告、研报、新闻或知识库证据之一。
- 没有新闻、研报或财务数据时，报告明确标记数据缺口，而不是把缺失当作利好。
- 投资经理不能访问新数据，只能基于前序 Agent 报告给出结论。
- 输出固定为：
  - `reports/data/latest-research-report.json`
  - `reports/data/latest-research-report.md`
  - `reports/data/research-evidence/*.json`

## 第二阶段：交易执行层

目标：引入 QuantDinger 的策略生成、历史回测、Paper Trading、执行适配和审计思想，形成从研究结论到交易模拟的闭环。

### 需要落地的模块

- `backend/strategy/registry.py`
  - 策略注册表，统一管理趋势突破、打板接力、ETF 轮动、多因子、AI 选股等策略。
  - 每个策略必须声明适用市场、参数、所需数据、风险等级和禁用条件。
- `backend/backtest/engine.py`
  - 事件驱动回测入口，支持交易日历、手续费、滑点、涨跌停、T+1、停牌、仓位约束。
  - 保留当前 `simple_backtest.py` 作为轻量快速验证。
- `backend/execution/`
  - `paper.py`：模拟账户、订单、成交、持仓、资金曲线。
  - `broker.py`：实盘接口抽象，不直接绑定具体券商。
  - `audit.py`：记录每次策略信号、风控预检、下单请求、成交回报。
  - 默认实盘 broker 为 `DisabledLiveBroker`，只返回阻断结果；后续接 QMT/PTrade 时必须显式替换 adapter。
- `backend/risk/`
  - 扩展为执行前、执行中、盘后复盘三类风控。
  - 实盘接口必须读取研究层置信度、策略 L 级、回测结果和账户风险状态。
- `backend/agent_gateway.py`
  - 对齐 QuantDinger 的 Agent Gateway 思路，为外部 Agent 暴露稳定 API。
  - 默认 `PAPER_ONLY`，读接口开放研究、策略、工作台；写接口只允许订单预检。
  - 每次调用写入审计日志，后续接入 Paper Trading 和 broker adapter 时复用同一条审计链。

### 第二阶段验收标准

- 任一策略都能走通 `生成信号 -> 回测 -> Paper Trading -> 审计日志`。
- Paper Trading 和实盘接口共用同一套订单模型，实盘只替换 broker adapter。
- 没有 L3 回测记录或 L4 风控卡片的策略，只允许研究展示，不允许自动执行。
- Agent Gateway 默认不能实盘下单，只能读取研究/策略结果和提交 dry-run 预检。
- 所有买入请求必须经过：
  - 数据新鲜度检查
  - A 股交易规则检查
  - 价格偏离检查
  - 单票和总仓位检查
  - 事件风险和知识库禁用条件检查

## 第三阶段：统一平台

目标：把研究层和执行层融合成产品化工作台，形成 `分析 -> 策略 -> 回测 -> 模拟 -> 实盘 -> 复盘` 的完整闭环。

### 产品模块

- 分析中心：个股、行业、主题、自选列表研究报告。
- 策略中心：策略库、参数、适用场景、历史表现、禁用条件。
- 回测中心：批量回测、样本分层、收益回撤、交易明细。
- 模拟交易：Paper 账户、订单流、持仓、资金曲线。
- 实盘控制台：只在本地私有环境启用，默认关闭。
- 复盘中心：日报、失败案例、策略漂移、持仓归因。
- 知识库：政策、研报、案例、风险规则持续沉淀。
- 监控模块：政策监控、自选股监控、数据健康、异常提醒、日报生成。

### 统一数据契约

核心对象建议固定为：

- `Evidence`：事实证据。
- `ResearchReport`：多 Agent 研究报告。
- `StrategySpec`：策略定义。
- `Signal`：策略信号。
- `BacktestRun`：回测结果。
- `OrderIntent`：拟委托请求。
- `RiskDecision`：风控结论。
- `ExecutionReport`：订单和成交回报。
- `ReviewRecord`：盘后复盘记录。

### 路线图

| 阶段 | 里程碑 | 产物 | 优先级 |
| --- | --- | --- | --- |
| P1 | 研究任务编排 | `backend/research`、研究报告 JSON/MD | P0 |
| P1 | 证据对象统一 | Evidence schema、证据缓存 | P0 |
| P1 | 新闻/公告/研报补充 | 来源适配、缺口标记 | P1 |
| P2 | 策略注册表 | StrategySpec、策略元数据 | P0 |
| P2 | 回测引擎升级 | 交易成本、涨跌停、T+1 | P0 |
| P2 | Paper Trading 审计 | 订单模型、成交、审计日志 | P0 |
| P2 | Broker 抽象 | `broker.py` 接口，默认禁用实盘 | P1 |
| P3 | 统一工作台 | 分析、策略、回测、模拟、复盘视图 | P0 |
| P3 | 日报和监控 | 政策、自选、数据健康、日报 | P1 |
| P3 | 生产风控 | L4 策略闸门、实盘二次确认 | P0 |

## 下一步执行顺序

1. 在现有 `backend/committee` 外新增 `backend/research`，不要破坏当前投委会脚本。
2. 先定义 Evidence 和 ResearchReport 数据结构，再迁移角色报告输出。
3. 把 `run_committee.py` 改造成研究层 CLI 的一个入口，继续保留旧命令兼容。
4. 在前端工作台增加“研究报告”数据面板，先读取本地 JSON，不急着做在线长任务。
5. 第二阶段开始前，补 StrategySpec 和 BacktestRun schema，避免策略、回测、执行三套对象互相转换。

## 风险边界

- 本系统只能用于研究和模拟交易；实盘前必须独立验证数据源、券商接口、风控和合规要求。
- 多 Agent 输出不是事实本身，必须附带证据来源和数据缺口。
- 新闻、研报和社交舆情可能有延迟、错误或选择性偏差，不能作为唯一买入依据。
- 自动交易默认关闭；任何实盘能力必须显式启用，并保留人工确认和审计日志。
