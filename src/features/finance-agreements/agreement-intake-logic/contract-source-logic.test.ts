import { describe, expect, it } from "vitest";

import type { ExtractionResultDto } from "@/server/finance-agreements/client-dto";

import { EXTRACTION_NOTE, SCAN_MANUAL_REVIEW_MESSAGE } from "../format";
import { contractControls, extractionAnnouncement, pickContractFile, summarizeExtraction } from "./contract-source-logic";

function extraction(over: Partial<ExtractionResultDto> & { status?: ExtractionResultDto["run"]["status"] } = {}): ExtractionResultDto {
  const { status, ...rest } = over;
  return {
    agreementRef: "agr_1",
    run: { runRef: "run_1", artifactRef: "ca_1", status: status ?? "EXTRACTED", reasonCodes: [], parserVersion: "p1", pageCount: 3, charCount: 900, createdAt: "2026-09-01T00:00:00.000Z", createdByUserRef: "u" },
    reasons: [],
    fields: [{ fieldKey: "counterpartyName", normalizedValue: "Asha Rao", confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, page: 1, valueState: "VISIBLE" }],
    contractDetailVisible: false,
    identityValuesVisible: false,
    restricted: null,
    ...rest,
  };
}

const file = (name: string, size: number, type = "application/pdf") => ({ name, size, type }) as File;

describe("picking a contract file", () => {
  it("accepts a PDF up to 10 MB", () => {
    const pick = pickContractFile(file("signed.pdf", 2_000_000));
    expect(pick.error).toBeNull();
    expect(pick.file).not.toBeNull();
  });
  it("rejects non-PDF, empty and oversize files with a message and no file", () => {
    expect(pickContractFile(file("notes.docx", 100, "application/msword"))).toEqual({ file: null, error: "Only PDF files can be uploaded." });
    expect(pickContractFile(file("scan.png", 100, "image/png")).error).toBe("Only PDF files can be uploaded.");
    expect(pickContractFile(file("empty.pdf", 0)).error).toBe("This file is empty.");
    expect(pickContractFile(file("big.pdf", 10 * 1024 * 1024 + 1)).error).toMatch(/limit is 10 MB/);
    expect(pickContractFile(file("exactly.pdf", 10 * 1024 * 1024)).error).toBeNull();
  });
  it("no file selected is neither a file nor an error", () => {
    expect(pickContractFile(null)).toEqual({ file: null, error: null });
    expect(pickContractFile(undefined)).toEqual({ file: null, error: null });
  });
});

describe("extraction summary", () => {
  it("carries the required note and the status chip text (completeness only)", () => {
    const summary = summarizeExtraction(extraction());
    expect(summary.note).toBe(EXTRACTION_NOTE);
    expect(summary.note).toBe("Extraction suggests values only. Review every field before confirming the Agreement.");
    expect(summary.chip.label).toMatch(/extracted/i);
    expect(summary.scanMessage).toBeNull();
    expect(summary.attachable).toBe(true);
    expect(summarizeExtraction(extraction({ status: "PARTIAL" })).chip.label).toMatch(/partial/i);
  });
  it("uses the required scan message - once - for a no-text PDF, with no OCR / cloud promise", () => {
    const scan = extraction({ status: "MANUAL_REVIEW_REQUIRED", fields: [], reasons: [{ code: "no_extractable_text", message: "No readable text was found in the PDF. No OCR adapter is configured..." }] });
    const summary = summarizeExtraction(scan);
    expect(summary.scanMessage).toBe(SCAN_MANUAL_REVIEW_MESSAGE);
    expect(summary.scanMessage).toBe("Manual review required — no extractable text was found.");
    expect(summary.warnings).toEqual([]);
    expect(summary.attachable).toBe(false);
    expect(summary.chip.label).toMatch(/manual review/i);
  });
  it("lists other warnings and does not offer to attach a run with only restricted proposals", () => {
    const warned = extraction({ status: "PARTIAL", reasons: [{ code: "few_fields", message: "Too few fields could be identified." }] });
    expect(summarizeExtraction(warned).warnings).toEqual(["Too few fields could be identified."]);
    const restrictedOnly = extraction({ fields: [{ fieldKey: "panNumber", normalizedValue: null, confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, page: 1, valueState: "RESTRICTED" }] });
    expect(summarizeExtraction(restrictedOnly).attachable).toBe(false);
  });
});

describe("live-region announcements", () => {
  it("announces upload and extract progress, then the outcome", () => {
    expect(extractionAnnouncement({ phase: "uploading", extraction: null, attached: false, fileName: "signed.pdf" })).toEqual({ text: "Uploading signed.pdf…", tone: "info" });
    expect(extractionAnnouncement({ phase: "extracting", extraction: null, attached: false, fileName: null })?.text).toBe("Reading the Agreement…");
    expect(extractionAnnouncement({ phase: "idle", extraction: null, attached: false, fileName: null })).toBeNull();
    const done = extractionAnnouncement({ phase: "idle", extraction: extraction(), attached: false, fileName: null });
    expect(done?.text).toMatch(/1 value proposed/);
    expect(done?.text).toMatch(/Nothing has been added to the draft yet/);
    expect(extractionAnnouncement({ phase: "idle", extraction: extraction(), attached: true, fileName: null })?.text).toMatch(/pending values/);
    expect(extractionAnnouncement({ phase: "idle", extraction: extraction({ status: "MANUAL_REVIEW_REQUIRED", fields: [] }), attached: false, fileName: null })).toEqual({ text: SCAN_MANUAL_REVIEW_MESSAGE, tone: "warning" });
  });
});

describe("which controls are offered", () => {
  it("offers upload only to someone who can edit, and enables Extract only with a valid file and nothing else running", () => {
    expect(contractControls({ canExtract: false, hasFile: true, busy: false, extraction: null, attached: false })).toMatchObject({ showUpload: false, canRun: false });
    expect(contractControls({ canExtract: true, hasFile: false, busy: false, extraction: null, attached: false })).toMatchObject({ showUpload: true, canRun: false });
    expect(contractControls({ canExtract: true, hasFile: true, busy: false, extraction: null, attached: false })).toMatchObject({ showUpload: true, canRun: true });
    expect(contractControls({ canExtract: true, hasFile: true, busy: true, extraction: null, attached: false }).canRun).toBe(false);
  });
  it("attach is an explicit step: shown only after an extraction with visible proposals, hidden once attached, disabled while busy", () => {
    expect(contractControls({ canExtract: true, hasFile: false, busy: false, extraction: null, attached: false }).showAttach).toBe(false);
    expect(contractControls({ canExtract: true, hasFile: false, busy: false, extraction: extraction(), attached: false })).toMatchObject({ showAttach: true, canAttach: true });
    expect(contractControls({ canExtract: true, hasFile: false, busy: true, extraction: extraction(), attached: false })).toMatchObject({ showAttach: true, canAttach: false });
    expect(contractControls({ canExtract: true, hasFile: false, busy: false, extraction: extraction(), attached: true }).showAttach).toBe(false);
    expect(contractControls({ canExtract: false, hasFile: false, busy: false, extraction: extraction(), attached: false }).showAttach).toBe(false);
    expect(contractControls({ canExtract: true, hasFile: false, busy: false, extraction: extraction({ status: "MANUAL_REVIEW_REQUIRED", fields: [] }), attached: false }).showAttach).toBe(false);
  });
});
