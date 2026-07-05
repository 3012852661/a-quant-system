import { NextRequest, NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../lib/access-control";
import { getAutopilotState, isPublicReadOnly, runAutopilotCycle, updateAutopilotSettings } from "../../../lib/local-data";

export const dynamic = "force-dynamic";

export async function GET() {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  return NextResponse.json(getAutopilotState());
}

export async function POST(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json(
      { ok: false, detail: "公开部署为只读模式，禁止运行自动交易" },
      { status: 403 },
    );
  }
  const payload = await request.json().catch(() => ({}));
  return NextResponse.json(runAutopilotCycle({ execute: Boolean(payload.execute) }));
}

export async function PATCH(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json(
      { ok: false, detail: "公开部署为只读模式，禁止修改自动交易设置" },
      { status: 403 },
    );
  }
  const payload = await request.json().catch(() => ({}));
  return NextResponse.json(updateAutopilotSettings(payload));
}
