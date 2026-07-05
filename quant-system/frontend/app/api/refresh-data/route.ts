import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../lib/access-control";
import { getWorkbenchSnapshot, isPublicReadOnly } from "../../../lib/local-data";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd(), "../..");
const quantRoot = path.join(repoRoot, "quant-system");
const refreshReportPath = path.join(repoRoot, "reports/data/latest-refresh-report.json");

function shanghaiTradeDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export const dynamic = "force-dynamic";

async function runPython(scriptName: string, args: string[], timeout: number) {
  const python311Path = path.join(quantRoot, ".venv311/bin/python");
  const pythonPath = await fs
    .access(python311Path)
    .then(() => python311Path)
    .catch(() => path.join(quantRoot, ".venv/bin/python"));
  const scriptPath = path.join(quantRoot, "backend", scriptName);
  const result = await execFileAsync(pythonPath, [scriptPath, ...args], {
    cwd: quantRoot,
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  return {
    script: scriptName,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runNodeScript(scriptName: string, timeout: number) {
  const result = await execFileAsync(process.execPath, [path.join(quantRoot, "scripts", scriptName)], {
    cwd: quantRoot,
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  return {
    script: scriptName,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function atomicWriteText(filePath: string, text: string) {
  if (isPublicReadOnly()) throw new Error("公开部署为只读模式，禁止写入刷新结果");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, text, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function atomicWriteJson(filePath: string, payload: unknown) {
  await atomicWriteText(filePath, JSON.stringify(payload, null, 2));
}

function eastMoneyUrl(page: number) {
  const fsFilter = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
  const fields = "f12,f14,f2,f3,f5,f6,f8,f10,f20,f21,f62,f100";
  return `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fsFilter}&fields=${fields}`;
}

async function fetchEastMoneyRows(scanLimit: number) {
  const rows: Array<Record<string, unknown>> = [];
  const pages = Math.max(1, Math.ceil(scanLimit / 100));
  for (let page = 1; page <= pages; page += 1) {
    let result;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await execFileAsync(
          "curl",
          ["-sS", "-A", "Mozilla/5.0", "-e", "https://quote.eastmoney.com/", eastMoneyUrl(page)],
          { cwd: quantRoot, timeout: 30000, maxBuffer: 1024 * 1024 * 8 },
        );
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!result) throw lastError instanceof Error ? lastError : new Error("东方财富实时 curl 请求失败");
    const payload = JSON.parse(result.stdout || "{}");
    const diff = payload?.data?.diff;
    if (!Array.isArray(diff) || diff.length === 0) {
      if (page === 1) throw new Error("东方财富实时接口没有返回行情行");
      break;
    }
    for (const row of diff) {
      rows.push({
        code: String(row.f12 || "").padStart(6, "0"),
        name: row.f14 || "",
        price: Number(row.f2 || 0),
        pct: Number(row.f3 || 0),
        volume: Number(row.f5 || 0),
        amount: Number(row.f6 || 0),
        turnover: Number(row.f8 || 0),
        volumeRatio: Number(row.f10 || 0),
        marketCap: Number(row.f20 || 0),
        mainNet: Number(row.f62 || 0),
        industry: row.f100 || "",
      });
      if (rows.length >= scanLimit) break;
    }
    if (rows.length >= scanLimit) break;
  }
  if (!rows.length) throw new Error("东方财富实时接口没有可用行情");
  const inputPath = path.join(os.tmpdir(), `eastmoney-live-${Date.now()}.json`);
  await atomicWriteJson(inputPath, rows);
  return inputPath;
}

function marketPrefix(code: string) {
  return code.startsWith("6") || code.startsWith("9") ? "sh" : "sz";
}

function parseTencentRows(text: string, nameByCode = new Map<string, string>()) {
  return text
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const value = item.split("=", 2)[1]?.replace(/^"|"$/g, "") || "";
      const parts = value.split("~");
      const code = String(parts[2] || "").padStart(6, "0");
      return {
        code,
        name: nameByCode.get(code) || parts[1] || "",
        price: Number(parts[3] || 0),
        pct: Number(parts[32] || 0),
        change: Number(parts[31] || 0),
        turnover: Number(parts[38] || 0),
        amountYi: Number(parts[37] || 0) / 10000,
        totalMvYi: Number(parts[45] || 0),
        floatMvYi: Number(parts[44] || 0),
        volumeRatio: Number(parts[49] || 0),
        time: parts[30] || "",
      };
    })
    .filter((row) => row.code && row.price > 0 && row.time);
}

async function fetchTencentRows(candidates: Array<{ code: string; name: string }>) {
  if (!candidates.length) return [];
  const query = candidates.map((item) => `${marketPrefix(item.code)}${item.code}`).join(",");
  const outputPath = path.join(os.tmpdir(), `tencent-live-${Date.now()}.txt`);
  await execFileAsync("curl", ["-sS", "-o", outputPath, `https://qt.gtimg.cn/q=${query}`], {
    cwd: quantRoot,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const text = new TextDecoder("gbk").decode(await fs.readFile(outputPath));
  const nameByCode = new Map(candidates.map((item) => [item.code, item.name]));
  return parseTencentRows(text, nameByCode);
}

async function fetchTencentCandidateQuotes() {
  const poolPath = path.join(repoRoot, "quant-system/backend/data/stock_pool_latest.json");
  const pool = JSON.parse(await fs.readFile(poolPath, "utf8"));
  const signals = Array.isArray(pool.signals) ? pool.signals : [];
  const candidates = signals.slice(0, 60).map((item: Record<string, unknown>) => ({
    code: String(item.code || "").padStart(6, "0"),
    name: String(item.name || ""),
  }));
  if (!candidates.length) throw new Error("没有可用于腾讯实时刷新的候选池");

  const rows = await fetchTencentRows(candidates);
  if (!rows.length) throw new Error("腾讯实时接口没有返回有效候选行情");
  const generatedAt = new Date().toISOString();
  const reportPath = path.join(repoRoot, "reports/data/live-tencent-candidate-quotes.json");
  await atomicWriteJson(
    reportPath,
    { source: "Tencent qt.gtimg.cn", generatedAt, rows },
  );
  return { rows: rows.length, latestTime: rows.map((row) => row.time).sort().at(-1) };
}

function tencentTradeDate(value?: string) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function shanghaiMinutesNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((memo, part) => {
      memo[part.type] = part.value;
      return memo;
    }, {});
  return Number(parts.hour || 0) * 60 + Number(parts.minute || 0);
}

function daysBetween(fromDate: string, toDate: string) {
  const from = Date.parse(`${fromDate}T00:00:00+08:00`);
  const to = Date.parse(`${toDate}T00:00:00+08:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY;
  return Math.floor((to - from) / 86400000);
}

function liveQuoteDateAcceptable(latestTickDate: string, tradeDate: string) {
  if (!latestTickDate) return false;
  if (latestTickDate >= tradeDate) return true;
  const preOpen = shanghaiMinutesNow() < 9 * 60 + 30;
  return preOpen && daysBetween(latestTickDate, tradeDate) <= 3;
}

async function readJson(relativePath: string, fallback: Record<string, any> = {}) {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
  } catch {
    return fallback;
  }
}

function rowCode(row: Record<string, any>) {
  return String(row.code || "").padStart(6, "0");
}

function rowName(row: Record<string, any>) {
  return String(row.name || "");
}

function rowPct(row: Record<string, any>) {
  return Number(row.pct_chg ?? row.pct ?? 0);
}

function limitUpThreshold(row: Record<string, any>) {
  const code = rowCode(row);
  if (rowName(row).toUpperCase().includes("ST")) return 5;
  if (code.startsWith("83") || code.startsWith("87") || code.startsWith("88") || code.startsWith("92")) return 30;
  if (code.startsWith("30") || code.startsWith("68")) return 20;
  return 10;
}

function isExecutionBlocked(row: Record<string, any>) {
  const status = String(row.execution_status || row.execution?.status || "").toUpperCase();
  if (status) return status === "BLOCKED_LIMIT_UP";
  return rowPct(row) >= limitUpThreshold(row) - 0.08;
}

function isPrimaryTradeCandidate(row: Record<string, any>) {
  const action = String(row.action || "").toUpperCase();
  const recommendationType = String(row.recommendation_type || row.recommendationType || "").toUpperCase();
  return action === "TRADE" && recommendationType !== "LIMIT_REVIEW" && !isExecutionBlocked(row);
}

async function publishedOutputFailures() {
  const failures: string[] = [];
  const recommendation = await readJson("reports/data/latest-quant-recommendation.json");
  const signals = await readJson("reports/data/latest-trading-signals.json");
  const recommendedBuys = Array.isArray(recommendation.recommendedBuys) ? recommendation.recommendedBuys : [];
  const tradeRows = Array.isArray(signals.trade) ? signals.trade : [];
  const invalidRecommended = recommendedBuys.filter((row: Record<string, any>) => !isPrimaryTradeCandidate(row));
  const invalidTradeRows = tradeRows.filter((row: Record<string, any>) => !isPrimaryTradeCandidate(row));
  if (invalidRecommended.length) {
    failures.push(`推荐买入池存在不合规候选：${invalidRecommended.slice(0, 6).map((row: Record<string, any>) => `${rowCode(row)} ${rowName(row)}`).join("、")}`);
  }
  if (invalidTradeRows.length) {
    failures.push(`交易信号池存在不合规 TRADE：${invalidTradeRows.slice(0, 6).map((row: Record<string, any>) => `${rowCode(row)} ${rowName(row)}`).join("、")}`);
  }
  return failures;
}

function csvLineSplit(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsv(text: string) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = csvLineSplit(lines[0] || "");
  return lines.slice(1).map((line) => {
    const cells = csvLineSplit(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
  });
}

function dateFromStockPoolName(filePath: string) {
  const match = path.basename(filePath).match(/stock_pool_(\d{4}-\d{2}-\d{2})\.csv$/);
  return match?.[1] || "";
}

async function findPreviousStockPoolPath(todayTradeDate: string) {
  const dir = path.join(repoRoot, "quant-system/data");
  const entries = await fs.readdir(dir).catch(() => []);
  const candidates = entries
    .filter((name) => /^stock_pool_\d{4}-\d{2}-\d{2}\.csv$/.test(name))
    .map((name) => path.join(dir, name))
    .filter((filePath) => dateFromStockPoolName(filePath) < todayTradeDate)
    .sort((a, b) => dateFromStockPoolName(b).localeCompare(dateFromStockPoolName(a)));
  return candidates[0] || "";
}

function previousCandidateFromCsv(row: Record<string, string>) {
  return {
    code: String(row["code"] || row["代码"] || "").padStart(6, "0"),
    name: String(row["name"] || row["真实简称"] || row["输入名称"] || ""),
    previousScore: Number(row["score"] || row["量化总分"] || 0),
    previousPct: Number(row["pct_chg"] || row["涨跌幅%"] || 0),
    previousLayer: row["tier"] || row["研究层级"] || row["action"] || "",
  };
}

function continuityStatus(quote: Record<string, any>, inToday: boolean) {
  const pct = Number(quote?.pct || 0);
  const volumeRatio = Number(quote?.volumeRatio || 0);
  const turnover = Number(quote?.turnover || 0);
  if (inToday) return { status: "KEEP", label: "保留", action: "继续跟踪", severity: "good" };
  if (pct >= 9 || volumeRatio >= 3.2) return { status: "OVERHEATED", label: "过热", action: "不追高，等回落", severity: "warn" };
  if (pct >= 3 && pct <= 7 && turnover >= 3) return { status: "WATCH", label: "仍强", action: "保留观察，排序被挤出", severity: "good" };
  if (pct > 0) return { status: "COOL_DOWN", label: "降温", action: "降级观察", severity: "warn" };
  return { status: "DROP", label: "剔除", action: "暂不跟踪", severity: "danger" };
}

async function writeContinuityReview() {
  const tradeDate = shanghaiTradeDate();
  const previousPath = await findPreviousStockPoolPath(tradeDate);
  const todayPath = path.join(repoRoot, "quant-system/backend/data/stock_pool_latest.json");
  const todayPool = JSON.parse(await fs.readFile(todayPath, "utf8"));
  const todaySignals = Array.isArray(todayPool.signals) ? todayPool.signals.slice(0, 30) : [];
  if (!previousPath) {
    const payload = {
      generatedAt: new Date().toISOString(),
      previousSource: null,
      previousTradeDate: null,
      todaySource: "quant-system/backend/data/stock_pool_latest.json",
      todayTradeDate: todayPool.trade_date || tradeDate,
      modelNote: "未找到今日之前的 stock_pool_YYYY-MM-DD.csv，上一期复核暂不可用。",
      summary: {
        previousTotal: 0,
        todayTotal: todaySignals.length,
        kept: 0,
        stillStrong: 0,
        cooled: 0,
        overheated: 0,
        dropped: 0,
        added: todaySignals.length,
      },
      reviewRows: [],
      addedRows: todaySignals.map((item: Record<string, any>, index: number) => ({
        code: String(item.code || "").padStart(6, "0"),
        name: item.name || "",
        todayRank: index + 1,
        score: item.score,
        pct: item.pct_chg,
        turnover: item.turnover,
        volumeRatio: item.volume_ratio,
        risk: item.risk_level,
        action: item.action,
      })),
      priorityRows: [],
    };
    const reportPath = path.join(repoRoot, "reports/data/latest-continuity-review.json");
    await atomicWriteJson(reportPath, payload);
    return payload.summary;
  }
  const previous = parseCsv(await fs.readFile(previousPath, "utf8")).slice(0, 30).map(previousCandidateFromCsv);
  const previousTradeDate = dateFromStockPoolName(previousPath);
  const todayCodes = new Set(todaySignals.map((item: Record<string, unknown>) => String(item.code || "").padStart(6, "0")));
  const previousCandidates = previous.map((item) => ({ code: item.code, name: item.name }));
  const todayCandidates = todaySignals.map((item: Record<string, unknown>) => ({
    code: String(item.code || "").padStart(6, "0"),
    name: String(item.name || ""),
  }));
  const union = [...previousCandidates, ...todayCandidates].filter(
    (item, index, rows) => item.code && rows.findIndex((row) => row.code === item.code) === index,
  );
  const quoteMap = new Map((await fetchTencentRows(union)).map((row) => [row.code, row]));
  const reviewRows = previousCandidates.map((item, index) => {
    const source = previous[index] || {};
    const quote = (quoteMap.get(item.code) || {}) as Record<string, any>;
    const status = continuityStatus(quote, todayCodes.has(item.code));
    return {
      ...item,
      previousRank: index + 1,
      previousScore: Number(source.previousScore || 0),
      previousPct: Number(source.previousPct || 0),
      previousLayer: source.previousLayer || "",
      todayPrice: quote.price,
      todayPct: quote.pct,
      todayTurnover: quote.turnover,
      todayVolumeRatio: quote.volumeRatio,
      todayTime: quote.time,
      inTodayTop: todayCodes.has(item.code),
      ...status,
      reason:
        status.status === "KEEP"
          ? "进入今日候选池"
          : status.status === "WATCH"
            ? "今日仍在3%-7%强势区间，但被更高分新票挤出"
            : status.status === "OVERHEATED"
              ? "涨幅或量比过热，不适合追入"
              : status.status === "COOL_DOWN"
                ? "仍为红盘但强度低于趋势模型阈值"
                : "转弱或承接不足",
    };
  });
  const addedRows = todaySignals
    .filter((item: Record<string, unknown>) => !previousCandidates.some((previousItem) => previousItem.code === String(item.code || "").padStart(6, "0")))
    .map((item: Record<string, any>, index: number) => ({
      code: String(item.code || "").padStart(6, "0"),
      name: item.name || "",
      todayRank: index + 1,
      score: item.score,
      pct: item.pct_chg,
      turnover: item.turnover,
      volumeRatio: item.volume_ratio,
      risk: item.risk_level,
      action: item.action,
    }));
  const summary = {
    previousTotal: reviewRows.length,
    todayTotal: todaySignals.length,
    kept: reviewRows.filter((row) => row.status === "KEEP").length,
    stillStrong: reviewRows.filter((row) => row.status === "WATCH").length,
    cooled: reviewRows.filter((row) => row.status === "COOL_DOWN").length,
    overheated: reviewRows.filter((row) => row.status === "OVERHEATED").length,
    dropped: reviewRows.filter((row) => row.status === "DROP").length,
    added: addedRows.length,
  };
  const payload = {
    generatedAt: new Date().toISOString(),
    previousSource: path.relative(repoRoot, previousPath),
    previousTradeDate,
    todaySource: "quant-system/backend/data/stock_pool_latest.json",
    todayTradeDate: todayPool.trade_date || tradeDate,
    modelNote: `上一期 ${previousTradeDate} 股票池与今日 ${todayPool.trade_date || tradeDate} 股票池连续跟踪；本报告用于解释去留，不替代交易风控。`,
    summary,
    reviewRows,
    addedRows,
    priorityRows: [
      ...reviewRows.filter((row) => ["KEEP", "WATCH"].includes(row.status)).slice(0, 8),
      ...addedRows.slice(0, 8),
    ],
  };
  const reportPath = path.join(repoRoot, "reports/data/latest-continuity-review.json");
  await atomicWriteJson(reportPath, payload);
  return summary;
}

async function runLiveSelection(tradeDate: string) {
  try {
    return await runPython(
      "run_selection.py",
      ["--trade-date", tradeDate, "--live-provider", "--no-live-fallback", "--scan-limit", "500", "--limit", "30"],
      120000,
    );
  } catch (error) {
    try {
      const inputPath = await fetchEastMoneyRows(500);
      const result = await runPython("run_selection.py", ["--trade-date", tradeDate, "--input", inputPath, "--limit", "30"], 120000);
      return {
        ...result,
        script: "run_selection.py",
        stderr: [`primary live provider failed: ${error instanceof Error ? error.message : String(error)}`, "used EastMoney curl live fallback"].join("\n"),
      };
    } catch (fallbackError) {
      const live = await fetchTencentCandidateQuotes();
      return {
        script: "live_tencent_quotes",
        stdout: `updated ${live.rows} candidate quotes; latest tick ${live.latestTime}`,
        stderr: [
          `full-market live selection failed: ${error instanceof Error ? error.message : String(error)}`,
          `EastMoney curl fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
          "updated Tencent realtime candidate quotes only",
        ].join("\n"),
      };
    }
  }
}

async function criticalRefreshFailures(results: Array<{ script: string; stdout: string; stderr: string }>, tradeDate: string) {
  const failures: string[] = [];
  const selection = results.find((item) => item.script === "run_selection.py" || item.stderr.includes("full-market live selection failed"));
  if (!selection || selection.script !== "run_selection.py" || selection.stderr.includes("full-market live selection failed")) {
    failures.push("全市场实时选股失败，当前候选池不能视为今日重算");
  }
  const live = results.find((item) => item.script === "live_tencent_quotes");
  const latestTick = live?.stdout.match(/latest tick (\d{14})/)?.[1] || "";
  const latestTickDate = tencentTradeDate(latestTick);
  if (!live || !latestTick || !liveQuoteDateAcceptable(latestTickDate, tradeDate)) {
    failures.push(`候选实时行情不是今日数据：${latestTickDate || "未知"} < ${tradeDate}`);
  }
  const kline = results.find((item) => item.script === "refresh_kline_cache.py");
  if (!kline || !kline.stdout.includes("kline refreshed:")) {
    failures.push("K线缓存未完整刷新，技术指标和投委会不能视为完整");
  }
  const watchlist = results.find((item) => item.script === "user_watchlist_review");
  if (!watchlist || watchlist.stderr.trim()) {
    failures.push("用户票池复核失败，无法解释自选股涨停/漏判原因");
  } else {
    const missed = Number(watchlist.stdout.match(/missed=(\d+)/)?.[1] || 0);
    if (missed > 0) failures.push(`用户票池仍有 ${missed} 只强势/涨停票未进入主分析池`);
  }
  failures.push(...(await publishedOutputFailures()));
  return failures;
}

function stepOk(item: { script: string; stdout: string; stderr: string }) {
  if (item.script === "run_selection.py" && item.stdout.includes("selected ")) return true;
  if (item.script === "refresh_kline_cache.py" && item.stdout.includes("kline refreshed:")) return true;
  if (item.script === "recommendation_performance.mjs" && item.stdout.includes("recommendation performance rows=")) return true;
  if (item.script === "verify_recommendation_performance.mjs" && item.stdout.includes("recommendation performance verification passed")) return true;
  return !item.stderr.trim();
}

function runningFresh(report: Record<string, any>) {
  if (report.status !== "RUNNING") return false;
  const started = Date.parse(String(report.startedAt || ""));
  if (!Number.isFinite(started)) return false;
  return Date.now() - started < 15 * 60 * 1000;
}

function researchArgs() {
  if (process.env.QUANT_REFRESH_LIVE_SOURCES === "false") return [];
  return ["--live-sources", "--source-page-size", process.env.QUANT_REFRESH_SOURCE_PAGE_SIZE || "5"];
}

async function readRefreshReport() {
  try {
    return JSON.parse(await fs.readFile(refreshReportPath, "utf8"));
  } catch {
    return {};
  }
}

async function runRefreshWorkflow(startedAt: string) {
  const tradeDate = shanghaiTradeDate();
  const steps = [
    {
      script: "run_selection.py",
      timeout: 120000,
    },
    {
      script: "live_tencent_quotes",
      timeout: 30000,
      optional: true,
    },
    {
      script: "refresh_kline_cache.py",
      args: ["--days", "160", "--limit", "30", "--include-watchlist", "--max-fetch", "12"],
      timeout: 120000,
      optional: true,
    },
    {
      script: "recommendation_performance.mjs",
      timeout: 30000,
      optional: true,
    },
    {
      script: "verify_recommendation_performance.mjs",
      timeout: 30000,
      optional: true,
    },
    {
      script: "run_event_backtest.py",
      args: ["--hold-days", "3", "--limit", "30"],
      timeout: 90000,
      optional: true,
    },
    {
      script: "continuity_review",
      timeout: 30000,
      optional: true,
    },
    {
      script: "user_watchlist_review",
      timeout: 60000,
      optional: true,
    },
    {
      script: "run_committee.py",
      args: [],
      timeout: 90000,
      optional: true,
    },
    {
      script: "run_research.py",
      args: researchArgs(),
      timeout: 120000,
      optional: true,
    },
    {
      script: "run_strategy_registry.py",
      args: [],
      timeout: 30000,
      optional: true,
    },
    {
      script: "run_strategy_review.py",
      args: [],
      timeout: 30000,
      optional: true,
    },
    {
      script: "run_parameter_backtest.py",
      args: ["--base-key", "volume_breakout", "--limit", "30", "--window", "160"],
      timeout: 120000,
      optional: true,
    },
    {
      script: "run_case_kb_from_failure.py",
      args: [],
      timeout: 30000,
      optional: true,
    },
  ];
  const results: Array<{ script: string; stdout: string; stderr: string }> = [];
  try {
    for (const step of steps) {
      try {
        if (step.script === "run_selection.py") {
          results.push(await runLiveSelection(tradeDate));
        } else if (step.script === "live_tencent_quotes") {
          const live = await fetchTencentCandidateQuotes();
          results.push({ script: step.script, stdout: `updated ${live.rows} candidate quotes; latest tick ${live.latestTime}`, stderr: "" });
        } else if (step.script === "continuity_review") {
          const summary = await writeContinuityReview();
          results.push({ script: step.script, stdout: JSON.stringify(summary), stderr: "" });
        } else if (step.script === "user_watchlist_review") {
          const result = await execFileAsync(process.execPath, [path.join(quantRoot, "scripts/user_watchlist_review.mjs")], {
            cwd: quantRoot,
            timeout: step.timeout,
            maxBuffer: 1024 * 1024 * 4,
            env: { ...process.env, TRADE_DATE: tradeDate },
          });
          results.push({ script: step.script, stdout: result.stdout, stderr: result.stderr });
        } else if (step.script.endsWith(".mjs")) {
          results.push(await runNodeScript(step.script, step.timeout));
        } else {
          results.push(await runPython(step.script, step.args || [], step.timeout));
        }
      } catch (error) {
        if (!step.optional) throw error;
        results.push({
          script: step.script,
          stdout: "",
          stderr: error instanceof Error ? error.message : "可选数据更新失败",
        });
      }
    }
    const warning = results.map((item) => item.stderr.trim()).filter(Boolean).join("\n") || undefined;
    const criticalFailures = await criticalRefreshFailures(results, tradeDate);
    const refreshReport = {
      ok: criticalFailures.length === 0,
      status: criticalFailures.length === 0 ? "SUCCESS" : "FAILED",
      tradeDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      warning,
      criticalFailures,
      steps: results.map((item) => ({
        script: item.script,
        ok: stepOk(item),
        stdout: item.stdout.slice(0, 2000),
        stderr: item.stderr.slice(0, 4000),
      })),
    };
    await atomicWriteJson(refreshReportPath, refreshReport);
    return refreshReport;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "数据更新失败";
    const refreshReport = {
      ok: false,
      status: "FAILED",
      tradeDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      detail,
      steps: results.map((item) => ({
        script: item.script,
        ok: stepOk(item),
        stdout: item.stdout.slice(0, 2000),
        stderr: item.stderr.slice(0, 4000),
      })),
    };
    await atomicWriteJson(refreshReportPath, refreshReport);
    return refreshReport;
  }
}

export async function GET() {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  const report = await readRefreshReport();
  return NextResponse.json({
    ok: report.ok !== false,
    running: report.status === "RUNNING",
    report,
    snapshot: getWorkbenchSnapshot(),
  });
}

export async function POST() {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json(
      {
        ok: false,
        queued: false,
        running: false,
        detail: "公开部署为只读模式，不能在线刷新；请在私有环境刷新后重新部署。",
        snapshot: getWorkbenchSnapshot(),
      },
      { status: 403 },
    );
  }
  const existingReport = await readRefreshReport();
  if (runningFresh(existingReport)) {
    return NextResponse.json(
      {
        ok: true,
        queued: false,
        running: true,
        detail: "已有刷新任务正在执行",
        report: existingReport,
      },
      { status: 202 },
    );
  }

  const tradeDate = shanghaiTradeDate();
  const startedAt = new Date().toISOString();
  const runningReport = {
    ok: null,
    status: "RUNNING",
    tradeDate,
    startedAt,
    finishedAt: null,
    detail: "数据刷新正在后台执行",
    criticalFailures: [],
    steps: [],
  };
  await atomicWriteJson(refreshReportPath, runningReport);

  const nodePath = process.execPath;
  const workerPath = path.join(quantRoot, "scripts/refresh_worker.mjs");
  const child = spawn(nodePath, [workerPath], {
    cwd: quantRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      REFRESH_STARTED_AT: startedAt,
      TRADE_DATE: tradeDate,
    },
  });
  child.unref();

  return NextResponse.json(
    {
      ok: true,
      queued: true,
      running: true,
      report: runningReport,
    },
    { status: 202 },
  );
}
