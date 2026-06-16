import { NextResponse } from "next/server";
import { getTradingState } from "../../../lib/local-data";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getTradingState());
}
