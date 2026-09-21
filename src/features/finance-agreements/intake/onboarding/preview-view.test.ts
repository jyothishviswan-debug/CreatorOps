import { describe, expect, it } from "vitest";

import { EXTRACTION_NOTE, SCAN_MANUAL_REVIEW_MESSAGE } from "../../format";
import { previewDto, previewField } from "./onboarding-fixtures";
import { agreementFacts, commercialFoundLabels, detectedPlatformText, IDENTITY_FOUND_NOTE, identityFoundLines, previewAnnouncement, previewRows, safeSnippets, summarizePreview } from "./preview-view";

const NOTHING = { counterpartyName: null, contactNumber: null, emailAddress: null, state: null, collaboratorPageName: null, collaboratorPageLink: null };

describe("extracted Agreement values", () => {
  it("lists the six proposed profile values with confidence, page and warnings; a value not found is null", () => {
    const rows = previewRows(previewDto({}, { emailAddress: null, contactNumber: previewField("+91 98765 43210", { confidence: "LOW", page: 3, warnings: ["Two numbers were found."] }) }));
    expect(rows.map((item) => item.label)).toEqual(["Name", "Phone", "Email", "State", "Page or account name", "Page or account link"]);
    expect(rows.find((item) => item.key === "emailAddress")).toMatchObject({ value: null, confidence: null });
    expect(rows.find((item) => item.key === "contactNumber")).toMatchObject({ value: "+91 98765 43210", confidence: "LOW", page: 3, warnings: ["Two numbers were found."] });
  });

  it("reports identity details as PRESENCE only, with no value anywhere", () => {
    const preview = previewDto({ identityFound: { pan: true, aadhaar: false, gst: true, bank: true } });
    expect(identityFoundLines(preview)).toEqual(["PAN found in Agreement", "GSTIN found in Agreement", "Bank details found in Agreement"]);
    expect(identityFoundLines(previewDto({ identityFound: { pan: false, aadhaar: false, gst: false, bank: false } }))).toEqual([]);
    expect(IDENTITY_FOUND_NOTE).toMatch(/not shown here/);
    expect(JSON.stringify([identityFoundLines(preview), IDENTITY_FOUND_NOTE])).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
  });

  it("shows the Agreement's own number and dates, formatted, and which commercial terms it states (names only)", () => {
    const preview = previewDto({ agreement: { agreementNumber: previewField("AG-77"), signedDate: previewField("2026-08-30"), effectiveDate: previewField("2026-09-01"), terminationDate: null, commercialFieldsFound: ["currency", "monthlyRequiredQualifyingContentCount", "paymentCycle"] } });
    expect(agreementFacts(preview)).toEqual([{ label: "Agreement number", value: "AG-77" }, { label: "Signed date", value: "30 Aug 2026" }, { label: "Effective date", value: "1 Sep 2026" }]);
    expect(commercialFoundLabels(preview)).toEqual(["Currency", "Monthly required qualifying content", "Payment cycle"]);
    expect(agreementFacts(previewDto())).toEqual([]);
  });

  it("suggests the platform of the link", () => {
    expect(detectedPlatformText(previewDto({ detectedPlatform: "youtube" }))).toBe("The link looks like a YouTube page.");
    expect(detectedPlatformText(previewDto({ detectedPlatform: null }))).toBeNull();
  });
});

describe("preview summary", () => {
  it("an extracted preview carries the status chip and the required note, without a scan message", () => {
    const summary = summarizePreview(previewDto());
    expect(summary).toMatchObject({ chip: { label: "Extracted" }, pageCount: 4, scanMessage: null, note: EXTRACTION_NOTE, foundValues: true });
  });

  it("a scanned Agreement shows the exact required message once, and never lists the no-text reason as a warning", () => {
    const scanned = previewDto({ extraction: { status: "MANUAL_REVIEW_REQUIRED", reasons: [{ code: "no_extractable_text", message: "No text." }, { code: "other", message: "Something else." }], pageCount: 2 } }, NOTHING);
    const summary = summarizePreview(scanned);
    expect(summary.scanMessage).toBe(SCAN_MANUAL_REVIEW_MESSAGE);
    expect(summary.scanMessage).toBe("Manual review required — no extractable text was found.");
    expect(summary.warnings).toEqual(["Something else."]);
    expect(summary.chip.label).toBe("Manual review required");
    expect(summary.foundValues).toBe(false);
  });

  it("partial extraction keeps its reasons as warnings", () => {
    const partial = previewDto({ extraction: { status: "PARTIAL", reasons: [{ code: "missing_core:effectiveDate", message: "The effective date was not found." }], pageCount: 4 } });
    expect(summarizePreview(partial)).toMatchObject({ chip: { label: "Partial" }, scanMessage: null, warnings: ["The effective date was not found."] });
  });

  it("announces reading, failure, the scan message and the result (nothing is created)", () => {
    expect(previewAnnouncement({ loading: true, preview: null, failure: null, fileName: "a.pdf" })?.text).toBe("Reading a.pdf… Nothing is saved.");
    expect(previewAnnouncement({ loading: false, preview: null, failure: "This is not a PDF.", fileName: null })).toEqual({ tone: "error", text: "This is not a PDF." });
    expect(previewAnnouncement({ loading: false, preview: null, failure: null, fileName: null })).toBeNull();
    expect(previewAnnouncement({ loading: false, preview: previewDto({ extraction: { status: "MANUAL_REVIEW_REQUIRED", reasons: [], pageCount: 1 } }, NOTHING), failure: null, fileName: null })).toEqual({ tone: "warning", text: SCAN_MANUAL_REVIEW_MESSAGE });
    expect(previewAnnouncement({ loading: false, preview: previewDto(), failure: null, fileName: null })?.text).toMatch(/6 values proposed for the new record\. Nothing has been created\./);
  });

  it("masks any identity-shaped text in contract snippets again", () => {
    const preview = previewDto({ contractDetailVisible: true, snippets: [{ fieldKey: "counterpartyName", page: 1, snippet: "Asha Rao, PAN ABCDE1234F of Bengaluru" }] });
    const [snippet] = safeSnippets(preview);
    expect(snippet!.text).not.toContain("ABCDE1234F");
    expect(snippet!.text).toContain("Asha Rao");
    expect(safeSnippets(previewDto())).toEqual([]);
  });
});
