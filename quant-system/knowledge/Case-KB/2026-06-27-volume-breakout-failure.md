# 2026-06-27 策略失败复盘：放量突破

status: L2 normalized
type: strategy-failure-review
source: reports/data/strategy-quality-review.json; reports/data/parameter-backtest-result.json

## 背景

系统已将 TradingAgents-CN 风格的研究层输出接入 QuantDinger 风格的策略注册、回测、Paper Trading 和准入闸门。
本案例记录 `volume_breakout` 未通过 Paper 准入的原因，以及参数回测后的改进方向。

## 失败结论

- 策略：放量突破（volume_breakout）
- 闸门：PAPER_BLOCKED
- 阻塞原因：胜率 46.78%，低于 50%；最大回撤 91.53%，超过 25%；单笔最差收益 -31.93%，低于 -12%
- 下一步：加入大盘环境过滤、单票止损和组合止损；增加趋势过滤或降低追高买入；收紧止损或过滤高波动标的

## 参数回测摘要

- 参数组合数：54
- 通过准入数：0
- 最佳组合：volume_breakout.swing，score=10.28

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 6, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8}

- score：10.28，passesGate：False
- 样本：343，胜率：49.56%，平均收益：1.25%，最大回撤：84.28%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 6, 'slippage_bps': 15, 'max_volume_pct': 0.01, 'limit_pct': 9.8}

- score：8.78，passesGate：False
- 样本：343，胜率：48.98%，平均收益：1.15%，最大回撤：86.24%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 4, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8}

- score：4.25，passesGate：False
- 样本：322，胜率：47.83%，平均收益：0.65%，最大回撤：86.75%

### 放量突破 - 波段版 / {'hold_days': 5, 'max_position_pct': 6, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8}

- score：3.36，passesGate：False
- 样本：563，胜率：47.25%，平均收益：0.6%，最大回撤：87.9%

### 放量突破 - 流动性版 / {'hold_days': 5, 'max_position_pct': 8, 'slippage_bps': 15, 'max_volume_pct': 0.01, 'limit_pct': 9.8}

- score：2.25，passesGate：False
- 样本：569，胜率：46.75%，平均收益：0.52%，最大回撤：89.1%

## 复盘动作

- 若没有参数组合通过准入，保持 `PAPER_BLOCKED`，不得进入自动交易。
- 优先研究回撤来源：高波动个股、追高买点、市场环境退潮、持有期过长。
- 下一轮策略生成应加入大盘环境过滤、单票止损、组合止损和更严格流动性过滤。
- 该案例可被 Risk Officer 引用为放量突破策略的禁用证据。

## Agent 使用

- 研究 Agent 可以引用本案例解释策略失败原因。
- 执行 Agent 必须把本案例作为 `volume_breakout` 的阻塞证据，直到新参数通过准入。