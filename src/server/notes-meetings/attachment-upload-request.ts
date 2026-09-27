import { MAX_ATTACHMENT_BYTES } from "./types";

// Notes/Meetings Completion: reads and bounds the multipart body of an attachment upload. Mirrors
// src/server/finance-agreements/upload-request.ts's own readBoundedMultipart exactly (same size-
// contract discipline against next.config.ts's experimental.proxyClientMaxBodySize).
export const ATTACHMENT_UPLOAD_OVERHEAD_BYTES = 64 * 1024;
export const ATTACHMENT_UPLOAD_MAX_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + ATTACHMENT_UPLOAD_OVERHEAD_BYTES;

export type AttachmentUploadRequest = { ok: true; input: { fileName: string; mimeType: string; bytes: Uint8Array } } | { ok: false; status: 400 | 413 | 415; error: string };

const refuse = (status: 400 | 413 | 415, error: string): { ok: false; status: 400 | 413 | 415; error: string } => ({ ok: false, status, error });

async function readBoundedBody(request: Request): Promise<Uint8Array | null | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > ATTACHMENT_UPLOAD_MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readAttachmentUploadRequest(request: Request): Promise<AttachmentUploadRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) return refuse(415, "Upload the attachment as multipart/form-data.");

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared)) return refuse(400, "Invalid Content-Length.");
    if (Number(declared) > ATTACHMENT_UPLOAD_MAX_REQUEST_BYTES) return refuse(413, "The attachment is larger than the allowed limit.");
  }

  const body = await readBoundedBody(request);
  if (body === null) return refuse(413, "The attachment is larger than the allowed limit.");
  if (body === undefined || body.byteLength === 0) return refuse(400, "Invalid upload payload.");

  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refuse(400, "Invalid upload payload.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return refuse(400, "Invalid upload payload.");
  return { ok: true, input: { fileName: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) } };
}
