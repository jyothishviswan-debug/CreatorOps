import { describe, expect, it } from "vitest";

import { toExtractionResultDto } from "./client-dto";
import { sanitizeContractFileName, contractArtifactClaimId } from "./contract-service";
import { describeExtractionReason } from "./extraction-reasons";
import { redactIdentityFromText, RESTRICTED_PLACEHOLDER } from "./extraction-redaction";
import { extractionRunDocSchema } from "./types";

describe("redactIdentityFromText", () => {
  const text = "Address: 12 Test Street PAN: ABCPE1234F Name as per PAN: Sample Creator GSTIN: 29ABCPE1234F1Z5 Aadhaar No: 2341 2341 2346 Account Number: 123456789012 IFSC: HDFC0001234 Mobile: +91 98765 43210";

  it("masks extracted identity values separator-tolerantly and every identity-shaped string, and leaves ordinary text", () => {
    const out = redactIdentityFromText(text, ["ABCPE1234F", "Sample Creator", "234123412346", "123456789012"]);
    for (const secret of ["ABCPE1234F", "Sample Creator", "29ABCPE1234F1Z5", "2341 2341 2346", "123456789012", "HDFC0001234"]) expect(out, secret).not.toContain(secret);
    expect(out).toContain(RESTRICTED_PLACEHOLDER);
    expect(out).toContain("Address: 12 Test Street");
    expect(out).toContain("+91 98765 43210");
  });

  it("masks identity-shaped strings even when the run extracted no value at all", () => {
    const out = redactIdentityFromText(text, []);
    for (const secret of ["ABCPE1234F", "29ABCPE1234F1Z5", "2341 2341 2346", "123456789012", "HDFC0001234"]) expect(out, secret).not.toContain(secret);
  });

  it("does not mask by exact match when a value is too short to be safe to search for, and is a pure function", () => {
    expect(redactIdentityFromText("pan is ab here", ["ab"])).toBe("pan is ab here");
    const input = "PAN: ABCPE1234F";
    redactIdentityFromText(input, ["ABCPE1234F"]);
    expect(input).toBe("PAN: ABCPE1234F");
  });
});

describe("sanitizeContractFileName", () => {
  it("keeps only the last path segment and drops separators, control characters and traversal", () => {
    expect(sanitizeContractFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeContractFileName("C:\\Users\\me\\Contract v2.pdf")).toBe("Contract v2.pdf");
    expect(sanitizeContractFileName("a/b/..")).toBe("contract.pdf");
    expect(sanitizeContractFileName("..")).toBe("contract.pdf");
    expect(sanitizeContractFileName("")).toBe("contract.pdf");
    expect(sanitizeContractFileName("bad\u0000name\n<script>.pdf")).toBe("bad_name__script_.pdf");
  });

  it("bounds the length to 200 and preserves a short extension", () => {
    const out = sanitizeContractFileName(`${"x".repeat(500)}.pdf`);
    expect(out.length).toBe(200);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("contractArtifactClaimId", () => {
  it("is deterministic, prefixed (never colliding with a bare agreement claim id), and separates counterparties and content", () => {
    const a = contractArtifactClaimId("PARTNER", "ref-1", "a".repeat(64));
    expect(a).toMatch(/^ctr_[0-9a-f]{64}$/);
    expect(contractArtifactClaimId("PARTNER", "ref-1", "a".repeat(64))).toBe(a);
    expect(contractArtifactClaimId("VENDOR", "ref-1", "a".repeat(64))).not.toBe(a);
    expect(contractArtifactClaimId("PARTNER", "ref-2", "a".repeat(64))).not.toBe(a);
    expect(contractArtifactClaimId("PARTNER", "ref-1", "b".repeat(64))).not.toBe(a);
  });
});

describe("describeExtractionReason", () => {
  it("says plainly that no OCR adapter exists for a scan, and never echoes anything for an unknown code", () => {
    expect(describeExtractionReason("no_extractable_text")).toMatch(/No OCR adapter is configured/);
    expect(describeExtractionReason("missing_core:effectiveDate")).toMatch(/core field/);
    expect(describeExtractionReason("anything_else")).toBe("See the extraction status.");
  });
});

describe("toExtractionResultDto visibility", () => {
  const run = extractionRunDocSchema.parse({
    runRef: "run_0123456789abcdef0123",
    agreementRef: "agr_0123456789abcdef0123",
    artifactRef: "ca_0123456789abcdef0123",
    status: "EXTRACTED",
    reasonCodes: [],
    parserVersion: "p-1",
    pageCount: 2,
    charCount: 100,
    proposals: [
      { fieldKey: "effectiveDate", normalizedValue: "2025-04-01", confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, source: { page: 2 } },
      { fieldKey: "panNumber", normalizedValue: null, confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, source: { page: 1 } },
    ],
    createdAt: "2025-01-01T00:00:00.000Z",
    createdByUserRef: "u",
  });
  const snippets = [
    { fieldKey: "effectiveDate" as const, page: 2, locator: "page 2", rawSnippet: "Effective Date: 01/04/2025" },
    { fieldKey: "panNumber" as const, page: 1, locator: "page 1", rawSnippet: null },
  ];
  const identityValues = new Map([["panNumber", "ABCPE1234F"]]);

  it("ordinary only: no restricted block, identity field RESTRICTED without a value, even when values were passed in", () => {
    const dto = toExtractionResultDto({ agreementRef: run.agreementRef, run, contractDetailVisible: false, identityValuesVisible: false, identityValues, snippets });
    expect(dto.restricted).toBeNull();
    expect(dto.fields.find((f) => f.fieldKey === "panNumber")).toMatchObject({ valueState: "RESTRICTED", normalizedValue: null });
    expect(dto.fields.find((f) => f.fieldKey === "effectiveDate")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "2025-04-01", page: 2, confidence: "HIGH", requiresHumanConfirmation: true });
    const json = JSON.stringify(dto);
    expect(json).not.toContain("ABCPE1234F");
    expect(json).not.toContain("Effective Date: 01/04/2025");
  });

  it("identity values are shown only when BOTH contract detail and identity values are visible (identity alone is not enough)", () => {
    const identityOnly = toExtractionResultDto({ agreementRef: run.agreementRef, run, contractDetailVisible: false, identityValuesVisible: true, identityValues, snippets });
    expect(identityOnly.identityValuesVisible).toBe(false);
    expect(JSON.stringify(identityOnly)).not.toContain("ABCPE1234F");

    const contractOnly = toExtractionResultDto({ agreementRef: run.agreementRef, run, contractDetailVisible: true, identityValuesVisible: false, identityValues, snippets });
    expect(contractOnly.restricted?.snippets).toHaveLength(2);
    expect(contractOnly.restricted?.snippets[1]).toMatchObject({ rawSnippet: null, snippetState: "RESTRICTED" });
    expect(JSON.stringify(contractOnly)).not.toContain("ABCPE1234F");

    const both = toExtractionResultDto({ agreementRef: run.agreementRef, run, contractDetailVisible: true, identityValuesVisible: true, identityValues, snippets });
    expect(both.fields.find((f) => f.fieldKey === "panNumber")).toMatchObject({ valueState: "VISIBLE", normalizedValue: "ABCPE1234F" });
  });
});
