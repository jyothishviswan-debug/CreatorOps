import { describe, expect, it, vi } from "vitest";

// A parser that never settles: proves the timeout guard, deterministically.
vi.mock("unpdf", () => ({
  getDocumentProxy: () => new Promise(() => undefined),
  extractText: () => new Promise(() => undefined),
}));

import { extractPdfText } from "./pdf-text";

describe("extractPdfText timeout guard", () => {
  it("returns timeout (never hangs, never throws) when the parser does not settle", async () => {
    const started = Date.now();
    const result = await extractPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { timeoutMs: 50 });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
