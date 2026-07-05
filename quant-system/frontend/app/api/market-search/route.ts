import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { requireAllowedUserResponse } from "../../../lib/access-control";

export const dynamic = "force-dynamic";

type SuggestRow = {
  Code?: string;
  Name?: string;
  QuoteID?: string;
  SecurityTypeName?: string;
  Classify?: string;
};

type QuoteRow = ReturnType<typeof parseTencentRows>[number];

type KlineRow = {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount?: number | null;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
};

const repoRoot = path.resolve(process.cwd(), "../..");

function marketPrefix(code: string) {
  return code.startsWith("6") || code.startsWith("9") || code.startsWith("5") ? "sh" : "sz";
}

function tencentTradeDate(value?: string) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function tencentDataTime(value?: string) {
  const match = String(value || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}` : "";
}

function shanghaiDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function latestAShareTradeDate(value = new Date()) {
  const base = shanghaiDate(value);
  const date = new Date(`${base}T12:00:00+08:00`);
  const day = date.getUTCDay();
  const offset = day === 0 ? 2 : day === 6 ? 1 : 0;
  if (offset) date.setUTCDate(date.getUTCDate() - offset);
  return shanghaiDate(date);
}

function avg(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function withMovingAverages(rows: KlineRow[]) {
  return rows.map((row, index) => {
    const closes = rows.slice(0, index + 1).map((item) => Number(item.close)).filter(Number.isFinite);
    return {
      ...row,
      ma5: closes.length >= 5 ? avg(closes.slice(-5)) : null,
      ma10: closes.length >= 10 ? avg(closes.slice(-10)) : null,
      ma20: closes.length >= 20 ? avg(closes.slice(-20)) : null,
    };
  });
}

function normalizeKlineRows(sourceRows: unknown[]) {
  return sourceRows
    .map((item) => {
      if (typeof item === "string") {
        const parts = item.split(",");
        return {
          date: parts[0],
          open: Number(parts[1]),
          close: Number(parts[2]),
          high: Number(parts[3]),
          low: Number(parts[4]),
          volume: Number(parts[5] || 0),
          amount: parts[6] === undefined ? null : Number(parts[6]),
        };
      }
      const row = item as Record<string, unknown>;
      return {
        date: String(row.date || row.day || row.trade_date || ""),
        open: Number(row.open),
        close: Number(row.close),
        high: Number(row.high),
        low: Number(row.low),
        volume: Number(row.volume || 0),
        amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
      };
    })
    .filter((item: KlineRow) => item.date && [item.open, item.close, item.high, item.low].every(Number.isFinite))
    .sort((a: KlineRow, b: KlineRow) => a.date.localeCompare(b.date));
}

function mergeQuoteIntoKline(rows: KlineRow[], quote?: QuoteRow) {
  if (!quote?.tradeDate || !quote.price) return rows;
  const liveRow: KlineRow = {
    date: quote.tradeDate,
    open: Number(quote.open || quote.prevClose || quote.price),
    close: Number(quote.price),
    high: Number(quote.high || quote.price),
    low: Number(quote.low || quote.price),
    volume: Number(quote.volume || 0),
    amount: Number.isFinite(Number(quote.amountYi)) ? Number(quote.amountYi) * 100000000 : null,
  };
  const existingIndex = rows.findIndex((row) => row.date === liveRow.date);
  if (existingIndex >= 0) {
    const existing = rows[existingIndex];
    rows[existingIndex] = {
      ...existing,
      open: liveRow.open || existing.open,
      close: liveRow.close || existing.close,
      high: Math.max(existing.high, liveRow.high),
      low: Math.min(existing.low, liveRow.low),
      volume: liveRow.volume || existing.volume,
      amount: liveRow.amount ?? existing.amount,
    };
    return rows;
  }
  if (!rows.length || liveRow.date > rows[rows.length - 1].date) rows.push(liveRow);
  return rows;
}

function klineResult(source: string, generatedAt: string | null, rows: KlineRow[], quote?: QuoteRow, detail?: string) {
  return {
    source,
    generatedAt,
    detail,
    rows: withMovingAverages(mergeQuoteIntoKline([...rows], quote)).slice(-120),
  };
}

async function fetchEastMoneyKline(code: string, quote?: QuoteRow) {
  const market = code.startsWith("6") || code.startsWith("9") || code.startsWith("5") ? "1" : "0";
  const params = new URLSearchParams({
    secid: `${market}.${code}`,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57",
    klt: "101",
    fqt: "1",
    end: "20500101",
    lmt: "160",
  });
  const response = await fetch(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://quote.eastmoney.com/",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`东方财富K线失败：HTTP ${response.status}`);
  const payload = await response.json();
  const rows = normalizeKlineRows(payload?.data?.klines || []);
  if (!rows.length) throw new Error("东方财富K线返回为空");
  return klineResult("EastMoney realtime daily kline", new Date().toISOString(), rows, quote);
}

async function fetchSinaKline(code: string, quote?: QuoteRow) {
  const params = new URLSearchParams({
    symbol: `${marketPrefix(code)}${code}`,
    scale: "240",
    ma: "no",
    datalen: "160",
  });
  const response = await fetch(`https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?${params}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`新浪K线失败：HTTP ${response.status}`);
  const text = await response.text();
  const rows = normalizeKlineRows(JSON.parse(text));
  if (!rows.length) throw new Error("新浪K线返回为空");
  return klineResult("Sina realtime daily kline", new Date().toISOString(), rows, quote);
}

