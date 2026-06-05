# A股每日自动选股系统

最小闭环：

1. 使用 AkShare 获取 A 股实时行情
2. 按趋势强势条件筛选股票池
3. 计算 `score`
4. 写入 SQLite `stock_pool` 表
5. 生成 Markdown 日报

## 目录

```text
a-quant-system/
├── main.py
├── requirements.txt
├── data/
│   └── stock_pool.db
├── reports/
│   └── daily/
├── quant/
│   ├── data_source.py
│   ├── strategy.py
│   ├── storage.py
│   └── report.py
└── README.md
```

## 运行

```bash
cd a-quant-system
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py --trade-date 2026-06-05
```

系统默认只使用 AkShare 真实行情。若 AkShare、网络或接口失败，本次运行会直接失败，不会写入数据库，也不会生成正式日报。

开发调试时可以显式读取本地报告数据：

```bash
python main.py --trade-date 2026-06-05 --allow-dev-data
```

带 `--allow-dev-data` 的结果只能用于调试页面和流程，不能作为策略样本或正式日报。

## 策略条件

- 排除 ST、退市、北交所
- 股价 > 5
- 涨幅 3% 到 7%
- 换手率 3% 到 20%
- 量比 > 1.5
- 总市值 50亿到800亿

## 打分

```python
score = pct_chg * 2 + volume_ratio * 5 + turnover * 0.5
```

## 数据库

SQLite 路径：

```text
data/stock_pool.db
```

表名：

```text
stock_pool
```

字段：

```text
trade_date, code, name, price, pct_chg, turnover,
volume_ratio, market_cap, score, created_at
```

## 日报

每次运行生成：

```text
reports/daily/YYYY-MM-DD.md
data/daily/stock_pool_YYYY-MM-DD.csv
```

运行日志写入：

```text
logs/daily.log
```

## 下一阶段

有 20-30 个交易日股票池后，再做历史回测：

- 当天选出股票
- 第二天开盘买入
- 持有 3 天
- 第 3 天收盘卖出
- 统计收益率、胜率、最大回撤

当前已经提供最小回测入口：

```bash
python backtest.py --trade-date 2026-06-05 --hold-days 3
```

回测逻辑：

- 读取 SQLite 中当天股票池
- 第二个交易日开盘买入
- 持有 `hold-days` 个交易日
- 最后一个持有日收盘卖出
- 输出平均收益、胜率、最大回撤和 Markdown 回测报告
