import { MAX_CONTRACT_PDF_BYTES } from "./contract-artifacts/validation";

// Step 14A: reads and bounds the multipart body of POST /api/finance/contracts/upload. This is the
// HTTP-layer half of the size defence (the service re-validates the PDF's own bytes: <= 10 MB, %PDF-
// magic): a request whose declared or actual body exceeds the cap is refused BEFORE it is parsed
// into a File, so an oversized upload never costs more than the cap in memory.
//
// SIZE CONTRACT (see next.config.ts): src/proxy.ts matches /api/*, so Next buffers every API request
// body and TRUNCATES it at experimental.proxyClientMaxBodySize (10 MB default) without failing the
// request. A 10 MB PDF plus multipart framing is slightly above that default, so the config raises the
// proxy buffer to 11 MB. This cap (10 MB + 64 KB of multipart overhead) must stay BELOW that value:
// a body the proxy would truncate is a body this module already rejected.
export const CONTRACT_UPLOAD_OVERHEAD_BYTES = 64 * 1024;
export const CONTRACT_UPLOAD_MAX_REQUEST_BYTES = MAX_CONTRACT_PDF_BYTES + CONTRACT_UPLOAD_OVERHEAD_BYTES;

export type ContractUploadRequest =
  | { ok: true; input: { fileName: string; bytes: Uint8Array; counterparty: { type: string; ref: string } } }
  | { ok: false; status: 400 | 413 | 415; error: string };

const refuse = (status: 400 | 413 | 415, error: string): ContractUploadRequest => ({ ok: false, status, error });

// Reads the request body up to the cap. Returns null when the stream exceeds it (the reader is
// cancelled, nothing beyond the cap is retained).
async function readBoundedBody(request: Request): Promise<Uint8Array | null | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CONTRACT_UPLOAD_MAX_REQUEST_BYTES) {
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

// multipart/form-data with fields: file (the PDF), counterpartyType (PARTNER | VENDOR), counterpartyRef.
// The values are handed to the service as-is - it validates the counterparty and the PDF itself.
export async function readContractUploadRequest(request: Request): Promise<ContractUploadRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) return refuse(415, "Upload the contract as multipart/form-data.");

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared)) return refuse(400, "Invalid Content-Length.");
    if (Number(declared) > CONTRACT_UPLOAD_MAX_REQUEST_BYTES) return refuse(413, "The upload is larger than the 10 MB contract limit.");
  }

  const body = await readBoundedBody(request);
  if (body === null) return refuse(413, "The upload is larger than the 10 MB contract limit.");
  if (body === undefined || body.byteLength === 0) return refuse(400, "Invalid upload payload.");

  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refuse(400, "Invalid upload payload.");
  }

  const file = form.get("file");
  const counterpartyType = form.get("counterpartyType");
  const counterpartyRef = form.get("counterpartyRef");
  if (!(file instanceof File) || typeof counterpartyType !== "string" || typeof counterpartyRef !== "string") return refuse(400, "Invalid upload payload.");

  return { ok: true, input: { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), counterparty: { type: counterpartyType, ref: counterpartyRef } } };
}
