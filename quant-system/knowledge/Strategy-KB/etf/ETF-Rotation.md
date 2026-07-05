# ETF 轮动策略

status: L2 normalized
market: A 股 ETF
horizon: 5-30 个交易日
source: JoinQuant、RiceQuant、Backtrader ETF rotation examples

## 逻辑

ETF 轮动通过相对强弱、趋势和波动过滤，在行业、宽基、主题 ETF 之间切换。它比个股策略更适合中低频和组合配置。

## 入场

- 备选 ETF 近 20/60 日动量进入前列。
- ETF 价格站上关键均线。
- 成交额充足，跟踪误差和折溢价可接受。

## 退出

- 动量排名跌出前列。
- 跌破趋势均线或 ATR 止损。
- 市场整体风险状态降级。

## 风控

- 单 ETF 仓位可以高于个股，但仍需总敞口控制。
- 主题 ETF 避免过度集中同一产业链。
- 极端行情下优先现金或低波资产。

## Agent 使用

ETF 轮动可作为低风险策略候选。自动交易仍需 L3 回测和 L4 风控闸门。
