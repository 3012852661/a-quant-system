import { NextResponse } from "next/server";
import { requireAllowedUserResponse } from "../../../lib/access-control";
import { getWorkbenchSnapshot } from "../../../lib/local-data";

export const dynamic = "force-dynamic";

export async function GET() {
  const blocked = await requireAllowedUserResponse();
  if (blocked) return blocked;
  return NextResponse.json(getWorkbenchSnapshot());
}
