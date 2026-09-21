import { describe, expect, it } from "vitest";

import { MAX_CONTRACT_PDF_BYTES } from "./contract-artifacts/validation";
import { CONTRACT_UPLOAD_MAX_REQUEST_BYTES, CONTRACT_UPLOAD_OVERHEAD_BYTES, readContractUploadRequest } from "./upload-request";

const URL = "http://localhost/api/finance/contracts/upload";
const pdfBytes = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(Buffer.from("%PDF-1.4\n"));
  return bytes;
};

function formRequest(fields: { file?: Uint8Array; name?: string; type?: string; ref?: string }, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  if (fields.file) form.set("file", new File([fields.file as BlobPart], fields.name ?? "c.pdf", { type: "application/pdf" }));
  form.set("counterpartyType", fields.type ?? "PARTNER");
  if (fields.ref !== undefined) form.set("counterpartyRef", fields.ref);
  return new Request(URL, { method: "POST", body: form, headers });
}

describe("readContractUploadRequest", () => {
  it("the request cap is the file limit plus a bounded multipart allowance", () => {
    expect(CONTRACT_UPLOAD_OVERHEAD_BYTES).toBeGreaterThan(0);
    expect(CONTRACT_UPLOAD_MAX_REQUEST_BYTES).toBe(MAX_CONTRACT_PDF_BYTES + CONTRACT_UPLOAD_OVERHEAD_BYTES);
  });

  it("parses a multipart upload into the service input (bytes intact, fields passed through untouched)", async () => {
    const bytes = pdfBytes(4096);
    const result = await readContractUploadRequest(formRequest({ file: bytes, name: "Agreement.pdf", ref: "ref-1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.fileName).toBe("Agreement.pdf");
    expect(result.input.counterparty).toEqual({ type: "PARTNER", ref: "ref-1" });
    expect(Buffer.from(result.input.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a file of exactly the 10 MB limit fits inside the request cap (the framing never pushes a legal upload over it)", async () => {
    const result = await readContractUploadRequest(formRequest({ file: pdfBytes(MAX_CONTRACT_PDF_BYTES), ref: "ref-1" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.bytes.byteLength).toBe(MAX_CONTRACT_PDF_BYTES);
  });

  it("415 for anything that is not multipart/form-data", async () => {
    for (const type of ["application/json", "application/x-www-form-urlencoded", "text/plain", "multipart/mixed", ""]) {
      const request = new Request(URL, { method: "POST", body: "x", headers: type ? { "content-type": type } : {} });
      expect(await readContractUploadRequest(request), type).toMatchObject({ ok: false, status: 415 });
    }
  });

  it("413 by declared Content-Length before the body is read; 400 for an unparseable length", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { pulled += 1; } }, { highWaterMark: 0 });
    const declared = await readContractUploadRequest(new Request(URL, { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(CONTRACT_UPLOAD_MAX_REQUEST_BYTES + 1) } } as RequestInit));
    expect(declared).toMatchObject({ ok: false, status: 413 });
    expect(pulled).toBe(0);

    const atCap = await readContractUploadRequest(formRequest({ file: pdfBytes(1024), ref: "r" }, { "content-length": String(CONTRACT_UPLOAD_MAX_REQUEST_BYTES) }));
    expect(atCap.ok).toBe(true);

    for (const length of ["lots", "-5", "1e9", "12 ", ""]) {
      const request = new Request(URL, { method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": length } });
      // an empty header value is treated like an absent one by the Headers API in some runtimes; anything else must be refused
      const result = await readContractUploadRequest(request);
      if (length !== "") expect(result, length).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("413 by actual size when no length is declared, and the reader stops early (a streaming body over the cap is never buffered whole)", async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sent += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (sent > 50) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const result = await readContractUploadRequest(new Request(URL, { method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=x" } } as RequestInit));
    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(sent).toBeLessThan(15);
  });

  it("400 for a body the proxy truncated (an unterminated multipart), an empty body, garbage, and missing / mistyped fields", async () => {
    // Simulates Next's proxy body buffer cutting a multipart short: the closing boundary is gone.
    const request = formRequest({ file: pdfBytes(20_000), ref: "r" });
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const truncated = new Request(URL, { method: "POST", body: bytes.slice(0, bytes.length - 200), headers: { "content-type": request.headers.get("content-type")! } });
    expect(await readContractUploadRequest(truncated)).toMatchObject({ ok: false, status: 400 });

    expect(await readContractUploadRequest(new Request(URL, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x" } }))).toMatchObject({ ok: false, status: 400 });
    expect(await readContractUploadRequest(new Request(URL, { method: "POST", body: "not multipart", headers: { "content-type": "multipart/form-data; boundary=x" } }))).toMatchObject({ ok: false, status: 400 });
    expect(await readContractUploadRequest(formRequest({ ref: "r" }))).toMatchObject({ ok: false, status: 400 }); // no file
    expect(await readContractUploadRequest(formRequest({ file: pdfBytes(10) }))).toMatchObject({ ok: false, status: 400 }); // no counterpartyRef
    const textFile = new FormData();
    textFile.set("file", "%PDF-1.4");
    textFile.set("counterpartyType", "PARTNER");
    textFile.set("counterpartyRef", "r");
    expect(await readContractUploadRequest(new Request(URL, { method: "POST", body: textFile }))).toMatchObject({ ok: false, status: 400 });
  });
});
