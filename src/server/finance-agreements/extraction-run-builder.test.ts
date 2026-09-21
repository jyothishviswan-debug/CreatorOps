import { describe, expect, it } from "vitest";

import { sha256Hex } from "./contract-artifacts/validation";
import { EXTRACTED_FIELD_KEYS, RESTRICTED_EXTRACTED_FIELD_KEYS } from "./extraction/extraction-types";
import { buildExtractionDocs, runExtractionPipeline } from "./extraction-run-builder";
import { AGREEMENT_FIELDS, AGREEMENT_FIELD_KEYS } from "./fields";
import { SAMPLE_AADHAAR, SAMPLE_CONTRACT_PAGES } from "./testing/sample-contract";
import { makeBlankPdf, makeEncryptedPdf, makeGarbagePdf, makeNotAPdf, makeTextPdf, makeTruncatedPdf } from "./testing/pdf-fixtures";
import { PARSER_VERSION } from "./extraction/pdf-text";

const IDENTITY_STRINGS = ["ABCPE1234F", "29ABCPE1234F1Z5", "123456789012", "HDFC0001234", SAMPLE_AADHAAR, "2341 2341 2346"];

async function docsFor(bytes: Buffer) {
  const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes));
  const docs = buildExtractionDocs({ agreementRef: "agr_0123456789abcdef0123", artifactRef: "ca_0123456789abcdef0123", runRef: "run_0123456789abcdef0123", actorUserRef: "u", now: "2025-01-01T00:00:00.000Z", parserVersion: PARSER_VERSION, outcome });
  return { outcome, ...docs };
}

describe("the extraction engine and the field registry agree", () => {
  it("every extractable key exists in AGREEMENT_FIELD_KEYS, and the restricted set is exactly the registry's identity-value fields", () => {
    for (const key of EXTRACTED_FIELD_KEYS) expect((AGREEMENT_FIELD_KEYS as readonly string[]).includes(key), key).toBe(true);
    const identity = AGREEMENT_FIELDS.filter((field) => field.identityValue).map((field) => field.key);
    // The registry also lists status fields; the identity VALUE fields the extractor can propose are exactly its restricted set.
    expect([...RESTRICTED_EXTRACTED_FIELD_KEYS].sort()).toEqual(identity.filter((key) => (EXTRACTED_FIELD_KEYS as readonly string[]).includes(key)).sort());
    expect(RESTRICTED_EXTRACTED_FIELD_KEYS.length).toBe(identity.length);
  });
});

describe("buildExtractionDocs over real PDF bytes", () => {
  it("a text contract: ordinary run has per-field provenance and NO snippet / identity value; the restricted record has them", async () => {
    const { run, restricted, outcome } = await docsFor(makeTextPdf(SAMPLE_CONTRACT_PAGES));
    expect(["EXTRACTED", "PARTIAL"]).toContain(run.status);
    expect(run.parserVersion).toBe(PARSER_VERSION);
    expect(run.pageCount).toBe(3);
    expect(run.charCount).toBeGreaterThan(200);
    expect(run.proposals.length).toBeGreaterThan(10);
    for (const proposal of run.proposals) {
      expect(proposal.requiresHumanConfirmation).toBe(true);
      expect(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]).toContain(proposal.confidence);
      expect(proposal.source.page).toBeGreaterThanOrEqual(1);
      expect(proposal.source.page).toBeLessThanOrEqual(3);
      expect(Array.isArray(proposal.warnings)).toBe(true);
    }
    // page numbers survive
    expect(run.proposals.find((p) => p.fieldKey === "effectiveDate")?.source.page).toBe(2);
    expect(run.proposals.find((p) => p.fieldKey === "incentive")?.source.page).toBe(3);

    // identity proposals are value-less in the ordinary run
    const identityKeys = new Set<string>(RESTRICTED_EXTRACTED_FIELD_KEYS);
    for (const proposal of run.proposals.filter((p) => identityKeys.has(p.fieldKey))) expect(proposal.normalizedValue).toBeNull();
    const ordinaryJson = JSON.stringify(run);
    for (const secret of IDENTITY_STRINGS) expect(ordinaryJson, secret).not.toContain(secret);
    expect(ordinaryJson).not.toContain("rawSnippet");

    // the restricted record holds snippets + identity values for exactly the kept proposals
    expect(Object.keys(restricted.fields).sort()).toEqual(run.proposals.map((p) => p.fieldKey).sort());
    expect(restricted.fields.panNumber?.rawValue).toBe("ABCPE1234F");
    expect(restricted.fields.panNumber?.rawSnippet).toContain("ABCPE1234F");
    expect(restricted.fields.effectiveDate?.locator).toBe("page 2");
    expect(restricted.fields.effectiveDate?.rawValue).toBeNull();
    expect(outcome.status).toBe(run.status);
  });

  it("a scan stand-in is MANUAL_REVIEW_REQUIRED / no_extractable_text with no proposals and an empty restricted record", async () => {
    const { run, restricted } = await docsFor(makeBlankPdf(3));
    expect(run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(run.reasonCodes).toEqual(["no_extractable_text"]);
    expect(run.proposals).toEqual([]);
    expect(run.pageCount).toBe(3);
    expect(restricted.fields).toEqual({});
  });

  it.each([
    ["garbage after a PDF header", () => makeGarbagePdf(), "unreadable_pdf"],
    ["a truncated PDF", () => makeTruncatedPdf(), "unreadable_pdf"],
    ["an encrypted PDF", () => makeEncryptedPdf(), "encrypted"],
  ])("%s is a safe MANUAL_REVIEW_REQUIRED with no proposals (never a throw)", async (_label, make, reason) => {
    const { run, restricted } = await docsFor(make());
    expect(run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(run.reasonCodes).toContain(reason);
    expect(run.proposals).toEqual([]);
    expect(restricted.fields).toEqual({});
  });

  it("bytes that are not a PDF at all are also a safe MANUAL_REVIEW_REQUIRED (unreadable_pdf)", async () => {
    const { run } = await docsFor(makeNotAPdf());
    expect(run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(run.reasonCodes).toEqual(["unreadable_pdf"]);
  });

  it("stored bytes that no longer match the recorded checksum are never parsed", async () => {
    const bytes = makeTextPdf(SAMPLE_CONTRACT_PAGES);
    const outcome = await runExtractionPipeline(bytes, "0".repeat(64));
    expect(outcome.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(outcome.reasons).toEqual(["unreadable_pdf", "artifact_integrity_mismatch"]);
    expect(outcome.fields).toEqual([]);
  });

  it("a thin text PDF (few fields) is MANUAL_REVIEW_REQUIRED, and a partly-complete one is PARTIAL", async () => {
    const thin = await docsFor(makeTextPdf([["This is a short note about nothing in particular, with enough characters to count as text."]]));
    expect(thin.run.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(thin.run.reasonCodes).toContain("few_fields");

    const partialPages = [SAMPLE_CONTRACT_PAGES[0]!.filter((line) => !/^(Effective Date)/i.test(line)), SAMPLE_CONTRACT_PAGES[1]!.filter((line) => !/^Effective Date/i.test(line))];
    const partial = await docsFor(makeTextPdf(partialPages));
    expect(partial.run.status).toBe("PARTIAL");
    expect(partial.run.reasonCodes).toContain("missing_core_fields");
    expect(partial.run.reasonCodes).toContain("missing_core:effectiveDate");
  });
});
