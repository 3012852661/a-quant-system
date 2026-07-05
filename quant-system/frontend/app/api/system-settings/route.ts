import { NextResponse } from "next/server";
import { requireSettingsAdminResponse } from "../../../lib/access-control";
import {
  addAllowedEmail,
  allowedEmailEntries,
  canManageSystemSettings,
  normalizeEmail,
  readSystemSettings,
  removeAllowedEmail,
} from "../../../lib/system-settings";

export const dynamic = "force-dynamic";

async function settingsPayload(email: string) {
  const stored = readSystemSettings();
  return {
    ok: true,
    canManage: canManageSystemSettings(email),
    currentEmail: email,
    allowedEmails: await allowedEmailEntries(),
    updatedAt: stored.updatedAt || null,
    updatedBy: stored.updatedBy || null,
  };
}

export async function GET() {
  const { access, response } = await requireSettingsAdminResponse();
  if (response) return response;
  return NextResponse.json(await settingsPayload(access.email));
}

export async function POST(request: Request) {
  const { access, response } = await requireSettingsAdminResponse();
  if (response) return response;

  try {
    const body = await request.json();
    const action = String(body.action || "add");
    const email = normalizeEmail(body.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ ok: false, detail: "请输入有效邮箱" }, { status: 400 });
    }

    if (action === "remove") {
      if (email === access.email) {
        return NextResponse.json({ ok: false, detail: "不能移除当前登录账号，避免把自己锁在系统外" }, { status: 400 });
      }
      await removeAllowedEmail(email, access.email);
    } else {
      await addAllowedEmail(email, access.email);
    }
    await addAllowedEmail(access.email, access.email);

    return NextResponse.json(await settingsPayload(access.email));
  } catch (error) {
    return NextResponse.json(
      { ok: false, detail: error instanceof Error ? error.message : "系统设置保存失败" },
      { status: 500 },
    );
  }
}
