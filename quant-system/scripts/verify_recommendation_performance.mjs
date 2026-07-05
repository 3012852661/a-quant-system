import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const quantRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "recommendation-performance-"));
  const recommendationPath = path.join(tmpRoot, "recommendation.json");
  const klineDir = path.join(tmpRoot, "kline-cache");
  const outputPath = path.join(tmpRoot, "performance.json");
  await writeJson(recommendationPath, {
    generatedAt: "2026-06-26T15:10:00+08:00",
    qualityRadar: [
      {
        trade_date: "2026-06-26",
        code: "000001",
        name: "测试股份",
        current_price: 10,
        score: 88,
        action: "WATCH",
      },
    ],
  });
  await writeJson(path.join(klineDir, "000001.daily.json"), {
    generatedAt: "2026-07-03T15:30:00+08:00",
    source: "fixture",
    code: "000001",
    klines: [
      { date: "2026-06-26", close: 10 },
      { date: "2026-06-29", close: 11 },
      { date: "2026-06-30", close: 12 },
      { date: "2026-07-01", close: 13 },
      { date: "2026-07-02", close: 14 },
      { date: "2026-07-03", close: 15 },
    ],
  });

  await execFileAsync(process.execPath, [
    path.join(quantRoot, "scripts/recommendation_performance.mjs"),
    "--recommendation",
    recommendationPath,
    "--kline-dir",
    klineDir,
    "--output",
    outputPath,
  ]);
  const result = JSON.parse(await fs.readFile(outputPath, "utf8"));
  const row = result.rows[0];
  assertEqual(result.summary.d1Ready, 1, "d1Ready");
  assertEqual(result.summary.d3Ready, 1, "d3Ready");
  assertEqual(result.summary.d5Ready, 1, "d5Ready");
  assertEqual(row.returns.d1.status, "READY", "d1 status");
  assertEqual(row.returns.d3.status, "READY", "d3 status");
  assertEqual(row.returns.d5.status, "READY", "d5 status");
  assertEqual(row.returns.d1.date, "2026-06-29", "d1 date");
  assertEqual(row.returns.d3.date, "2026-07-01", "d3 date");
  assertEqual(row.returns.d5.date, "2026-07-03", "d5 date");
  assertEqual(row.returns.d1.returnPct, 10, "d1 return");
  assertEqual(row.returns.d3.returnPct, 30, "d3 return");
  assertEqual(row.returns.d5.returnPct, 50, "d5 return");
  console.log("recommendation performance verification passed");
}

await main();
