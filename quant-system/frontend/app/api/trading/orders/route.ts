import { NextRequest, NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../../lib/access-control";
import { isPublicReadOnly, placeOrder } from "../../../../lib/local-data";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  if (isPublicReadOnly()) {
    return NextResponse.json(
      { ok: false, detail: "公开部署为只读模式，禁止提交委托" },
      { status: 403 },
    );
  }
  const payload = await request.json();
  return NextResponse.json(
    placeOrder({
      side: payload.side,
      code: String(payload.code || ""),
      name: payload.name,
      quantity: Number(payload.quantity || 0),
      price: payload.price === undefined ? undefined : Number(payload.price),
      dryRun: Boolean(payload.dryRun),
    }),
  );
}
