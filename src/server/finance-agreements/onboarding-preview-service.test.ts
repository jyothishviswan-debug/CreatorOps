import { describe, expect, it } from "vitest";

import { sha256Hex } from "./contract-artifacts/validation";
import { runExtractionPipeline } from "./extraction-run-builder";
import { buildOnboardingPreviewDto, detectPlatformFromLink } from "./onboarding-preview-service";
import { makeBlankPdf, makeTextPdf } from "./testing/pdf-fixtures";
import { SAMPLE_AADHAAR, SAMPLE_CONTRACT_PAGES } from "./testing/sample-contract";

const SECRETS = ["ABCPE1234F", "29ABCPE1234F1Z5", "123456789012", "HDFC0001234", SAMPLE_AADHAAR, "2341 2341 2346"];

async function previewOf(pages: string[][], visible: boolean) {
  const bytes = pages.length === 0 ? makeBlankPdf(1) : makeTextPdf(pages);
  const outcome = await runExtractionPipeline(new Uint8Array(bytes), sha256Hex(new Uint8Array(bytes)));
  return buildOnboardingPreviewDto({ type: "PARTNER", fileName: "Signed Agreement.pdf", outcome, contractDetailVisible: visible, canCreateCounterparty: true, canCreatePartnerAccounts: true });
}

describe("onboarding preview DTO (pure)", () => {
  it("proposes the master profile from the Agreement with per-field confidence, page and warnings", async () => {
    const dto = await previewOf(SAMPLE_CONTRACT_PAGES, false);
    expect(dto.extraction.status).toMatch(/^(EXTRACTED|PARTIAL)$/);
    expect(dto.profile.counterpartyName).toMatchObject({ value: "Sample Creator Studio", page: 1 });
    expect(dto.profile.counterpartyName?.confidence).toMatch(/^(HIGH|MEDIUM|LOW|UNKNOWN)$/);
    expect(dto.profile.contactNumber?.value).toBe("+919876543210");
    expect(dto.profile.emailAddress?.value).toBe("hello@samplecreator.example");
    expect(dto.profile.state?.value).toBe("Karnataka");
    expect(dto.profile.collaboratorPageName?.value).toBe("Sample Creator Official");
    expect(dto.profile.collaboratorPageLink?.value).toContain("instagram.com/sample.creator");
    expect(dto.detectedPlatform).toBe("instagram");
    expect(dto.agreement.agreementNumber?.value).toBe("CO/2025/0042");
    expect(dto.agreement.effectiveDate?.value).toBe("2025-04-01");
    expect(dto.agreement.commercialFieldsFound).toEqual(expect.arrayContaining(["currency", "paymentCycle", "fixedComponent"]));
    expect(Array.isArray(dto.profile.counterpartyName?.warnings)).toBe(true);
  });

  it("identity fields report PRESENCE only: no value, in any property, ever", async () => {
    for (const visible of [false, true]) {
      const dto = await previewOf(SAMPLE_CONTRACT_PAGES, visible);
      expect(dto.identityFound).toEqual({ pan: true, aadhaar: true, gst: true, bank: true });
      const text = JSON.stringify(dto);
      for (const secret of SECRETS) expect(text, `visible=${visible}`).not.toContain(secret);
    }
  });

  it("raw snippets appear only with finance_contracts, identity masked and an identity field's own snippet withheld", async () => {
    const hidden = await previewOf(SAMPLE_CONTRACT_PAGES, false);
    expect(hidden.contractDetailVisible).toBe(false);
    expect(hidden.snippets).toBeNull();
    const shown = await previewOf(SAMPLE_CONTRACT_PAGES, true);
    expect(shown.contractDetailVisible).toBe(true);
    expect(shown.snippets?.length).toBeGreaterThan(3);
    const keys = shown.snippets!.map((snippet) => snippet.fieldKey);
    for (const identityKey of ["panNumber", "aadhaarNumber", "gstin", "bankAccountNumber", "ifsc", "panHolderName"]) expect(keys).not.toContain(identityKey);
  });

  it("a scanned / image-only PDF is MANUAL_REVIEW_REQUIRED with reasons and no proposals - never invented values", async () => {
    const dto = await previewOf([], false);
    expect(dto.extraction.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(dto.extraction.reasons.map((reason) => reason.code)).toContain("no_extractable_text");
    expect(dto.extraction.reasons.every((reason) => reason.message.length > 0)).toBe(true);
    expect(Object.values(dto.profile).every((field) => field === null)).toBe(true);
    expect(dto.agreement.commercialFieldsFound).toEqual([]);
    expect(dto.identityFound).toEqual({ pan: false, aadhaar: false, gst: false, bank: false });
    expect(dto.detectedPlatform).toBeNull();
  });

  it("carries what the actor may do next, verbatim", async () => {
    const bytes = new Uint8Array(makeBlankPdf(1));
    const outcome = await runExtractionPipeline(bytes, sha256Hex(bytes));
    expect(buildOnboardingPreviewDto({ type: "VENDOR", fileName: "a.pdf", outcome, contractDetailVisible: false, canCreateCounterparty: false, canCreatePartnerAccounts: false })).toMatchObject({ counterpartyType: "VENDOR", canCreateCounterparty: false, canCreatePartnerAccounts: false });
  });
});

describe("platform suggestion from the page link", () => {
  it("names Instagram / YouTube by host only, with or without a scheme, and never guesses", () => {
    expect(detectPlatformFromLink("https://www.instagram.com/sample.creator/?igsh=abc")).toBe("instagram");
    expect(detectPlatformFromLink("instagram.com/x")).toBe("instagram");
    expect(detectPlatformFromLink("https://youtube.com/@x")).toBe("youtube");
    expect(detectPlatformFromLink("https://m.youtube.com/channel/UC1")).toBe("youtube");
    expect(detectPlatformFromLink("https://youtu.be/abc")).toBe("youtube");
    expect(detectPlatformFromLink("https://example.com/instagram.com")).toBeNull();
    expect(detectPlatformFromLink("https://notinstagram.com/x")).toBeNull();
    expect(detectPlatformFromLink("")).toBeNull();
    expect(detectPlatformFromLink("not a link at all")).toBeNull();
  });
});
