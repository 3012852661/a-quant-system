# Strategy-KB

策略库按交易逻辑分类，不按资料来源分类。来源只作为证据字段记录。

## 目录

- `trend/`：趋势突破、均线、MACD、SuperTrend、Donchian。
- `momentum/`：RSI、强弱排名、量价动量、行业动量。
- `leader/`：首板、二板、连板、龙头、情绪周期。
- `multi-factor/`：Alpha158、Alpha360、价值、质量、成长、低波。
- `ai/`：LightGBM、XGBoost、LSTM、Transformer、FinRL。
- `etf/`：ETF 轮动、网格、股债轮动。

## 使用原则

1. 每个策略必须写清楚适用市场和失效场景。
2. A 股短线策略必须显式处理涨跌停、T+1、停牌、流动性和滑点。
3. 社区经验只能生成假设，不能直接进入交易建议。
4. 策略入库后先回测，再进入投委会；自动交易只使用通过风控闸门的策略。
