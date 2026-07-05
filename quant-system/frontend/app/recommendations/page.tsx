import { DataTable, MetricCard, ProductShell, StatusBadge } from "../product-shell";
import { dataDate, money, pct, productData } from "../../lib/product-data";

export const dynamic = "force-dynamic";

export default function RecommendationsPage() {
  const { workbench, dataDates } = productData();
  const recommendation = workbench.recommendation || {};
  const recommendedBuys = Array.isArray(recommendation.recommendedBuys) ? recommendation.recommendedBuys : [];
  const qualityRadar = Array.isArray(recommendation.qualityRadar) ? recommendation.qualityRadar : [];
  const watchPlan = Array.isArray(recommendation.watchPlan) ? recommendation.watchPlan : [];
  const performance = Array.isArray(recommendation.performance) ? recommendation.performance : [];
  const summary = recommendation.performanceSummary || {};
  const blockedReasons = Array.isArray(recommendation.reasons) ? recommendation.reasons : [];

  return (
    <ProductShell title="推荐股票" eyebrow="Buy candidates / Watch radar / Performance tracking" dataDate={dataDate(recommendation) === "-" ? dataDates.workbench : dataDate(recommendation)}>
      <section className="metricGrid">
        <MetricCard label="推荐买入" value={recommendedBuys.length} tone={recommendation.liveBuyAllowed ? "good" : "warn"} date={dataDates.workbench} />
        <MetricCard label="雷达候选" value={qualityRadar.length} date={dataDates.workbench} />
        <MetricCard label="执行闸门" value={recommendation.liveBuyAllowed ? "OPEN" : "BLOCK"} tone={recommendation.liveBuyAllowed ? "good" : "danger"} date={dataDates.workbench} />
        <MetricCard label="持有周期" value={recommendation.holdingPeriod || "-"} date={dataDates.workbench} />
        <MetricCard label="追踪样本" value={summary.total ?? performance.length} date={dataDates.workbench} />
      </section>

      <section className="productPanel">
        <h2>推荐买入池</h2>
        <DataTable
          columns={["日期", "代码", "名称", "动作", "级别", "评分", "现价", "涨跌幅", "买入区间", "止损", "目标", "仓位建议", "主线", "执行状态"]}
          rows={recommendedBuys.map((row: any) => [
            dataDate(row) === "-" ? dataDates.workbench : dataDate(row),
            <span className="mono">{row.code}</span>,
            row.name || "-",
            <StatusBadge tone={row.action === "TRADE" ? "success" : "warning"}>{row.action || "-"}</StatusBadge>,
            row.tier || row.risk_level || "-",
            row.score ?? "-",
            money(row.current_price ?? row.price),
            pct(row.pct_chg ?? row.pct),
            row.buy_zone || row.entry?.buyZone || "-",
            money(row.stop_loss ?? row.exit?.stop),
            money(row.target_price ?? row.exit?.target),
            row.position_hint || row.sizing?.hint || "-",
            row.primary_theme || row.theme || "-",
            row.execution_status || row.confirmation_status || "-",
          ])}
        />
      </section>

      <section className="productPanel">
        <h2>观察雷达</h2>
        <DataTable
          columns={["日期", "代码", "名称", "动作", "风险", "评分", "现价", "涨跌幅", "主线", "原因"]}
          rows={qualityRadar.map((row: any) => [
            dataDate(row) === "-" ? dataDates.workbench : dataDate(row),
            <span className="mono">{row.code}</span>,
            row.name || "-",
            <StatusBadge tone={row.action === "TRADE" ? "success" : "warning"}>{row.action || "WATCH"}</StatusBadge>,
            row.risk_level || row.riskLevel || "-",
            row.score ?? row.emotionScore ?? "-",
            money(row.current_price ?? row.price),
            pct(row.pct_chg ?? row.pct),
            row.primary_theme || row.theme || "-",
            (row.blockedReasons || row.reasons || []).slice(0, 2).join("；") || row.ai_comment || "-",
          ])}
        />
      </section>

      <section className="productPanel">
        <h2>收益追踪</h2>
        <DataTable
          columns={["日期", "代码", "名称", "来源", "动作", "入场价", "风险", "D1", "D3", "D5", "K线日期"]}
          rows={performance.map((row: any) => [
            dataDate(row) === "-" ? dataDates.workbench : dataDate(row),
            <span className="mono">{row.code}</span>,
            row.name || "-",
            row.bucket || "-",
            row.action || "-",
            money(row.entryPrice),
            row.riskLevel || "-",
            returnLabel(row.returns?.d1),
            returnLabel(row.returns?.d3),
            returnLabel(row.returns?.d5),
            row.klineLatestDate || "-",
          ])}
        />
      </section>

      <section className="productPanel">
        <h2>观察计划 / 闸门原因</h2>
        <DataTable
          columns={["日期", "类型", "内容", "状态"]}
          rows={[
            ...watchPlan.map((row: any) => [
              dataDate(row) === "-" ? dataDates.workbench : dataDate(row),
              row.type || "WATCH_PLAN",
              row.message || row.text || row.reason || JSON.stringify(row),
              row.status || "-",
            ]),
            ...blockedReasons.slice(0, 12).map((reason: any) => [
              dataDates.workbench,
              "GATE_REASON",
              String(reason),
              recommendation.liveBuyAllowed ? "INFO" : "BLOCK",
            ]),
          ]}
        />
      </section>
    </ProductShell>
  );
}

function returnLabel(row: any) {
  if (!row) return "-";
  if (row.status && row.status !== "READY") return row.status;
  return pct(row.returnPct);
}
