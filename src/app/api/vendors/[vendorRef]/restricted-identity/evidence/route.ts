import { NextResponse } from "next/server";

import { addVendorRestrictedIdentityLinkEvidence, addVendorRestrictedIdentityUploadEvidence } from "@/server/vendors/restricted-identity-service";
import { newRequestId, resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ vendorRef: string }> };

// POST /api/vendors/[vendorRef]/restricted-identity/evidence - restricted,
// gated by the same manage_vendor_restricted_identity + vendor_payment_details
// sensitive-access requirement as the rest of the restricted identity.
// Mirrors Discovery's own KYC attachments route exactly.
//
// Two request shapes, dispatched on Content-Type:
// - application/json {docType, url, expectedVersion} - a link evidence
//   entry, no Drive involved.
// - multipart/form-data (fields: docType, expectedVersion, file) - a
//   real upload into this Vendor's own Drive subfolder.
export async function POST(request: Request, { params }: RouteParams) {
  const { vendorRef } = await params;
  const actor = await resolveRequestActor();
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const docType = form.get("docType");
    const expectedVersion = form.get("expectedVersion");
    if (!(file instanceof File) || typeof docType !== "string" || typeof expectedVersion !== "string" || !Number.isFinite(Number(expectedVersion))) {
      return NextResponse.json({ error: "Invalid upload payload." }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await addVendorRestrictedIdentityUploadEvidence(
      actor,
      vendorRef,
      { docType, fileName: file.name, mimeType: file.type || "application/octet-stream", buffer, expectedVersion: Number(expectedVersion) },
      newRequestId(),
    );
    return toVendorsHttpResponse(result);
  }

  const body = await request.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await addVendorRestrictedIdentityLinkEvidence(actor, vendorRef, body, newRequestId());
  return toVendorsHttpResponse(result);
}
