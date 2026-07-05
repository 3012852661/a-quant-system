import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { canManageSystemSettings, effectiveAllowedEmails } from "./system-settings";

export async function getAuthorizedUser() {
  const user = await currentUser();
  if (!user) {
    return { ok: false as const, status: 401, detail: "请先登录后再使用系统", user: null, email: "" };
  }

  const email = String(user.primaryEmailAddress?.emailAddress || "").toLowerCase();
  const allowedEmails = await effectiveAllowedEmails();
  if (allowedEmails.length && !allowedEmails.includes(email)) {
    return { ok: false as const, status: 403, detail: "当前账号不在系统白名单中", user, email };
  }

  return { ok: true as const, status: 200, detail: "ok", user, email };
}

export async function requireAllowedUserResponse() {
  const access = await getAuthorizedUser();
  if (access.ok) return null;
  return NextResponse.json({ ok: false, detail: access.detail }, { status: access.status });
}

export async function requireSettingsAdminResponse() {
  const access = await getAuthorizedUser();
  if (!access.ok) {
    return { access, response: NextResponse.json({ ok: false, detail: access.detail }, { status: access.status }) };
  }
  if (!canManageSystemSettings(access.email)) {
    return {
      access,
      response: NextResponse.json({ ok: false, detail: "只有系统管理员可以修改账号访问名单" }, { status: 403 }),
    };
  }
  return { access, response: null };
}

export async function requireAllowedPage() {
  const access = await getAuthorizedUser();
  if (access.ok) return access;
  if (access.status === 401) redirect("/sign-in");
  redirect("/unauthorized");
}
