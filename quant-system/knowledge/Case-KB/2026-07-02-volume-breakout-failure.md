# 2026-07-02 策略失败复盘：放量突破

status: L2 normalized
type: strategy-failure-review
source: reports/data/strategy-quality-review.json; reports/data/parameter-backtest-result.json

## 背景

系统已将 TradingAgents-CN 风格的研究层输出接入 QuantDinger 风格的策略注册、回测、Paper Trading 和准入闸门。
本案例记录 `volume_breakout` 未通过 Paper 准入的原因，以及参数回测后的改进方向。

## 失败结论

- 策略：放量突破（volume_breakout）
- 闸门：PAPER_BLOCKED
- 阻塞原因：参数稳定性未通过：972 组参数中 0 组过闸；回测样本 45 笔，低于 Paper 准入 100 笔；平均收益 -0.06%，未超过 0；最近一次数据刷新失败，禁止策略晋级；胜率 37.78%，低于 50%
- 下一步：优化买点、卖点和持有期；先修复数据刷新失败再评估实盘候选；增加趋势过滤或降低追高买入；建立 1/3/5 日推荐后验样本；扩大历史样本或补齐更多候选标的 K 线；继续参数搜索，直到至少 1 组通过准入

## 参数回测摘要

- 参数组合数：972
- 通过准入数：0
- 最佳组合：volume_breakout.swing，score=17.46

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 4, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 4, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：17.46，passesGate：False
- 样本：29，胜率：44.83%，平均收益：0.84%，最大回撤：20.0%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 4, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 4, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 45}

- score：17.46，passesGate：False
- 样本：29，胜率：44.83%，平均收益：0.84%，最大回撤：20.0%

### 放量突破 - 防守版 / {'hold_days': 2, 'max_position_pct': 8, 'slippage_bps': 10, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 4, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：16.97，passesGate：False
- 样本：49，胜率：46.94%，平均收益：0.38%，最大回撤：13.06%

### 放量突破 - 防守版 / {'hold_days': 2, 'max_position_pct': 8, 'slippage_bps': 10, 'max_volume_pct': 0.02, 'limit_pct': 9.8, 'stop_loss_pct': 4, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：16.97，passesGate：False
- 样本：49，胜率：46.94%，平均收益：0.38%，最大回撤：13.06%

### 放量突破 - 波段版 / {'hold_days': 8, 'max_position_pct': 4, 'slippage_bps': 15, 'max_volume_pct': 0.01, 'limit_pct': 9.8, 'stop_loss_pct': 4, 'min_volume_ratio': 1.5, 'max_twenty_day_pct': 30}

- score：16.79，passesGate：False
- 样本：29，胜率：44.83%，平均收益：0.77%，最大回撤：20.38%

## 复盘动作

- 若没有参数组合通过准入，保持 `PAPER_BLOCKED`，不得进入自动交易。
- 优先研究回撤来源：高波动个股、追高买点、市场环境退潮、持有期过长。
- 下一轮策略生成应加入大盘环境过滤、单票止损、组合止损和更严格流动性过滤。
- 该案例可被 Risk Officer 引用为放量突破策略的禁用证据。

## Agent 使用

- 研究 Agent 可以引用本案例解释策略失败原因。
- 执行 Agent 必须把本案例作为 `volume_breakout` 的阻塞证据，直到新参数通过准入。