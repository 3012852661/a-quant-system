import { NextResponse } from "next/server";
import { getWorkbenchSnapshot } from "../../../lib/local-data";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getWorkbenchSnapshot());
}
