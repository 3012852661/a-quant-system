import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { getWorkbenchSnapshot } from "../../../lib/local-data";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd(), "../..");
const quantRoot = path.join(repoRoot, "quant-system");

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
  const pythonPath = path.join(quantRoot, ".venv/bin/python");
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
  await fs.writeFile(inputPath, JSON.stringify(rows, null, 2), "utf8");
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
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    JSON.stringify({ source: "Tencent qt.gtimg.cn", generatedAt, rows }, null, 2),
    "utf8",
  );
  return { rows: rows.length, latestTime: rows.map((row) => row.time).sort().at(-1) };
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
  const previousPath = path.join(repoRoot, "outputs/quant_analysis_20260615/量化分析全表_20260615.csv");
  const todayPath = path.join(repoRoot, "quant-system/backend/data/stock_pool_latest.json");
  const previous = parseCsv(await fs.readFile(previousPath, "utf8")).slice(0, 30);
  const todayPool = JSON.parse(await fs.readFile(todayPath, "utf8"));
  const todaySignals = Array.isArray(todayPool.signals) ? todayPool.signals.slice(0, 30) : [];
  const todayCodes = new Set(todaySignals.map((item: Record<string, unknown>) => String(item.code || "").padStart(6, "0")));
  const previousCandidates = previous.map((item) => ({
    code: String(item["代码"] || "").padStart(6, "0"),
    name: String(item["真实简称"] || item["输入名称"] || ""),
  }));
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
      previousScore: Number(source["量化总分"] || 0),
      previousPct: Number(source["涨跌幅%"] || 0),
      previousLayer: source["研究层级"] || "",
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
    previousSource: "outputs/quant_analysis_20260615/量化分析全表_20260615.csv",
    todaySource: "quant-system/backend/data/stock_pool_latest.json",
    modelNote: "昨日多因子研究池与今日趋势突破池口径不同；本报告用于连续跟踪解释，不替代交易风控。",
    summary,
    reviewRows,
    addedRows,
    priorityRows: [
      ...reviewRows.filter((row) => ["KEEP", "WATCH"].includes(row.status)).slice(0, 8),
      ...addedRows.slice(0, 8),
    ],
  };
  const reportPath = path.join(repoRoot, "reports/data/latest-continuity-review.json");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(payload, null, 2), "utf8");
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

export async function POST() {
  const tradeDate = shanghaiTradeDate();
  const startedAt = new Date().toISOString();
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
      args: ["--days", "160", "--limit", "30"],
      timeout: 120000,
      optional: true,
    },
    {
      script: "continuity_review",
      timeout: 30000,
      optional: true,
    },
    {
      script: "run_committee.py",
      args: [],
      timeout: 90000,
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
    const refreshReport = {
      ok: true,
      tradeDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      warning,
      steps: results.map((item) => ({
        script: item.script,
        ok: !item.stderr.trim(),
        stdout: item.stdout.slice(0, 2000),
        stderr: item.stderr.slice(0, 4000),
      })),
    };
    await fs.mkdir(path.join(repoRoot, "reports/data"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "reports/data/latest-refresh-report.json"), JSON.stringify(refreshReport, null, 2), "utf8");
    return NextResponse.json({
      ok: true,
      warning,
      steps: results,
      snapshot: getWorkbenchSnapshot(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "数据更新失败";
    const refreshReport = {
      ok: false,
      tradeDate,
      startedAt,
      finishedAt: new Date().toISOString(),
      detail,
      steps: results.map((item) => ({
        script: item.script,
        ok: !item.stderr.trim(),
        stdout: item.stdout.slice(0, 2000),
        stderr: item.stderr.slice(0, 4000),
      })),
    };
    await fs.mkdir(path.join(repoRoot, "reports/data"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "reports/data/latest-refresh-report.json"), JSON.stringify(refreshReport, null, 2), "utf8");
    return NextResponse.json({ ok: false, detail, steps: results }, { status: 500 });
  }
}
