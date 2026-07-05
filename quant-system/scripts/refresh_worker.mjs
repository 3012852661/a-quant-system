import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(quantRoot, "..");
const reportPath = path.join(repoRoot, "reports/data/latest-refresh-report.json");
const startedAt = process.env.REFRESH_STARTED_AT || new Date().toISOString();
const tradeDate =
  process.env.TRADE_DATE ||
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

async function atomicWriteJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

function csvLineSplit(line) {
  const cells = [];
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

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = csvLineSplit(lines[0] || "");
  return lines.slice(1).map((line) => {
    const cells = csvLineSplit(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
  });
}

function dateFromStockPoolName(filePath) {
  const match = path.basename(filePath).match(/stock_pool_(\d{4}-\d{2}-\d{2})\.csv$/);
  return match?.[1] || "";
}

async function findPreviousStockPoolPath(todayTradeDate) {
  const dir = path.join(repoRoot, "quant-system/data");
  const entries = await fs.readdir(dir).catch(() => []);
  return entries
    .filter((name) => /^stock_pool_\d{4}-\d{2}-\d{2}\.csv$/.test(name))
    .map((name) => path.join(dir, name))
    .filter((filePath) => dateFromStockPoolName(filePath) < todayTradeDate)
    .sort((a, b) => dateFromStockPoolName(b).localeCompare(dateFromStockPoolName(a)))[0] || "";
}

function previousCandidateFromCsv(row) {
  return {
    code: String(row.code || row["代码"] || "").padStart(6, "0"),
    name: String(row.name || row["真实简称"] || row["输入名称"] || ""),
    previousScore: Number(row.score || row["量化总分"] || 0),
    previousPct: Number(row.pct_chg || row["涨跌幅%"] || 0),
    previousLayer: row.tier || row["研究层级"] || row.action || "",
  };
}

async function runPython(scriptName, args, timeout) {
  const python311 = path.join(quantRoot, ".venv311/bin/python");
  const python = await fs
    .access(python311)
    .then(() => python311)
    .catch(() => path.join(quantRoot, ".venv/bin/python"));
  const result = await execFileAsync(python, [path.join(quantRoot, "backend", scriptName), ...args], {
    cwd: quantRoot,
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  return { script: scriptName, stdout: result.stdout, stderr: result.stderr };
}

async function runNodeScript(scriptName, timeout) {
  const result = await execFileAsync(process.execPath, [path.join(quantRoot, "scripts", scriptName)], {
    cwd: quantRoot,
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  return { script: scriptName, stdout: result.stdout, stderr: result.stderr };
}

function researchArgs() {
  if (process.env.QUANT_REFRESH_LIVE_SOURCES === "false") return [];
  return ["--live-sources", "--source-page-size", process.env.QUANT_REFRESH_SOURCE_PAGE_SIZE || "5"];
}

function marketPrefix(code) {
  return String(code).startsWith("6") || String(code).startsWith("9") ? "sh" : "sz";
}

function parseTencentRows(text, nameByCode) {
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

async function refreshTencentCandidateQuotes() {
  const poolPath = path.join(repoRoot, "quant-system/backend/data/stock_pool_latest.json");
  const pool = JSON.parse(await fs.readFile(poolPath, "utf8"));
  const seen = new Set();
  const candidates = [];
  for (const item of Array.isArray(pool.signals) ? pool.signals : []) {
    const code = String(item.code || "").padStart(6, "0");
    if (!code || seen.has(code)) continue;
    seen.add(code);
    candidates.push({ code, name: String(item.name || "") });
    if (candidates.length >= 60) break;
  }
  if (!candidates.length) throw new Error("没有可用于腾讯实时刷新的候选池");

  const query = candidates.map((item) => `${marketPrefix(item.code)}${item.code}`).join(",");
  const response = await fetch(`https://qt.gtimg.cn/q=${query}`);
  if (!response.ok) throw new Error(`腾讯实时接口失败：HTTP ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const rows = parseTencentRows(text, new Map(candidates.map((item) => [item.code, item.name])));
  if (!rows.length) throw new Error("腾讯实时接口没有返回有效候选行情");

  await atomicWriteJson(path.join(repoRoot, "reports/data/live-tencent-candidate-quotes.json"), {
    source: "Tencent qt.gtimg.cn",
    generatedAt: new Date().toISOString(),
    rows,
  });
  const latestTime = rows.map((row) => row.time).sort().at(-1);
  return { script: "live_tencent_quotes", stdout: `updated ${rows.length} candidate quotes; latest tick ${latestTime}`, stderr: "" };
}

function continuityStatus(quote, inToday) {
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
  const todayPoolPath = path.join(repoRoot, "quant-system/backend/data/stock_pool_latest.json");
  const todayPool = JSON.parse(await fs.readFile(todayPoolPath, "utf8"));
  const todayTradeDate = todayPool.trade_date || tradeDate;
  const todaySignals = Array.isArray(todayPool.signals) ? todayPool.signals.slice(0, 30) : [];
  const previousPath = await findPreviousStockPoolPath(todayTradeDate);
  const addedRowsFromToday = () =>
    todaySignals.map((item, index) => ({
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

  if (!previousPath) {
    const payload = {
      generatedAt: new Date().toISOString(),
      previousSource: null,
      previousTradeDate: null,
      todaySource: "quant-system/backend/data/stock_pool_latest.json",
      todayTradeDate,
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
      addedRows: addedRowsFromToday(),
      priorityRows: [],
    };
    await atomicWriteJson(path.join(repoRoot, "reports/data/latest-continuity-review.json"), payload);
    return payload.summary;
  }

  const previousTradeDate = dateFromStockPoolName(previousPath);
  const previous = parseCsv(await fs.readFile(previousPath, "utf8")).slice(0, 30).map(previousCandidateFromCsv);
  const todayCodes = new Set(todaySignals.map((item) => String(item.code || "").padStart(6, "0")));
  const previousCandidates = previous.map((item) => ({ code: item.code, name: item.name }));
  const todayCandidates = todaySignals.map((item) => ({ code: String(item.code || "").padStart(6, "0"), name: String(item.name || "") }));
  const union = [...previousCandidates, ...todayCandidates].filter(
    (item, index, rows) => item.code && rows.findIndex((row) => row.code === item.code) === index,
  );
  const quoteMap = new Map();
  if (union.length) {
    const query = union.map((item) => `${marketPrefix(item.code)}${item.code}`).join(",");
    const response = await fetch(`https://qt.gtimg.cn/q=${query}`);
    if (response.ok) {
      const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
      for (const row of parseTencentRows(text, new Map(union.map((item) => [item.code, item.name])))) quoteMap.set(row.code, row);
    }
  }
  const reviewRows = previousCandidates.map((item, index) => {
    const source = previous[index] || {};
    const quote = quoteMap.get(item.code) || {};
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
    .filter((item) => !previousCandidates.some((previousItem) => previousItem.code === String(item.code || "").padStart(6, "0")))
    .map((item, index) => ({
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
    todayTradeDate,
    modelNote: `上一期 ${previousTradeDate} 股票池与今日 ${todayTradeDate} 股票池连续跟踪；本报告用于解释去留，不替代交易风控。`,
    summary,
    reviewRows,
    addedRows,
    priorityRows: [...reviewRows.filter((row) => ["KEEP", "WATCH"].includes(row.status)).slice(0, 8), ...addedRows.slice(0, 8)],
  };
  await atomicWriteJson(path.join(repoRoot, "reports/data/latest-continuity-review.json"), payload);
  return summary;
}

async function runOptional(step) {
  try {
    if (step.script === "live_tencent_quotes") return await refreshTencentCandidateQuotes();
    if (step.script === "continuity_review") {
      const summary = await writeContinuityReview();
      return { script: step.script, stdout: JSON.stringify(summary), stderr: "" };
    }
    if (step.script === "user_watchlist_review") {
      const result = await execFileAsync(process.execPath, [path.join(quantRoot, "scripts/user_watchlist_review.mjs")], {
        cwd: quantRoot,
        timeout: step.timeout || 60000,
        maxBuffer: 1024 * 1024 * 4,
        env: { ...process.env, TRADE_DATE: tradeDate },
      });
      return { script: step.script, stdout: result.stdout, stderr: result.stderr };
    }
    if (step.script.endsWith(".mjs")) return await runNodeScript(step.script, step.timeout || 30000);
    return await runPython(step.script, step.args || [], step.timeout);
  } catch (error) {
    return {
      script: step.script,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function stepOk(item) {
  if (item.script === "run_selection.py" && item.stdout.includes("selected ")) return true;
  if (item.script === "live_tencent_quotes" && item.stdout.includes("updated ")) return true;
  if (item.script === "refresh_kline_cache.py" && item.stdout.includes("kline refreshed:")) return true;
  if (item.script === "recommendation_performance.mjs" && item.stdout.includes("recommendation performance rows=")) return true;
  if (item.script === "verify_recommendation_performance.mjs" && item.stdout.includes("recommendation performance verification passed")) return true;
  return !item.stderr.trim();
}

function tencentTradeDate(value = "") {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

async function readJson(relativePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), "utf8"));
  } catch {
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

async function publishedOutputFailures() {
  const failures = [];
  const recommendation = await readJson("reports/data/latest-quant-recommendation.json", {});
  const signals = await readJson("reports/data/latest-trading-signals.json", {});
  const recommendedBuys = Array.isArray(recommendation.recommendedBuys) ? recommendation.recommendedBuys : [];
  const tradeRows = Array.isArray(signals.trade) ? signals.trade : [];
  const invalidRecommended = recommendedBuys.filter((row) => !isPrimaryTradeCandidate(row));
  const invalidTradeRows = tradeRows.filter((row) => !isPrimaryTradeCandidate(row));
  if (invalidRecommended.length) {
    failures.push(`推荐买入池存在不合规候选：${invalidRecommended.slice(0, 6).map((row) => `${rowCode(row)} ${rowName(row)}`).join("、")}`);
  }
  if (invalidTradeRows.length) {
    failures.push(`交易信号池存在不合规 TRADE：${invalidTradeRows.slice(0, 6).map((row) => `${rowCode(row)} ${rowName(row)}`).join("、")}`);
  }
  return failures;
}

async function criticalRefreshFailures(steps, expectedTradeDate) {
  const failures = [];
  const selection = steps.find((item) => item.script === "run_selection.py");
  if (!selection || !selection.stdout.includes("selected ")) {
    failures.push("全市场实时选股失败，当前候选池不能视为今日重算");
  }
  const live = steps.find((item) => item.script === "live_tencent_quotes");
  const latestTick = live?.stdout.match(/latest tick (\d{14})/)?.[1] || "";
  const latestTickDate = tencentTradeDate(latestTick);
  if (!live || !latestTick || latestTickDate !== expectedTradeDate) {
    failures.push(`候选实时行情不是今日数据：${latestTickDate || "未知"} < ${expectedTradeDate}`);
  }
  const kline = steps.find((item) => item.script === "refresh_kline_cache.py");
  if (!kline || !kline.stdout.includes("kline refreshed:")) {
    failures.push("K线缓存未完整刷新，技术指标和投委会不能视为完整");
  }
  const watchlist = steps.find((item) => item.script === "user_watchlist_review");
  if (!watchlist || !stepOk(watchlist)) {
    failures.push("用户票池复核失败，无法解释自选股涨停/漏判原因");
  } else {
    const missed = Number(watchlist.stdout.match(/missed=(\d+)/)?.[1] || 0);
    if (missed > 0) failures.push(`用户票池仍有 ${missed} 只强势/涨停票未进入主分析池`);
  }
  failures.push(...(await publishedOutputFailures()));
  return failures;
}

async function main() {
  const steps = [];
  try {
    let selection;
    try {
      selection = await runPython(
        "run_selection.py",
        ["--trade-date", tradeDate, "--live-provider", "--scan-limit", "500", "--limit", "30"],
        120000,
      );
    } catch (error) {
      const fullError = error instanceof Error ? error.message : String(error);
      selection = await runPython(
        "run_selection.py",
        ["--trade-date", tradeDate, "--live-provider", "--scan-limit", "80", "--limit", "30"],
        60000,
      );
      selection.stderr = [`full scan failed: ${fullError}`, selection.stderr].filter(Boolean).join("\n");
	    }
	    steps.push(selection);
    steps.push(
      await runOptional({
        script: "live_tencent_quotes",
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "refresh_kline_cache.py",
        args: ["--days", "160", "--limit", "30", "--include-watchlist", "--max-fetch", "12"],
        timeout: 120000,
      }),
    );
    steps.push(
      await runOptional({
        script: "recommendation_performance.mjs",
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "verify_recommendation_performance.mjs",
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "run_event_backtest.py",
        args: ["--hold-days", "3", "--limit", "30"],
        timeout: 90000,
      }),
    );
    steps.push(
      await runOptional({
        script: "continuity_review",
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "user_watchlist_review",
        timeout: 60000,
      }),
    );
    steps.push(
      await runOptional({
        script: "theme_frontline_monitor.mjs",
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "opening_confirmation.mjs",
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "trade_workbench.mjs",
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "run_committee.py",
        args: [],
        timeout: 90000,
      }),
    );
    steps.push(
      await runOptional({
        script: "run_research.py",
        args: researchArgs(),
        timeout: 120000,
      }),
    );
    steps.push(
      await runOptional({
        script: "run_strategy_registry.py",
        args: [],
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "run_strategy_review.py",
        args: [],
        timeout: 30000,
      }),
    );
    steps.push(
      await runOptional({
        script: "run_parameter_backtest.py",
        args: ["--base-key", "volume_breakout", "--limit", "30", "--window", "160"],
        timeout: 120000,
      }),
    );
    steps.push(
      await runOptional({
        script: "run_case_kb_from_failure.py",
        args: [],
        timeout: 30000,
      }),
    );

    const warning = steps.map((item) => item.stderr.trim()).filter(Boolean).join("\n") || undefined;
    const criticalFailures = await criticalRefreshFailures(steps, tradeDate);
    await atomicWriteJson(reportPath, {
      ok: criticalFailures.length === 0,
      status: criticalFailures.length ? "FAILED" : warning ? "SUCCESS_WITH_WARNINGS" : "SUCCESS",
      tradeDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      warning,
      criticalFailures,
      steps: steps.map((item) => ({
        script: item.script,
        ok: stepOk(item),
        stdout: item.stdout.slice(0, 2000),
        stderr: item.stderr.slice(0, 4000),
      })),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await atomicWriteJson(reportPath, {
      ok: false,
      status: "FAILED",
      tradeDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      detail,
      criticalFailures: [detail],
      steps: steps.map((item) => ({
        script: item.script,
        ok: stepOk(item),
        stdout: item.stdout.slice(0, 2000),
        stderr: item.stderr.slice(0, 4000),
      })),
    });
    process.exitCode = 1;
  }
}

await main();
