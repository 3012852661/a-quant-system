"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, RotateCw, Send, ShieldCheck, ShieldAlert, WalletCards } from "lucide-react";

type Position = {
  code: string;
  name: string;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  marketValue: number;
  unrealizedPct: number;
};

type Order = {
  id: number;
  side: "BUY" | "SELL";
  code: string;
  name: string;
  quantity: number;
  price: number | null;
  status: string;
  dryRun: boolean;
  reasons: string[];
  kbWarnings?: string[];
  kbReferences?: Array<{ title?: string; status?: string; path?: string; rule?: string }>;
};

type TradeCandidate = {
  code?: string;
  name?: string;
  current_price?: number;
  price?: number;
  pct_chg?: number;
  pct?: number;
  score?: number;
  risk_level?: string;
  buy_zone?: string;
  stop_loss?: number;
  target_price?: number;
  entry?: { buyZone?: string };
  exit?: { target?: number; stop?: number };
  sizing?: { hint?: string };
};

type TradingState = {
  mode: string;
  cash: number;
  equity: number;
  positions: Position[];
  orders: Order[];
  trades: Order[];
  risk?: {
    status: "OK" | "WARN" | "BLOCK" | string;
    exposurePct: number;
    largestPositionPct: number;
    positionCount: number;
    cashPct: number;
    policy: {
      maxPositionPct: number;
      maxTotalExposurePct: number;
      maxPositions: number;
      maxOrderPct: number;
      maxPriceDeviationPct: number;
      stopLossPct: number;
    };
    warnings: Array<{ severity: string; message: string }>;
  };
};

const emptyState: TradingState = {
  mode: "PAPER",
  cash: 0,
  equity: 0,
  positions: [],
  orders: [],
  trades: [],
  risk: undefined,
};

function apiBase() {
  return process.env.NEXT_PUBLIC_API_BASE || "";
}

function money(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-";
}

function pct(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "-";
}

function statusText(status: string) {
  return {
    FILLED: "已成交",
    CHECKED: "预检通过",
    REJECTED: "已拒绝",
  }[status] || status;
}

function riskClass(status?: string) {
  if (status === "OK") return "good";
  if (status === "BLOCK") return "danger";
  return "warn";
}

function normalizeCode(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  return digits ? digits.padStart(6, "0") : "";
}

function candidatePrice(item?: TradeCandidate) {
  return Number(item?.current_price ?? item?.price ?? 0);
}

