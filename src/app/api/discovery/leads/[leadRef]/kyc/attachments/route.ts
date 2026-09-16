import { NextResponse } from "next/server";

import { addKycLinkAttachment, addKycUploadAttachment } from "@/server/discovery/kyc-service";
import { newRequestId, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// POST /api/discovery/leads/[leadRef]/kyc/attachments - restricted,
// gated by the same manage_kyc + discovery_kyc sensitive-access
// requirement as the rest of the KYC package.
//
// Two request shapes, dispatched on Content-Type:
// - application/json {docType, url, expectedKycVersion} - a link
//   attachment, no Drive involved.
// - multipart/form-data (fields: docType, expectedKycVersion, file) - a
//   real upload into the Lead's own Drive subfolder.
export async function POST(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const docType = form.get("docType");
    const expectedKycVersion = form.get("expectedKycVersion");
    if (!(file instanceof File) || typeof docType !== "string" || typeof expectedKycVersion !== "string" || !Number.isFinite(Number(expectedKycVersion))) {
      return NextResponse.json({ error: "Invalid upload payload." }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await addKycUploadAttachment(
      actor,
      leadRef,
      { docType, fileName: file.name, mimeType: file.type || "application/octet-stream", buffer, expectedKycVersion: Number(expectedKycVersion) },
      newRequestId(),
    );
    return toDiscoveryHttpResponse(result);
  }

  const body = await request.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await addKycLinkAttachment(actor, leadRef, body, newRequestId());
  return toDiscoveryHttpResponse(result);
}
