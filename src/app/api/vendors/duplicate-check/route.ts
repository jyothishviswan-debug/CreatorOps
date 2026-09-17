import { NextResponse } from "next/server";

import { checkForVendorDuplicates } from "@/server/vendors/duplicate-check";
import { parseJsonBody, resolveRequestActor } from "@/server/vendors/http";
import { requireVendorsFeatureAccess } from "@/server/vendors/vendors-gate";

// POST /api/vendors/duplicate-check - pre-create, read-only, advisory.
// No Vendor exists yet, so nothing is persisted - same idiom as
// Partners'/Discovery's own pre-create duplicate-check endpoints.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const gate = await requireVendorsFeatureAccess(actor);
  if (!gate.ok) {
    const status = gate.reason === "not_authenticated" ? 401 : 403;
    return NextResponse.json({ error: "Forbidden." }, { status });
  }

  const body = await parseJsonBody(request);
  if (body === undefined || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const input = body as Record<string, unknown>;

  const displayName = typeof input.displayName === "string" ? input.displayName : undefined;
  const email = typeof input.email === "string" ? input.email : undefined;
  const phone = typeof input.phone === "string" ? input.phone : undefined;

  if (!displayName && !email && !phone) {
    return NextResponse.json({ error: "At least one of displayName, email, or phone is required." }, { status: 400 });
  }

  const result = await checkForVendorDuplicates({ displayName, email, phone });
  return NextResponse.json(result, { status: 200 });
}
