"use client";

import { FormEvent, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

type AllowedEmail = {
  email: string;
  source: string;
  removable: boolean;
};

type SettingsPayload = {
  ok: boolean;
  canManage: boolean;
  currentEmail: string;
  allowedEmails: AllowedEmail[];
  updatedAt: string | null;
  updatedBy: string | null;
  detail?: string;
};

export function AccessSettingsPanel() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadSettings() {
    const response = await fetch("/api/system-settings", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "读取系统设置失败");
    setPayload(data);
  }

  useEffect(() => {
    loadSettings().catch((error) => setMessage(error instanceof Error ? error.message : "读取系统设置失败"));
  }, []);

  async function save(nextEmail: string, action: "add" | "remove") {
    setSaving(true);
    setMessage(action === "add" ? "正在添加账号" : "正在移除账号");
    try {
      const response = await fetch("/api/system-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: nextEmail, action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "保存失败");
      setPayload(data);
      setEmail("");
      setMessage(action === "add" ? "账号已加入访问名单" : "账号已移除");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save(email, "add");
  }

  const rows = payload?.allowedEmails || [];

  return (
    <section className="productPanel settingsPanel">
      <div className="sectionPanelHead">
        <div>
          <h2>账号访问</h2>
          <p>添加邮箱后，对方用该邮箱登录即可访问系统，不需要重新发版。</p>
        </div>
        {payload?.updatedAt && <span>最近修改 {new Date(payload.updatedAt).toLocaleString("zh-CN", { hour12: false })}</span>}
      </div>

      <form className="settingsInlineForm" onSubmit={submit}>
        <label>
          <span>邮箱</span>
          <input
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={saving}
          />
        </label>
        <button type="submit" disabled={saving || !email.trim()}>
          <Plus size={15} />
          添加账号
        </button>
      </form>

      <div className="settingsTable">
        <div className="settingsTableHead">
          <span>邮箱</span>
          <span>来源</span>
          <span>操作</span>
        </div>
        {rows.map((row) => (
          <div className="settingsTableRow" key={row.email}>
            <strong>{row.email}</strong>
            <span>{row.source}</span>
            <button type="button" disabled={saving || !row.removable} onClick={() => save(row.email, "remove")}>
              <Trash2 size={14} />
              {row.removable ? "移除" : "固定"}
            </button>
          </div>
        ))}
        {!rows.length && <div className="settingsEmpty">当前没有限制名单；任何完成登录的账号都可访问。</div>}
      </div>

      {message && <p className="settingsMessage">{message}</p>}
      {payload?.updatedBy && <p className="settingsMeta">上次操作人：{payload.updatedBy}</p>}
    </section>
  );
}
