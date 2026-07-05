import fs from "node:fs";
import path from "node:path";
import { getTradingState, getWorkbenchSnapshot } from "./local-data";

const repoRoot = path.resolve(process.cwd(), "../..");
const deployDataRoot = path.join(process.cwd(), "deploy-data");

function dataPath(relativePath: string) {
  const deployPath = path.join(deployDataRoot, relativePath);
  if (fs.existsSync(deployPath)) return deployPath;
  return path.join(repoRoot, relativePath);
}

export function readProductJson<T>(relativePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(dataPath(relativePath), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function readProductText(relativePath: string) {
  try {
    return fs.readFileSync(dataPath(relativePath), "utf8");
  } catch {
    return "";
  }
}

export function readProductJsonl(relativePath: string, limit = 80) {
  try {
    return fs
      .readFileSync(dataPath(relativePath), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function walkMarkdown(relativePath: string): string[] {
  const root = dataPath(relativePath);
  const rows: string[] = [];
  function visit(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) rows.push(path.relative(root === path.join(deployDataRoot, relativePath) ? deployDataRoot : repoRoot, full));
    }
  }
  visit(root);
  return rows.sort();
}

export function productData() {
  const workbench = getWorkbenchSnapshot();
  const research = readProductJson<Record<string, any>>("reports/data/latest-research-report.json", {});
  const strategies = readProductJson<Record<string, any>>("reports/data/strategy-registry.json", {});
  const strategyReview = readProductJson<Record<string, any>>("reports/data/strategy-quality-review.json", {});
  const parameterBacktest = readProductJson<Record<string, any>>("reports/data/parameter-backtest-result.json", {});
  const eventBacktest = readProductJson<Record<string, any>>("reports/data/event-backtest-result.json", {});
  const trading = getTradingState();
  return {
    workbench,
    research,
    strategies,
    strategyReview,
    parameterBacktest,
    eventBacktest,
    trading,
    agentAudit: readProductJsonl("reports/data/agent-gateway-audit.jsonl", 80),
    executionAudit: readProductJsonl("reports/data/execution-audit.jsonl", 80),
    cases: walkMarkdown("quant-system/knowledge/Case-KB").map((file) => ({
      file,
      text: readProductText(file),
    })),
    knowledgeDocs: walkMarkdown("quant-system/knowledge").filter((file) => !file.includes("/templates/")),
    dataDates: {
      workbench: dataDate(workbench),
      research: dataDate(research),
      strategies: dataDate(strategies),
      strategyReview: dataDate(strategyReview),
      parameterBacktest: dataDate(parameterBacktest),
      eventBacktest: dataDate(eventBacktest),
      trading: dataDate(trading),
    },
  };
}

export function dataDate(row: Record<string, any> | null | undefined) {
  if (!row) return "-";
  const value =
    row.dataTime ||
    row.asOf ||
    row.dataDate ||
    row.tradeDate ||
    row.trade_date ||
    row.date ||
    row.generatedAt ||
    row.updatedAt ||
    row.requestTime ||
    row.runAt ||
    row.createdAt ||
    row.time ||
    row.collected_at ||
    row.published_at ||
    row.buy_date ||
    row.sell_date ||
    row.latestDate ||
    row.quoteTime ||
    row.todayTime;
  return formatDate(value);
}

export function formatDate(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (compact) {
    return [compact[1], compact[2], compact[3]].join("-") + (compact[4] ? ` ${compact[4]}:${compact[5] || "00"}` : "");
  }
  const isoDate = text.match(/\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?/);
  if (isoDate) return isoDate[0].replace("T", " ");
  return text;
}

export function pct(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "-";
}

export function num(value: unknown, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

export function money(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) : "-";
}