async function readCachedKline(code: string, quote?: QuoteRow, detail?: string) {
  try {
    const filePath = path.join(repoRoot, `reports/data/kline-cache/${code}.daily.json`);
    const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
    const sourceRows = Array.isArray(payload.klines) ? payload.klines : Array.isArray(payload) ? payload : [];
    return klineResult(payload.source || "reports/data/kline-cache", payload.generatedAt || null, normalizeKlineRows(sourceRows), quote, detail);
  } catch {
    return { source: "missing", generatedAt: null, detail, rows: [] as KlineRow[] };
  }
}

async function fetchRealtimeKline(code: string, quote?: QuoteRow) {
  const errors: string[] = [];
  for (const loader of [fetchEastMoneyKline, fetchSinaKline]) {
    try {
      return await loader(code, quote);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return readCachedKline(code, quote, `实时K线源失败，已回退本地缓存：${errors.slice(0, 2).join("；")}`);
}

function buildAnalysis(quote: QuoteRow, klineRows: KlineRow[]) {
  const rows = klineRows.filter((row) => Number.isFinite(row.close));
  const latest = rows.at(-1);
  const prev = rows.at(-2);
  const closes = rows.map((row) => row.close);
  const latestPrice = Number(quote.price || latest?.close || 0);
  const ma5 = latest?.ma5 ?? avg(closes.slice(-5));
  const ma10 = latest?.ma10 ?? avg(closes.slice(-10));
  const ma20 = latest?.ma20 ?? avg(closes.slice(-20));
  const recent20 = rows.slice(-20);
  const high20 = Math.max(...recent20.map((row) => row.high).filter(Number.isFinite));
  const low20 = Math.min(...recent20.map((row) => row.low).filter(Number.isFinite));
  const avgVolume5 = avg(rows.slice(-6, -1).map((row) => row.volume).filter((value) => Number.isFinite(value) && value > 0));
  const latestVolume = Number(latest?.volume || 0);
  const volumeMultiple = avgVolume5 && latestVolume ? latestVolume / avgVolume5 : Number(quote.volumeRatio || 0);
  const position20 = Number.isFinite(high20) && Number.isFinite(low20) && high20 > low20 ? ((latestPrice - low20) / (high20 - low20)) * 100 : null;
  const dayRangePct = latestPrice ? ((Number(quote.high || latest?.high || latestPrice) - Number(quote.low || latest?.low || latestPrice)) / latestPrice) * 100 : null;
  const gapPct = quote.prevClose ? ((Number(quote.open || latestPrice) / Number(quote.prevClose) - 1) * 100) : null;
  const closeVsPrevPct = prev?.close ? ((latestPrice / prev.close - 1) * 100) : Number(quote.pct || 0);

  const positives: string[] = [];
  const risks: string[] = [];
  if (ma5 && ma10 && ma20 && latestPrice > ma5 && ma5 > ma10 && ma10 > ma20) positives.push("价格站上 MA5/10/20，短线均线呈多头排列");
  if (ma20 && latestPrice > ma20) positives.push(`价格位于 MA20 上方 ${((latestPrice / ma20 - 1) * 100).toFixed(2)}%`);
  if (volumeMultiple >= 1.5) positives.push(`量能放大，近似 ${volumeMultiple.toFixed(2)} 倍`);
  if (Number(quote.pct) > 0) positives.push(`实时涨跌幅 ${Number(quote.pct).toFixed(2)}%，日内为红盘`);
  if (position20 !== null && position20 >= 70) positives.push(`价格处于近20日区间高位 ${position20.toFixed(0)}%`);

  if (ma5 && latestPrice < ma5) risks.push("价格低于 MA5，短线趋势未确认");
  if (ma20 && latestPrice < ma20) risks.push("价格低于 MA20，中短线仍偏弱");
  if (Number(quote.pct) >= 7) risks.push("当日涨幅较高，追价风险上升");
  if (dayRangePct !== null && dayRangePct >= 6) risks.push(`日内振幅 ${dayRangePct.toFixed(2)}%，波动偏大`);
  if (position20 !== null && position20 <= 30) risks.push(`价格仍处于近20日区间低位 ${position20.toFixed(0)}%，趋势修复不足`);
  if (!quote.isLatest) risks.push("行情源交易日不是最近交易日，结论只能作为历史快照参考");
  if (!rows.length) risks.push("本地缺少 K 线缓存，无法做均线和区间分析");

  const trend =
    ma5 && ma10 && ma20 && latestPrice > ma5 && ma5 > ma10 && ma10 > ma20
      ? "短线偏强"
      : ma20 && latestPrice < ma20
        ? "趋势偏弱"
        : "震荡观察";
  const action =
    trend === "短线偏强" && Number(quote.pct) < 7
      ? "可加入观察池，等待回踩或分时承接确认"
      : trend === "趋势偏弱"
        ? "暂不追买，优先等待重新站上 MA20"
        : "只适合观察，不宜凭单点行情直接下单";

  return {
    trend,
    action,
    positives: positives.slice(0, 4),
    risks: risks.slice(0, 5),
    metrics: {
      ma5,
      ma10,
      ma20,
      high20: Number.isFinite(high20) ? high20 : null,
      low20: Number.isFinite(low20) ? low20 : null,
      position20,
      volumeMultiple,
      dayRangePct,
      gapPct,
      closeVsPrevPct,
    },
  };
}

function parseTencentRows(text: string, nameByCode = new Map<string, string>()) {
  const latestTradeDate = latestAShareTradeDate();
  return text
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const value = item.split("=", 2)[1]?.replace(/^"|"$/g, "") || "";
      const parts = value.split("~");
      const code = String(parts[2] || "").padStart(6, "0");
      const price = Number(parts[3] || 0);
      if (!code || !price) return [];
      const dataTime = tencentDataTime(parts[30]);
      const tradeDate = tencentTradeDate(parts[30]);
      return [{
        code,
        name: nameByCode.get(code) || parts[1] || "",
        price,
        prevClose: Number(parts[4] || 0),
        open: Number(parts[5] || 0),
        volume: Number(parts[6] || 0),
        high: Number(parts[33] || 0),
        low: Number(parts[34] || 0),
        pct: Number(parts[32] || 0),
        change: Number(parts[31] || 0),
        turnover: Number(parts[38] || 0),
        amountYi: Number(parts[37] || 0) / 10000,
        totalMvYi: Number(parts[45] || 0),
        floatMvYi: Number(parts[44] || 0),
        volumeRatio: Number(parts[49] || 0),
        pe: Number(parts[39] || 0),
        pb: Number(parts[46] || 0),
        time: parts[30] || "",
        tradeDate,
        dataDate: tradeDate,
        dataTime,
        asOf: dataTime || tradeDate,
        latestTradeDate,
        isLatest: Boolean(tradeDate && tradeDate >= latestTradeDate),
        source: "Tencent qt.gtimg.cn",
      }];
    });
}

