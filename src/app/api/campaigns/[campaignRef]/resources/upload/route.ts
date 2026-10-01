import { NextResponse } from "next/server";

import { addCampaignResourceUpload } from "@/server/campaigns/campaign-service";
import { newRequestId, resolveRequestActor, toCampaignsHttpResponse } from "@/server/campaigns/http";

type RouteParams = { params: Promise<{ campaignRef: string }> };

// POST /api/campaigns/[campaignRef]/resources/upload - findings #36/#37's
// real Upload resource type. multipart/form-data only (fields: label,
// description?, expectedVersion, file) - mirrors Discovery's own KYC
// attachment upload route exactly. Never a client-supplied url; the
// storage-returned link is computed server-side (resource-storage's
// canonical abstraction).
export async function POST(request: Request, { params }: RouteParams) {
  const { campaignRef } = await params;
  const actor = await resolveRequestActor();

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });

  const form = await request.formData();
  const file = form.get("file");
  const label = form.get("label");
  const description = form.get("description");
  const expectedVersion = form.get("expectedVersion");
  if (!(file instanceof File) || typeof label !== "string" || typeof expectedVersion !== "string" || !Number.isFinite(Number(expectedVersion))) {
    return NextResponse.json({ error: "Invalid upload payload." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await addCampaignResourceUpload(
    actor,
    campaignRef,
    {
      label,
      description: typeof description === "string" && description.trim() ? description : undefined,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      buffer,
      expectedVersion: Number(expectedVersion),
    },
    newRequestId(),
  );
  return toCampaignsHttpResponse(result, 201);
}
