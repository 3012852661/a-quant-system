# 2026-07-01 策略失败复盘：放量突破

status: L2 normalized
type: strategy-failure-review
source: reports/data/strategy-quality-review.json; reports/data/parameter-backtest-result.json

## 背景

系统已将 TradingAgents-CN 风格的研究层输出接入 QuantDinger 风格的策略注册、回测、Paper Trading 和准入闸门。
本案例记录 `volume_breakout` 未通过 Paper 准入的原因，以及参数回测后的改进方向。

## 失败结论

- 策略：放量突破（volume_breakout）
- 闸门：PAPER_BLOCKED
- 阻塞原因：参数稳定性未通过：972 组参数中 0 组过闸；回测样本 58 笔，低于 Paper 准入 100 笔；最近一次数据刷新失败，禁止策略晋级；胜率 46.55%，低于 50%
- 下一步：先修复数据刷新失败再评估实盘候选；增加趋势过滤或降低追高买入；建立 1/3/5 日推荐后验样本；扩大历史样本或补齐更多候选标的 K 线；继续参数搜索，直到至少 1 组通过准入

## 参数回测摘要

- 参数组合数：972
- 通过准入数：0
- 最佳组合：volume_breakout.swing，score=58.59

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 6, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 6, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：58.59，passesGate：False
- 样本：44，胜率：59.09%，平均收益：5.49%，最大回撤：24.74%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 4, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 6, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：58.0，passesGate：False
- 样本：38，胜率：57.89%，平均收益：5.51%，最大回撤：25.16%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 6, 'slippage_bps': 15, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 6, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：57.77，passesGate：False
- 样本：44，胜率：59.09%，平均收益：5.4%，最大回撤：25.09%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 4, 'slippage_bps': 15, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 6, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：57.19，passesGate：False
- 样本：38，胜率：57.89%，平均收益：5.42%，最大回撤：25.5%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 4, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 4, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：55.84，passesGate：False
- 样本：38，胜率：55.26%，平均收益：5.06%，最大回撤：17.33%

## 复盘动作

- 若没有参数组合通过准入，保持 `PAPER_BLOCKED`，不得进入自动交易。
- 优先研究回撤来源：高波动个股、追高买点、市场环境退潮、持有期过长。
- 下一轮策略生成应加入大盘环境过滤、单票止损、组合止损和更严格流动性过滤。
- 该案例可被 Risk Officer 引用为放量突破策略的禁用证据。

## Agent 使用

- 研究 Agent 可以引用本案例解释策略失败原因。
- 执行 Agent 必须把本案例作为 `volume_breakout` 的阻塞证据，直到新参数通过准入。