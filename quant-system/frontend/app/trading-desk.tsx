"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCw, Send, ShieldCheck, ShieldAlert } from "lucide-react";

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

export function TradingDesk() {
  const [state, setState] = useState<TradingState>(emptyState);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("100");
  const [price, setPrice] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedPosition = useMemo(
    () => state.positions.find((item) => item.code === code.padStart(6, "0")),
    [code, state.positions],
  );

  async function load() {
    const response = await fetch(`${apiBase()}/api/trading`, { cache: "no-store" });
    if (response.ok) setState(await response.json());
  }

  useEffect(() => {
    load().catch(() => setMessage("交易状态加载失败"));
  }, []);

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
      setMessage(reasons.length ? reasons.join("；") : statusText(payload.order.status));
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
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="600522" />
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
        <div className="ticketActions">
          <button className="secondaryButton" type="button" disabled={busy} onClick={() => submit(true)}>
            <ShieldCheck size={15} />
            风控预检
          </button>
          <button className="primaryButton" type="button" disabled={busy} onClick={() => submit(false)}>
            <Send size={15} />
            提交模拟单
          </button>
        </div>
        {message && <div className="tradeMessage">{message}</div>}
      </div>

      <div className="tradeTables">
        <div>
          <div className="miniHeader">当前持仓</div>
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
                <tr key={item.code}>
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
          <div className="miniHeader">最近委托</div>
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
                  <td>{statusText(item.status)}</td>
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
