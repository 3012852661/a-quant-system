# 量价背离因子

status: L1 candidate
market: A 股短线
category: price-volume

## 公式

`pv_divergence_5_20 = rank(close.pct_change(5)) / (rank(volume_ma5 / volume_ma20) + 1e-5)`

解释：5日涨幅排名高，但5日均量相对20日均量排名低，代表价强但量能确认不足。该因子的交易方向必须以本地 IC 检验结果为准；如果历史 Rank IC 为负，系统会自动反向使用。

## 清洗

- 按交易日做 MAD 去极值。
- 用最新股票池可得的行业和市值做截面中性化。
- 按交易日转为 Z-score，方便与其他因子融合。

## 检验

使用 `backend/run_factor_lab.py` 计算：

- Rank IC / IR。
- 五分位分层收益。
- 最新截面因子分。

因子进入选股评分前必须至少满足观察样本充足；系统默认研究闸门为 `abs(IC)>=0.03, abs(IR)>=0.2, observations>=20`。未通过闸门的因子只能作为观察，不作为交易理由。

