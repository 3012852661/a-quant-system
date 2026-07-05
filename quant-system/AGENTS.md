# quant-system Agent 指令

本文件约束 `quant-system/` 内的 A 股量化选股、复盘、研究、前端和报告工作。处理本系统相关问题时，先按这里的规则执行，不要让用户重复解释偏好。

## 用户偏好与分析框架

用户的股票池默认是经过人工筛选的优质强势池，不要按普通低估值/低风险多因子框架先否定。

分析股票池和次日买点时，优先级固定为：

1. 政策方向：半导体、先进封装、PCB、通信算力、AI 硬件、新型显示、机器人、汽车链、电网新能源、国产替代等政策和产业主线优先。
2. 热门主线：先看今日主题宽度、涨停/近涨停数量、强势股数量、辨识度龙头和板块共振。
3. 资金强度：看涨幅、换手、量比、成交额、主力资金流、封板质量、炸板回封、次日竞价和承接。
4. 标的地位：区分核心龙头、容量中军、弹性标的、补涨跟风、杂题材。
5. 财务估值：只作为兑现验证和风险控制，不要用高 PE/PB 直接否定强主题票。
6. 交易执行：最后给买区、止损、目标、仓位和“不买条件”。
7. 开盘确认：必须输出竞价/开盘30分钟确认清单，明确什么盘口可以买、什么盘口放弃。

结论必须回答“明天买什么/不买什么/怎么买”，而不是只做静态公司分析。

## 默认工作流

当用户说“分析股票池”“明天买啥”“复盘今天候选”时：

1. 读取最新股票池：
   - `data/stock_pool_YYYY-MM-DD.csv`
   - 优先使用日期最新的文件。
2. 读取用户自选和复盘：
   - `../reports/data/user-watchlist.json`
   - `../reports/data/latest-user-watchlist-review.json`
   - `../reports/data/latest-open-limit-watch.json`
   - `../reports/data/latest-quant-recommendation.json`
   - `../reports/data/latest-trading-signals.json`
3. 先做主题排序，再做个股排序。
4. 对涨停或近涨停标的，不默认推荐追高；作为情绪锚和次日承接观察。
5. 对可买标的，只推荐回踩承接买区，不建议无条件开盘追价。
6. 使用系统输出中的 `openingConfirmation` 字段作为交易执行依据；没有确认信号时只观察。

如果实时行情源失败，优先使用本地当天输出；但必须说明该结论基于本地最新数据，不要伪装成已刷新实时数据。

## 明天买点输出格式

给用户的最终建议要短、明确、可执行。推荐格式：

```text
首选：代码 名称
备选：代码 名称、代码 名称
观察不追：代码 名称、代码 名称

买入条件：
- 只在 xx-xx 回踩承接买
- 高开超过 x% 不追
- 跌破 xx 放弃

止损：xx
目标：xx
仓位：单票不超过计划资金的 x%
```

必须给“不买条件”，例如：

- 主线开盘 30 分钟放量下杀。
- 前排龙头炸板后不能回封。
- 候选股高开冲高但成交量异常放大、价格不创新高。
- 跌破买区下沿后不能快速收回。

若系统输出包含 `openingConfirmation`，回答用户时必须优先引用：

- `status`：确认状态，例如 `THEME_OPEN_CONFIRM`。
- `checklist`：竞价和开盘30分钟确认项。
- `noBuyConditions`：明确放弃条件。

## 主线权重

默认强主题权重：

- 半导体/PCB/通信算力：最高优先级。包含先进封装、HBM、玻璃基板、CPO、AI 服务器、PCB、存储、国产芯片。
- 机器人/汽车链：第二优先级。包含机器人执行器、热管理、智能驾驶、汽车零部件、低空/机械传动相关扩散。
- 新型显示/消费电子：与半导体主线共振时提高优先级。京东方、TCL 等大容量票更多作为风向标和中军。
- 电力/新能源/电网：只有出现涨停宽度或政策催化时升权。
- 有色/小金属：配合半导体材料、军工材料或资源涨价时升权。
- ST/困境反转、房地产、杂题材：除非用户明确要求，否则不作为首选买入方向。

## 风险框架

风险控制要服务交易，不要替代选股逻辑。

- 高估值不是直接否决项；高位放量滞涨、封板失败、题材退潮才是短线否决项。
- 对强主题票，重点检查次日承接、分时均线、板块前排、成交额是否继续放大。
- 对 `THEME_DISAGREEMENT_BUY` 只做分歧承接，不做开盘追涨；必须等待 `openingConfirmation.checklist` 至少满足前两项。
- A 股普通股票遵守 T+1；当天买入不能当天卖出。
- 不建议一次买满。优先 1-2 只核心标的，避免把整个股票池买散。
- 明确仓位：普通强势票单票不超过计划资金 10%，高风险弹性票不超过 3%-5%。

## 系统文件与命令

常用输出：

- `data/stock_pool_YYYY-MM-DD.csv`：每日股票池。
- `backend/data/stock_pool_latest.json`：最新股票池 JSON。
- `../reports/data/latest-quant-recommendation.json`：短线推荐。
- `../reports/data/latest-theme-frontline.json`：主题前排监控，给每条主线标记 `ATTACK/ACTIVE/WATCH/COOLING` 和交易闸门。
- `../reports/data/latest-opening-confirmation.json`：开盘确认监控，判断候选是否进入买区、是否冲高回落、是否触发不买条件。
- `../reports/data/latest-user-watchlist-review.json`：用户自选主题宽度和强度复盘。
- `../reports/data/latest-investment-committee.md`：六角色复核，偏保守，只作为风控参考。
- `../reports/data/kline-cache/*.daily.json`：本地 K 线缓存。

常用命令：

```bash
.venv/bin/python backend/run_selection.py --trade-date YYYY-MM-DD --live-provider --scan-limit 500 --limit 30
.venv/bin/python backend/run_backtest.py --trade-date YYYY-MM-DD --hold-days 3
.venv/bin/python backend/run_committee.py
node scripts/user_watchlist_review.mjs
node scripts/theme_frontline_monitor.mjs
node scripts/opening_confirmation.mjs
```

如果需要联网刷新行情、新闻、公告或资金流，遇到网络/沙箱失败后按 Codex 权限规则请求放行。不要用旧数据冒充实时数据。

## 开发约定

- 保持改动小而直接，优先沿用现有 `backend/`、`scripts/`、`reports/data/` 的数据契约。
- 手工编辑文件使用 `apply_patch`。
- 不要删除用户已有数据、股票池、报告和 K 线缓存。
- 对策略逻辑改动后，至少运行相关脚本验证输出能生成。
- 前端改动位于 `frontend/`，遵循现有 Next.js 结构；数据优先从 `reports/data/` 或 API 路由读取。

## 回答风格

用户要的是交易决策辅助，不是教科书式研究报告。

- 先给结论，再给理由。
- 说清楚买什么、为什么、怎么买、什么情况不买。
- 少讲泛泛估值，多讲政策主线、热门题材、资金承接和次日执行。
- 明确区分“可买”“观察不追”“放弃”。
- 不承诺收益，不使用确定性荐股措辞。
