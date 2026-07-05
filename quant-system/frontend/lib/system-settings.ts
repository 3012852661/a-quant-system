import fs from "node:fs";
import path from "node:path";
import { clerkClient } from "@clerk/nextjs/server";
import { isPublicReadOnly } from "./local-data";

export type SystemSettings = {
  allowedEmails: string[];
  updatedAt?: string;
  updatedBy?: string;
};

export type AllowedEmailEntry = {
  email: string;
  source: "环境变量" | "系统设置" | "Clerk 白名单";
  removable: boolean;
  id?: string;
};

const repoRoot = path.resolve(process.cwd(), "../..");
const settingsPath = path.join(repoRoot, "reports/data/system-settings.json");

export function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function configuredAllowedEmails() {
  return String(process.env.CLERK_ALLOWED_EMAILS || process.env.AUTH_ALLOWED_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

export function readSystemSettings(): SystemSettings {
  try {
    const payload = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return {
      allowedEmails: Array.isArray(payload.allowedEmails)
        ? Array.from(new Set(payload.allowedEmails.map(normalizeEmail).filter(Boolean)))
        : [],
      updatedAt: payload.updatedAt,
      updatedBy: payload.updatedBy,
    };
  } catch {
    return { allowedEmails: [] };
  }
}

export async function readClerkAllowlist() {
  try {
    const client = await clerkClient();
    const response = await client.allowlistIdentifiers.getAllowlistIdentifierList({ limit: 500 });
    return response.data
      .filter((item) => item.identifierType === "email_address")
      .map((item) => ({
        id: item.id,
        email: normalizeEmail(item.identifier),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      }))
      .filter((item) => item.email);
  } catch {
    return [];
  }
}

export async function effectiveAllowedEmails() {
  const settings = readSystemSettings();
  const clerkEmails = (await readClerkAllowlist()).map((item) => item.email);
  return Array.from(new Set([...configuredAllowedEmails(), ...settings.allowedEmails, normalizeEmail(settings.updatedBy), ...clerkEmails].filter(Boolean)));
}

export async function allowedEmailEntries() {
  const envEmails = configuredAllowedEmails();
  const settings = readSystemSettings();
  const localSet = new Set(settings.allowedEmails);
  const clerkRows = await readClerkAllowlist();
  const clerkByEmail = new Map(clerkRows.map((item) => [item.email, item]));
  const emails = await effectiveAllowedEmails();
  return emails.map<AllowedEmailEntry>((email) => {
    const clerkRow = clerkByEmail.get(email);
    if (envEmails.includes(email)) return { email, source: "环境变量", removable: Boolean(clerkRow || localSet.has(email)), id: clerkRow?.id };
    if (clerkRow) return { email, source: "Clerk 白名单", removable: true, id: clerkRow.id };
    return { email, source: "系统设置", removable: localSet.has(email) };
  });
}

export function canManageSystemSettings(email: string) {
  const normalized = normalizeEmail(email);
  const envEmails = configuredAllowedEmails();
  if (!envEmails.length) return Boolean(normalized);
  return envEmails.includes(normalized);
}

export function writeSystemSettings(settings: SystemSettings) {
  if (isPublicReadOnly()) {
    throw new Error("公开部署为只读模式，不能在线修改系统设置");
  }
  const payload: SystemSettings = {
    ...settings,
    allowedEmails: Array.from(new Set(settings.allowedEmails.map(normalizeEmail).filter(Boolean))).sort(),
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmpPath = path.join(path.dirname(settingsPath), `.${path.basename(settingsPath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, settingsPath);
  return payload;
}

export async function addAllowedEmail(email: string, updatedBy: string) {
  const normalized = normalizeEmail(email);
  if (isPublicReadOnly()) {
    const existing = await readClerkAllowlist();
    if (!existing.some((item) => item.email === normalized)) {
      const client = await clerkClient();
      await client.allowlistIdentifiers.createAllowlistIdentifier({ identifier: normalized, notify: false });
    }
    return;
  }

  const settings = readSystemSettings();
  writeSystemSettings({
    allowedEmails: [...settings.allowedEmails, normalized, normalizeEmail(updatedBy)],
    updatedAt: new Date().toISOString(),
    updatedBy,
  });
}

export async function removeAllowedEmail(email: string, updatedBy: string) {
  const normalized = normalizeEmail(email);
  const clerkRow = (await readClerkAllowlist()).find((item) => item.email === normalized);
  if (clerkRow) {
    const client = await clerkClient();
    await client.allowlistIdentifiers.deleteAllowlistIdentifier(clerkRow.id);
  }

  if (!isPublicReadOnly()) {
    const settings = readSystemSettings();
    writeSystemSettings({
      allowedEmails: settings.allowedEmails.filter((item) => normalizeEmail(item) !== normalized),
      updatedAt: new Date().toISOString(),
      updatedBy,
    });
  }
}
