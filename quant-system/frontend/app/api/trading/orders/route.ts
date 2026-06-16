import { NextRequest, NextResponse } from "next/server";
import { placeOrder } from "../../../../lib/local-data";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
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
