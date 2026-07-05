"use client";

import { useEffect, useState } from "react";
import { Bot, Play, RotateCw, Send, ShieldAlert } from "lucide-react";

type AutoOrder = {
  code: string;
  name: string;
  price: number;
  pct: number;
  quantity: number;
  buyZone?: string;
  stopLoss?: number;
  targetPrice?: number;
  reasons?: string[];
};

type AutopilotState = {
  enabled?: boolean;
  mode?: string;
  lastRunAt?: string | null;
  preview?: {
    runAt?: string;
    status?: string;
    canExecute?: boolean;
    blockers?: string[];
    plannedOrders?: AutoOrder[];
    rejectedCandidates?: AutoOrder[];
    audit?: {
      status?: string;
      latestLiveTime?: string;
      overlapPct?: number;
    };
    knowledge?: {
      ready?: boolean;
      docs?: number;
      references?: Array<{ title?: string; status?: string; path?: string; rule?: string }>;
    };
  };
  latestRun?: AutopilotState["preview"];
};

function n(value: unknown, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : "-";
}

function pct(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? `${num.toFixed(2)}%` : "-";
}

function stateClass(status?: string) {
  if (status === "READY" || status === "EXECUTED") return "good";
  if (status === "BLOCKED") return "danger";
  return "warn";
}

export function AutopilotPanel() {
  const [state, setState] = useState<AutopilotState>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/autopilot", { cache: "no-store" });
    if (response.ok) setState(await response.json());
  }

  async function saveSettings(next: Partial<AutopilotState>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/autopilot", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "设置保存失败");
      setState(payload);
      setMessage("自动交易设置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "设置保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function runCycle(execute: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execute }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || (execute ? "自动交易执行失败" : "自动交易预检失败"));
      setState(payload);
      if (execute) {
        setMessage(payload.latestRun?.status === "EXECUTED" ? `已提交 ${payload.latestRun?.executedOrders?.length || 0} 笔模拟单` : "执行被风控阻塞");
      } else {
        setMessage(payload.latestRun?.status === "READY" ? "预检通过，可人工确认执行" : "预检已阻塞");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "自动交易请求失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load().catch(() => setMessage("自动交易状态加载失败"));
  }, []);

  const preview = state.latestRun || state.preview || {};
  const blockers = preview.blockers || [];
  const planned = preview.plannedOrders || [];
  const rejected = preview.rejectedCandidates || [];
  const kbReferences = preview.knowledge?.references || [];
  const canExecute = Boolean(state.enabled && state.mode === "PAPER_AUTO" && preview.canExecute && planned.length);

  return (
    <div className="autopilotPanel">
      <div className="autopilotHero">
        <div>
          <span className="eyebrow">Autopilot</span>
          <h3>自动交易驾驶舱</h3>
          <p>自动交易必须同时通过数据审计、投委会、组合风控、报价新鲜度和仓位限制。</p>
        </div>
        <div className={`autopilotState ${stateClass(preview.status)}`}>
          <span>{state.mode || "PAPER_ONLY"}</span>
          <strong>{preview.status || "UNKNOWN"}</strong>
        </div>
      </div>

      <div className="autopilotMetrics">
        <div>
          <span>总开关</span>
          <strong>{state.enabled ? "已开启" : "关闭"}</strong>
        </div>
        <div>
          <span>数据审计</span>
          <strong>{preview.audit?.status || "-"}</strong>
        </div>
        <div>
          <span>行情时间</span>
          <strong>{preview.audit?.latestLiveTime || "-"}</strong>
        </div>
        <div>
          <span>重合率</span>
          <strong>{n(preview.audit?.overlapPct, 1)}%</strong>
        </div>
        <div>
          <span>知识库</span>
          <strong>{preview.knowledge?.ready ? "已参考" : "未达标"}</strong>
        </div>
      </div>

      <div className="autopilotSettings">
        <label>
          <input
            type="checkbox"
            checked={Boolean(state.enabled)}
            onChange={(event) => saveSettings({ enabled: event.target.checked, mode: event.target.checked ? "PAPER_AUTO" : "PAPER_ONLY" })}
            disabled={busy}
          />
          总开关
        </label>
        <label>
          执行模式
          <select value={state.mode || "PAPER_ONLY"} onChange={(event) => saveSettings({ mode: event.target.value })} disabled={busy}>
            <option value="PAPER_ONLY">仅预检</option>
            <option value="PAPER_AUTO">允许模拟执行</option>
          </select>
        </label>
      </div>

      <div className="ticketActions autopilotActions">
        <button className="secondaryButton" type="button" onClick={() => load()} disabled={busy}>
          <RotateCw size={15} />
          刷新状态
        </button>
        <button className="secondaryButton" type="button" onClick={() => runCycle(false)} disabled={busy}>
          <Play size={15} />
          运行自动预检
        </button>
        <button className="primaryButton" type="button" onClick={() => runCycle(true)} disabled={busy || !canExecute}>
          <Send size={15} />
          确认提交模拟单
        </button>
      </div>
      {message && <div className="tradeMessage">{message}</div>}

      <div className="autopilotBlockers">
        <div className="miniHeader">
          <ShieldAlert size={15} />
          自动执行阻塞项
        </div>
        {blockers.length ? blockers.map((item) => <p key={item}>{item}</p>) : <p>暂无阻塞，仍需人工确认执行模式。</p>}
      </div>

      <div className="autopilotKb">
        <div className="miniHeader">
          <Bot size={15} />
          执行参考知识库
        </div>
        {kbReferences.length ? (
          kbReferences.slice(0, 5).map((item) => (
            <p key={`${item.path}-${item.title}`}>
              <strong>{item.title}</strong>
              <span>{item.status} · {item.rule}</span>
            </p>
          ))
        ) : (
          <p>暂无可引用知识条目，自动执行会被阻塞。</p>
        )}
      </div>

      <div className="tradeTables">
        <div>
          <div className="miniHeader">
            <Bot size={15} />
            计划自动单
          </div>
          <table className="denseTable tradeTable">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th>价格</th>
                <th>涨幅</th>
                <th>数量</th>
                <th>买区</th>
              </tr>
            </thead>
            <tbody>
              {planned.map((item) => (
                <tr key={item.code}>
                  <td className="mono">{item.code}</td>
                  <td className="nameCell">{item.name}</td>
                  <td>{n(item.price)}</td>
                  <td className="up">{pct(item.pct)}</td>
                  <td>{item.quantity}</td>
                  <td>{item.buyZone || "-"}</td>
                </tr>
              ))}
              {!planned.length && (
                <tr>
                  <td colSpan={6} className="centerCell">
                    当前没有可自动执行计划单
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <div className="miniHeader">前排被拦截候选</div>
          <table className="denseTable tradeTable">
            <thead>
              <tr>
                <th>代码</th>
                <th>名称</th>
                <th>价格</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {rejected.slice(0, 8).map((item) => (
                <tr key={item.code}>
                  <td className="mono">{item.code}</td>
                  <td className="nameCell">{item.name}</td>
                  <td>{n(item.price)}</td>
                  <td className="reasonCell">{item.reasons?.slice(0, 3).join("；") || "-"}</td>
                </tr>
              ))}
              {!rejected.length && (
                <tr>
                  <td colSpan={4} className="centerCell">
                    暂无拦截候选
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
