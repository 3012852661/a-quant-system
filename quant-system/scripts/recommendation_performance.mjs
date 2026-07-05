import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(quantRoot, "..");
const horizons = [1, 3, 5];

function cliOptions(argv) {
  const options = {
    recommendation: path.join(repoRoot, "reports/data/latest-quant-recommendation.json"),
    output: path.join(repoRoot, "reports/data/latest-recommendation-performance.json"),
    klineDir: path.join(repoRoot, "reports/data/kline-cache"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--recommendation" && next) {
      options.recommendation = path.resolve(next);
      index += 1;
    } else if (arg === "--output" && next) {
      options.output = path.resolve(next);
      index += 1;
    } else if (arg === "--kline-dir" && next) {
      options.klineDir = path.resolve(next);
      index += 1;
    }
  }
  return options;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWriteJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

function datePart(value) {
  const text = String(value || "");
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return text.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

function codeOf(row) {
  const code = String(row?.code || "").replace(/\D/g, "").padStart(6, "0");
  return code.length === 6 ? code : "";
}

function numberOf(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function buyZoneAverage(value) {
  const nums = String(value || "")
    .match(/\d+(?:\.\d+)?/g)
    ?.map(Number)
    .filter((item) => Number.isFinite(item) && item > 0);
  if (!nums?.length) return null;
  return nums.reduce((sum, item) => sum + item, 0) / nums.length;
}

function entryPrice(row) {
  const current = numberOf(row.current_price ?? row.price);
  if (current && current > 0) return { price: current, source: "推荐日现价" };
  const zone = buyZoneAverage(row.entry?.buyZone || row.buy_zone);
  if (zone && zone > 0) return { price: zone, source: "模型买区均值" };
  return { price: null, source: "缺少价格" };
}

function candidateRows(recommendation) {
  const groups = [
    ["recommendedBuys", recommendation.recommendedBuys],
    ["qualityRadar", recommendation.qualityRadar],
    ["upliftTop", recommendation.upliftTop],
  ];
  const seen = new Set();
  const rows = [];
  for (const [bucket, items] of groups) {
    if (!Array.isArray(items)) continue;
    for (const row of items) {
      const code = codeOf(row);
      if (!code) continue;
      const tradeDate = datePart(row.trade_date || row.tradeDate || row.dataDate || recommendation.generatedAt);
      const key = `${code}:${tradeDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...row, code, bucket, tradeDate });
    }
  }
  return rows;
}

function normalizeKlines(payload) {
  const rows = Array.isArray(payload.klines) ? payload.klines : Array.isArray(payload.rows) ? payload.rows : [];
  return rows
    .map((row) => {
      const close = numberOf(row.close ?? row.close_price ?? row.price);
      const date = datePart(row.date ?? row.trade_date ?? row.time);
      return close && close > 0 && date ? { date, close } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function horizonResult(klines, tradeDate, entry, days) {
  if (!entry) return { status: "NO_ENTRY_PRICE", days, date: null, close: null, returnPct: null };
  const future = klines.filter((row) => row.date > tradeDate);
  const target = future[days - 1];
  if (!target) {
    const latest = klines.at(-1);
    return {
      status: "PENDING",
      days,
      date: null,
      close: null,
      returnPct: null,
      availableFutureDays: future.length,
      latestKlineDate: latest?.date || null,
    };
  }
  return {
    status: "READY",
    days,
    date: target.date,
    close: Number(target.close.toFixed(3)),
    returnPct: Number(((target.close / entry - 1) * 100).toFixed(2)),
  };
}

function summarize(rows) {
  const summary = { total: rows.length };
  for (const days of horizons) {
    const key = `d${days}`;
    const values = rows
      .map((row) => row.returns[key]?.returnPct)
      .filter((item) => item !== null && item !== undefined && Number.isFinite(Number(item)));
    summary[`${key}Ready`] = values.length;
    summary[`${key}Pending`] = rows.length - values.length;
    summary[`${key}AvgReturnPct`] = values.length
      ? Number((values.reduce((sum, item) => sum + Number(item), 0) / values.length).toFixed(2))
      : null;
    summary[`${key}WinRatePct`] = values.length
      ? Number(((values.filter((item) => Number(item) > 0).length / values.length) * 100).toFixed(2))
      : null;
  }
  return summary;
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const recommendation = await readJson(options.recommendation, {});
  const rows = [];
  for (const row of candidateRows(recommendation)) {
    const entry = entryPrice(row);
    const klinePayload = await readJson(path.join(options.klineDir, `${row.code}.daily.json`), {});
    const klines = normalizeKlines(klinePayload);
    const returns = Object.fromEntries(horizons.map((days) => [`d${days}`, horizonResult(klines, row.tradeDate, entry.price, days)]));
    rows.push({
      code: row.code,
      name: row.name || row.code,
      bucket: row.bucket,
      tradeDate: row.tradeDate,
      dataDate: row.tradeDate || datePart(recommendation.generatedAt),
      entryPrice: entry.price == null ? null : Number(entry.price.toFixed(3)),
      entrySource: entry.source,
      score: numberOf(row.score),
      action: row.action || row.recommendation_type || row.recommendationType || "",
      riskLevel: row.risk_level || row.riskLevel || "",
      klineLatestDate: klines.at(-1)?.date || null,
      returns,
    });
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    source: path.relative(repoRoot, options.recommendation),
    sourceGeneratedAt: recommendation.generatedAt || null,
    horizons,
    summary: summarize(rows),
    rows,
  };
  await atomicWriteJson(options.output, payload);
  console.log(`recommendation performance rows=${rows.length}; output=${path.relative(repoRoot, options.output)}`);
}

await main();