async function suggestStocks(query: string) {
  const input = encodeURIComponent(query);
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${input}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=12`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://quote.eastmoney.com/",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`东方财富搜索失败：HTTP ${response.status}`);
  const payload = await response.json();
  const rows = (payload?.QuotationCodeTable?.Data || []) as SuggestRow[];
  return rows
    .filter((row) => row.Classify === "AStock" && row.Code && /^\d{6}$/.test(row.Code))
    .map((row) => ({
      code: String(row.Code).padStart(6, "0"),
      name: row.Name || "",
      quoteId: row.QuoteID || "",
      type: row.SecurityTypeName || "A股",
    }));
}

async function fetchTencentQuotes(rows: Array<{ code: string; name: string }>) {
  const uniqueRows = rows.filter((row, index) => row.code && rows.findIndex((item) => item.code === row.code) === index).slice(0, 12);
  if (!uniqueRows.length) return [];
  const query = uniqueRows.map((item) => `${marketPrefix(item.code)}${item.code}`).join(",");
  const response = await fetch(`https://qt.gtimg.cn/q=${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`腾讯行情失败：HTTP ${response.status}`);
  const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
  return parseTencentRows(text, new Map(uniqueRows.map((item) => [item.code, item.name])));
}

export async function GET(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  const q = String(request.nextUrl.searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ ok: false, detail: "请输入股票代码或名称" }, { status: 400 });

  try {
    const digits = q.replace(/\D/g, "");
    const candidates = digits.length >= 5
      ? [{ code: digits.slice(0, 6).padStart(6, "0"), name: "" }]
      : await suggestStocks(q);
    const rows = await fetchTencentQuotes(candidates);
    const enrichedRows = await Promise.all(rows.map(async (row) => {
      const kline = await fetchRealtimeKline(row.code, row);
      return {
        ...row,
        kline,
        analysis: buildAnalysis(row, kline.rows),
      };
    }));
    const generatedAt = new Date().toISOString();
    return NextResponse.json({
      ok: true,
      query: q,
      generatedAt,
      dataTime: generatedAt.replace("T", " ").slice(0, 19),
      asOf: enrichedRows[0]?.asOf || generatedAt,
      latestTradeDate: latestAShareTradeDate(),
      rows: enrichedRows,
      suggestions: candidates,
      source: enrichedRows.length ? "EastMoney suggest + Tencent realtime quote + realtime daily kline" : "EastMoney suggest",
      detail: enrichedRows.length
        ? enrichedRows.every((row) => row.isLatest) ? "已返回最近交易日最新行情，并附带实时K线分析" : "行情源返回的交易日早于最近交易日"
        : "没有查到可用 A 股实时行情",
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        query: q,
        generatedAt: new Date().toISOString(),
        latestTradeDate: latestAShareTradeDate(),
        detail: error instanceof Error ? error.message : "行情查询失败",
      },
      { status: 502 },
    );
  }
}
