import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { INVOICE_EXTRACTED_FIELD_KEYS, RESTRICTED_INVOICE_EXTRACTED_FIELD_KEYS } from "./types";

// Step 15C section 19/24/30: static guards for the Invoice extraction foundation - proving the
// module boundary and sensitive-data rules hold structurally, not just by convention.

const moduleDir = import.meta.dirname;
const files = readdirSync(moduleDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
const sources = new Map(files.map((file) => [file, readFileSync(path.join(moduleDir, file), "utf8")] as const));

describe("Invoice extraction never represents PAN/Aadhaar/bank identity", () => {
  it("the closed field-key set contains no PAN/Aadhaar/bank-account key", () => {
    for (const key of INVOICE_EXTRACTED_FIELD_KEYS) {
      expect(key.toLowerCase()).not.toMatch(/pan|aadhaar|bank|ifsc/);
    }
  });

  it("GSTIN is the ONLY restricted key, and it is genuinely restricted (value withheld at construction)", () => {
    expect(RESTRICTED_INVOICE_EXTRACTED_FIELD_KEYS).toEqual(["gstin"]);
    const extractors = sources.get("field-extractors.ts")!;
    expect(extractors).toMatch(/restricted:\s*true/);
  });
});

describe("Invoice extraction is structurally independent of Finance Agreements (finance-invoices-static.test.ts's own boundary)", () => {
  it("no non-test file in this module imports anything from finance-agreements or partner-reviews - the PDF/value parsers are local, deliberate copies (see pdf-text.ts's own header)", () => {
    for (const [name, source] of sources) {
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      for (const spec of imports) {
        expect(spec, `${name} imports ${spec}`).not.toMatch(/finance-agreements|partner-reviews/);
      }
    }
  });

  it("never imports a Firestore module - this whole module is pure/offline", () => {
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/firestore/i);
    }
  });
});
