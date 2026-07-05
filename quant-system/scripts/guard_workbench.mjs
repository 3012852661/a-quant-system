import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(quantRoot, "..");

function readJson(relativePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
  } catch (error) {
    failures.push(`${relativePath} 读取失败：${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

function rowCode(row) {
  return String(row.code || "").padStart(6, "0");
}

function rowName(row) {
  return String(row.name || "");
}

function rowPct(row) {
  return Number(row.pct_chg ?? row.pct ?? 0);
}

function limitUpThreshold(row) {
  const code = rowCode(row);
  if (rowName(row).toUpperCase().includes("ST")) return 5;
  if (code.startsWith("83") || code.startsWith("87") || code.startsWith("88") || code.startsWith("92")) return 30;
  if (code.startsWith("30") || code.startsWith("68")) return 20;
  return 10;
}

function isExecutionBlocked(row) {
  const status = String(row.execution_status || row.execution?.status || "").toUpperCase();
  if (status) return status === "BLOCKED_LIMIT_UP";
  return rowPct(row) >= limitUpThreshold(row) - 0.08;
}

function isPrimaryTradeCandidate(row) {
  const action = String(row.action || "").toUpperCase();
  const recommendationType = String(row.recommendation_type || row.recommendationType || "").toUpperCase();
  return action === "TRADE" && recommendationType !== "LIMIT_REVIEW" && !isExecutionBlocked(row);
}

function describe(row) {
  return `${rowCode(row)} ${rowName(row)} action=${row.action || "-"} type=${row.recommendation_type || row.recommendationType || "-"} pct=${rowPct(row)}`;
}

const failures = [];
const recommendation = readJson("reports/data/latest-quant-recommendation.json");
const signals = readJson("reports/data/latest-trading-signals.json");
const refreshReport = readJson("reports/data/latest-refresh-report.json");

const recommendedBuys = Array.isArray(recommendation.recommendedBuys) ? recommendation.recommendedBuys : [];
const tradeRows = Array.isArray(signals.trade) ? signals.trade : [];
const invalidRecommended = recommendedBuys.filter((row) => !isPrimaryTradeCandidate(row));
const invalidTradeRows = tradeRows.filter((row) => !isPrimaryTradeCandidate(row));

if (invalidRecommended.length) {
  failures.push(`recommendedBuys 存在不合规候选：${invalidRecommended.slice(0, 8).map(describe).join("；")}`);
}
if (invalidTradeRows.length) {
  failures.push(`signals.trade 存在不合规候选：${invalidTradeRows.slice(0, 8).map(describe).join("；")}`);
}
if (refreshReport.status === "RUNNING") {
  failures.push("刷新任务仍为 RUNNING，页面只能展示稳定快照，不能发布新结果");
}

if (failures.length) {
  console.error(["workbench guard failed", ...failures.map((item) => `- ${item}`)].join("\n"));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      recommendedBuys: recommendedBuys.length,
      tradeRows: tradeRows.length,
      refreshStatus: refreshReport.status || "UNKNOWN",
    },
    null,
    2,
  ),
);