export function TradingDesk({ candidates = [] }: { candidates?: TradeCandidate[] }) {
  const [state, setState] = useState<TradingState>(emptyState);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("100");
  const [price, setPrice] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const normalizedCode = normalizeCode(code);
  const selectedPosition = useMemo(() => state.positions.find((item) => item.code === normalizedCode), [normalizedCode, state.positions]);
  const selectedCandidate = useMemo(
    () => candidates.find((item) => normalizeCode(String(item.code || "")) === normalizedCode),
    [candidates, normalizedCode],
  );
  const orderPrice = Number(price || candidatePrice(selectedCandidate) || selectedPosition?.lastPrice || 0);
  const orderQuantity = Number(quantity);
  const orderAmount = Number.isFinite(orderPrice * orderQuantity) ? orderPrice * orderQuantity : 0;
  const inputWarnings = [
    !normalizedCode ? "请输入6位股票代码" : "",
    Number.isFinite(orderQuantity) && orderQuantity > 0 && orderQuantity % 100 === 0 ? "" : "数量需为100股整数倍",
    side === "SELL" && !selectedPosition ? "卖出需先选择已有持仓" : "",
  ].filter(Boolean);

  async function load() {
    const response = await fetch(`${apiBase()}/api/trading`, { cache: "no-store" });
    if (response.ok) setState(await response.json());
  }

  useEffect(() => {
    load().catch(() => setMessage("交易状态加载失败"));
  }, []);

  function fillCandidate(item: TradeCandidate) {
    const nextCode = normalizeCode(String(item.code || ""));
    setSide("BUY");
    setCode(nextCode);
    setName(item.name || "");
    const nextPrice = candidatePrice(item);
    setPrice(nextPrice ? nextPrice.toFixed(2) : "");
    setMessage("");
    return {
      code: nextCode,
      name: item.name || "",
      price: nextPrice,
    };
  }

  function applyCandidate(item: TradeCandidate) {
    fillCandidate(item);
  }

  function applyPosition(item: Position) {
    setSide("SELL");
    setCode(item.code);
    setName(item.name);
    setQuantity(String(Math.max(100, Math.floor(item.quantity / 100) * 100)));
    setPrice(item.lastPrice ? item.lastPrice.toFixed(2) : "");
    setMessage("");
  }

  async function submit(dryRun: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBase()}/api/trading/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side,
          code,
          name: name || undefined,
          quantity: Number(quantity),
          price: price ? Number(price) : undefined,
          dryRun,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "提交失败");
      setState(payload.state);
      const reasons = payload.order?.reasons || [];
      const kbWarnings = payload.order?.kbWarnings || [];
      setMessage([reasons.length ? reasons.join("；") : statusText(payload.order.status), ...kbWarnings.slice(0, 2)].join("；"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitCandidate(item: TradeCandidate, dryRun: boolean) {
    const next = fillCandidate(item);
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`${apiBase()}/api/trading/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side: "BUY",
          code: next.code,
          name: next.name || undefined,
          quantity: Number(quantity),
          price: next.price || undefined,
          dryRun,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "提交失败");
      setState(payload.state);
      const reasons = payload.order?.reasons || [];
      const kbWarnings = payload.order?.kbWarnings || [];
      setMessage([reasons.length ? reasons.join("；") : statusText(payload.order.status), ...kbWarnings.slice(0, 2)].join("；"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tradeConsole">
      <div className="accountStrip">
        <div>
          <span>账户模式</span>
          <strong>{state.mode}</strong>
        </div>
        <div>
          <span>现金</span>
          <strong>{money(state.cash)}</strong>
        </div>
        <div>
          <span>权益</span>
          <strong>{money(state.equity)}</strong>
        </div>
        <button className="iconButton" type="button" onClick={() => load()} aria-label="刷新交易账户">
          <RotateCw size={15} />
        </button>
        <div className="riskCard">
          <div className="riskTitle">
            <ShieldAlert size={15} />
            <span>组合风控</span>
            <strong className={riskClass(state.risk?.status)}>{state.risk?.status || "-"}</strong>
          </div>
          <div className="riskMetrics">
            <span>
              总仓位
              <b>{pct(state.risk?.exposurePct)}</b>
            </span>
            <span>
              单票
              <b>{pct(state.risk?.largestPositionPct)}</b>
            </span>
            <span>
              持仓
              <b>
                {state.risk?.positionCount ?? 0}/{state.risk?.policy.maxPositions ?? "-"}
              </b>
            </span>
          </div>
          <div className="riskWarnings">
            {(state.risk?.warnings || []).slice(0, 2).map((item) => (
              <p key={item.message}>{item.message}</p>
            ))}
            {!(state.risk?.warnings || []).length && <p>风险参数正常</p>}
          </div>
        </div>
      </div>

      <div className="ticket">
        <div className="ticketHead">
          <div>
            <span className="eyebrow">Order Ticket</span>
            <strong>{side === "BUY" ? "买入预检" : "卖出委托"}</strong>
          </div>
          <span className={`miniBadge ${inputWarnings.length ? "warn" : "good"}`}>{inputWarnings.length ? "待校验" : "就绪"}</span>
        </div>
        <div className="segmented">
          <button className={side === "BUY" ? "selected" : ""} type="button" onClick={() => setSide("BUY")}>
            买入
          </button>
          <button className={side === "SELL" ? "selected" : ""} type="button" onClick={() => setSide("SELL")}>
            卖出
          </button>
        </div>
        <label>
          代码
          <input value={code} onBlur={() => setCode(normalizeCode(code))} onChange={(event) => setCode(event.target.value)} placeholder="600522" />
        </label>
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={selectedPosition?.name || "可空"} />
        </label>
        <label>
          数量
          <input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="numeric" />
        </label>
        <label>
          限价
          <input value={price} onChange={(event) => setPrice(event.target.value)} inputMode="decimal" placeholder="留空用最新价" />
        </label>
        <div className="orderPreview">
          <WalletCards size={15} />
          <span>预计金额</span>
          <strong>{money(orderAmount)}</strong>
          <small>{selectedCandidate?.entry?.buyZone || selectedCandidate?.buy_zone || selectedPosition?.name || "选择候选后自动带入参考价"}</small>
        </div>
        {inputWarnings.length > 0 && (
          <div className="inlineWarnings">
            {inputWarnings.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        )}
        <div className="ticketActions">
          <button className="secondaryButton" type="button" disabled={busy || inputWarnings.length > 0} onClick={() => submit(true)}>
            <ShieldCheck size={15} />
            风控预检
          </button>
          <button className="primaryButton" type="button" disabled={busy || inputWarnings.length > 0} onClick={() => submit(false)}>
            <Send size={15} />
            提交模拟单
          </button>
        </div>
        {message && <div className="tradeMessage">{message}</div>}
        {selectedCandidate && (
          <div className="kbHint">
            <strong>执行参考</strong>
            <span>{selectedCandidate.risk_level || "策略 KB"} · 先预检再提交，禁止绕过风控闸门</span>
          </div>
        )}
      </div>

      <div className="tradeTables">
        <div>
          <div className="miniHeader">
            当前持仓
            <ChevronDown size={14} />
          </div>
          <table className="denseTable tradeTable">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th>数量</th>
                <th>成本</th>
                <th>现价</th>
                <th>盈亏</th>
              </tr>
            </thead>
            <tbody>
              {state.positions.map((item) => (
                <tr key={item.code} onClick={() => applyPosition(item)}>
                  <td className="mono">{item.code}</td>
                  <td className="nameCell">{item.name}</td>
                  <td>{item.quantity}</td>
                  <td>{money(item.avgPrice)}</td>
                  <td>{money(item.lastPrice)}</td>
                  <td className={item.unrealizedPct >= 0 ? "up" : "down"}>{pct(item.unrealizedPct)}</td>
                </tr>
              ))}
              {!state.positions.length && (
                <tr>
                  <td colSpan={6} className="centerCell">
                    暂无持仓
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <div className="miniHeader">推荐快填</div>
          <div className="candidateList">
            {candidates.slice(0, 12).map((item, index) => (
              <div className="candidateAction" key={`${item.code}-${item.name}-${index}`}>
                <button type="button" onClick={() => applyCandidate(item)}>
                  <span className="mono">{normalizeCode(String(item.code || ""))}</span>
                  <strong>{item.name || "-"}</strong>
                  <small>
                    {money(candidatePrice(item))} / {pct(item.pct_chg ?? item.pct)}
                  </small>
                </button>
                <div>
                  <button type="button" disabled={busy} onClick={() => submitCandidate(item, true)}>预检</button>
                  <button type="button" disabled={busy} onClick={() => submitCandidate(item, false)}>模拟买入</button>
                </div>
              </div>
            ))}
            {!candidates.length && <div className="candidateEmpty">暂无推荐候选</div>}
          </div>
          <div className="miniHeader ordersHeader">最近委托</div>
          <table className="denseTable tradeTable">
            <thead>
              <tr>
                <th>方向</th>
                <th>代码</th>
                <th>数量</th>
                <th>价格</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {state.orders.slice(0, 8).map((item) => (
                <tr key={item.id}>
                  <td className={item.side === "BUY" ? "up" : "down"}>{item.side}</td>
                  <td className="mono">{item.code}</td>
                  <td>{item.quantity}</td>
                  <td>{money(item.price)}</td>
                  <td>
                    {statusText(item.status)}
                    {item.kbReferences?.length ? <small>KB {item.kbReferences.length}</small> : null}
                  </td>
                </tr>
              ))}
              {!state.orders.length && (
                <tr>
                  <td colSpan={5} className="centerCell">
                    暂无委托
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
