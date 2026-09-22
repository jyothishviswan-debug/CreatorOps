import { describe, expect, it } from "vitest";

import { toAgreementDocumentDto, toAgreementEventDto, toAgreementHeadDto, toAgreementVersionDto, toAgreementVersionSummaryDto, toContractArtifactDto, toExtractionRunDto, toIdentityStatusDto } from "./client-dto";
import {
  agreementEventSchema,
  agreementHeadDocSchema,
  agreementVersionDocSchema,
  contractArtifactDocSchema,
  extractionRunDocSchema,
  type AgreementHeadDoc,
  type AgreementVersionDoc,
  type ContractArtifactDoc,
  type ExtractionRunDoc,
} from "./types";

const NOW = "2026-01-01T00:00:00.000Z";
const AGR = "agr_0123456789abcdef0123";

// Distinctive sentinels: if any leaks into a DTO, the JSON scan finds it.
const UID = "SECRET-PARTNER-UID-123";
const OWNER = "SECRET-OWNER-UID-456";
const VENDOR_UID = "SECRET-VENDOR-UID-789";
const REGION = "SECRET-REGION-XYZ";
const TEAM = "SECRET-TEAM-XYZ";
const LOCATOR = "gs://SECRET-BUCKET/SECRET/path.pdf";

const head: AgreementHeadDoc = agreementHeadDocSchema.parse({
  agreementRef: AGR,
  docVersion: 3,
  counterparty: { type: "PARTNER", partnerRef: "partner-ref-1", partnerAccountRefs: ["acct-1", "acct-2"], platformScope: ["instagram", "youtube"] },
  ownerUid: OWNER,
  regionIds: [REGION],
  teamIds: [TEAM],
  partnerUid: UID,
  vendorUid: null,
  status: "DRAFT",
  latestVersion: 1,
  openVersion: 1,
  createdAt: NOW,
  createdByUserRef: "user-ref-1",
  updatedAt: NOW,
  updatedByUserRef: "user-ref-1",
});

const version: AgreementVersionDoc = agreementVersionDocSchema.parse({
  agreementRef: AGR,
  version: 1,
  status: "DRAFT",
  docVersion: 2,
  counterparty: head.counterparty,
  sourceMode: "MANUAL",
  source: { contractArtifactRef: "ca_0123456789abcdef0123", extractionRunRef: "run_0123456789abcdef0123", parserVersion: "p1" },
  draft: {
    state: { value: "Kerala", origin: "EXTRACTED", decision: "PENDING", extractedValue: "Kerala", provenance: { label: "Contract extraction", page: 2, confidence: "HIGH", extractionRunRef: "run_0123456789abcdef0123" } },
    panNumber: { value: null, origin: "EXTRACTED", decision: "PENDING", provenance: { label: "Contract extraction" } },
  },
  createdAt: NOW,
  createdByUserRef: "user-ref-1",
  updatedAt: NOW,
  updatedByUserRef: "user-ref-1",
});

const artifact: ContractArtifactDoc = contractArtifactDocSchema.parse({
  artifactRef: "ca_0123456789abcdef0123",
  fileName: "contract.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  sha256: "abcdef0123456789".repeat(4),
  uploadedByUserRef: "user-ref-1",
  uploadedAt: NOW,
  counterparty: { type: "PARTNER", ref: "partner-ref-1" },
  status: "UPLOADED",
  storageLocator: LOCATOR,
});

const run: ExtractionRunDoc = extractionRunDocSchema.parse({
  runRef: "run_0123456789abcdef0123",
  agreementRef: AGR,
  artifactRef: artifact.artifactRef,
  status: "PARTIAL",
  reasonCodes: ["missing_fields"],
  parserVersion: "p1",
  pageCount: 3,
  charCount: 1200,
  proposals: [{ fieldKey: "state", normalizedValue: "Kerala", confidence: "MEDIUM", warnings: ["low text quality"], requiresHumanConfirmation: true, source: { page: 2 } }],
  createdAt: NOW,
  createdByUserRef: "user-ref-1",
});

// Key names that must never appear as a property in ANY DTO (recursively).
const FORBIDDEN_KEYS = new Set([
  "ownerUid", "regionIds", "teamIds", "partnerUid", "vendorUid", "uid", "userUid", "actorUid",
  "storageLocator", "locator", "bucket", "path", "signedUrl", "url", "sha256",
  "rawSnippet", "rawValue", "snippet",
  "panNumber", "aadhaarNumber", "bankAccountNumber", "accountNumber", "ifsc", "accountHolderName", "panHolderName", "gstin", "gstNumber",
  "inputFingerprint", "requestId",
]);

// `draft` and `fieldProvenance` are maps keyed by registry FIELD NAME (e.g. "panNumber" - a name
// carrying a decision, never a value); those map keys are skipped, everything beneath them is scanned.
const FIELD_NAME_MAPS = new Set(["draft", "fieldProvenance"]);
function collectKeys(value: unknown, out: string[] = [], isFieldMap = false): string[] {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, out));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (!isFieldMap) out.push(key);
      collectKeys(child, out, FIELD_NAME_MAPS.has(key));
    }
  }
  return out;
}

function expectClean(dto: unknown) {
  const keys = collectKeys(dto);
  expect(keys.filter((key) => FORBIDDEN_KEYS.has(key))).toEqual([]);
  const json = JSON.stringify(dto);
  for (const secret of [UID, OWNER, VENDOR_UID, REGION, TEAM, LOCATOR, "SECRET-BUCKET", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"]) expect(json).not.toContain(secret);
}

// Step 14B.1: the original signed Agreement document as the browser may see it.
describe("Agreement document DTO", () => {
  const confirmedParts = {
    terms: { agreementNumber: null, dates: { signedDate: null, effectiveFrom: "2026-01-01", effectiveTo: null }, contractTerms: { renewalTerms: null, noticeTerms: null, terminationTerms: null }, platform: { platforms: [], collaboratorPageLink: null, collaboratorPageName: null }, commercial: { currency: null, paymentCycle: null, fixedComponent: null, monthlyRequiredQualifyingContentCount: null, qualifyingUnit: null, accountTransferFee: null, advancePayment: null, invoiceRequired: null, invoiceDueTerms: null, paymentDueTerms: null, servicesMandated: null, incentive: null, lfcSfc: null, monetisationTerms: null }, performanceTargets: [], performanceEvaluationClause: null, admin: { onboardingProcessCompleted: null, remarks: null }, agreementType: "UNSPECIFIED" },
    contactSnapshot: { counterpartyName: "A", contactNumber: null, emailAddress: null, state: null, address: null, pinCode: null },
    identityStatusSnapshot: { state: "MISSING", components: { pan: "MISSING", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "MISSING" }, capturedAt: NOW },
    fieldProvenance: {},
    effective: { signedDate: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    confirmation: { confirmedByUserRef: "user-ref-1", confirmedAt: NOW },
    draft: {},
  };
  const DRIVE_LINK = "https://drive.example.test/SECRET-FILE-LINK";
  const DRIVE_ID = "SECRET-DRIVE-FILE-ID";
  const base = { ...version, ...confirmedParts };
  const parse = (over: object) => agreementVersionDocSchema.parse({ ...base, ...over });
  const stored = { status: "STORED", driveFileId: DRIVE_ID, driveLink: DRIVE_LINK, fileName: "signed.pdf", storedAt: NOW, storedByUserRef: "user-ref-1", artifactRef: "ca_0123456789abcdef0123", artifactSha256: "b".repeat(64), attemptCount: 2, lastFailureCode: null, lastAttemptAt: NOW };
  const failedRecord = (code: string) => ({ ...stored, status: "FAILED", driveFileId: null, driveLink: null, storedAt: null, storedByUserRef: null, lastFailureCode: code });

  it("STORED: the link is delivered ONLY when the caller passes contractDetailVisible; the Drive file id never leaves the server", () => {
    const withLink = toAgreementDocumentDto(parse({ document: stored }), { contractDetailVisible: true });
    expect(withLink).toEqual({ status: "STORED", fileName: "signed.pdf", storedAt: NOW, hasLink: true, link: DRIVE_LINK, attemptCount: 2, message: null, canStore: false });
    for (const options of [{ contractDetailVisible: false }, {}]) {
      const hidden = toAgreementDocumentDto(parse({ document: stored }), options);
      expect(hidden).toEqual({ status: "STORED", fileName: "signed.pdf", storedAt: NOW, hasLink: true, attemptCount: 2, message: null, canStore: false });
      expect(JSON.stringify(hidden)).not.toContain(DRIVE_LINK);
    }
    expect(JSON.stringify(withLink)).not.toContain(DRIVE_ID);
    // every builder that carries it: the version DTO, the summary DTO and the whole detail shape
    const doc = parse({ document: stored });
    for (const dto of [toAgreementVersionDto(doc, { identityDetailVisible: false }), toAgreementVersionSummaryDto(doc)]) {
      expect(JSON.stringify(dto)).not.toContain(DRIVE_LINK);
      expect(JSON.stringify(dto)).not.toContain(DRIVE_ID);
    }
    expect(toAgreementVersionSummaryDto(doc, { contractDetailVisible: true }).document.link).toBe(DRIVE_LINK);
    expect(toAgreementVersionDto(doc, { identityDetailVisible: false, contractDetailVisible: true }).document.link).toBe(DRIVE_LINK);
    expectClean(toAgreementVersionDto(doc, { identityDetailVisible: false, contractDetailVisible: false }));
  });

  it("FAILED and NOT_CONFIGURED carry no link, a plain fixed message, and stay retriable", () => {
    const failedDto = toAgreementDocumentDto(parse({ document: failedRecord("drive_unavailable") }), { contractDetailVisible: true });
    expect(failedDto).toMatchObject({ status: "FAILED", hasLink: false, storedAt: null, canStore: true, attemptCount: 2, message: expect.stringMatching(/temporarily unavailable/i) });
    expect(failedDto.link).toBeUndefined();
    for (const code of ["not_configured", "live_drive_disabled_in_tests"]) {
      const dto = toAgreementDocumentDto(parse({ document: failedRecord(code) }), { contractDetailVisible: true });
      expect(dto.status).toBe("NOT_CONFIGURED");
      expect(dto.link).toBeUndefined();
      expect(dto.hasLink).toBe(false);
    }
    expect(toAgreementDocumentDto(parse({ document: failedRecord("not_configured") })).message).toBe("Drive storage not configured");
  });

  it("no document yet: PENDING when the version has its own signed file (store is meaningful once confirmed), NOT_APPLICABLE otherwise - honestly labelled", () => {
    expect(toAgreementDocumentDto(parse({ document: null }))).toEqual({ status: "PENDING", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: null, canStore: true });
    expect(toAgreementDocumentDto(version)).toMatchObject({ status: "PENDING", canStore: false }); // the fixture draft is unconfirmed
    expect(toAgreementDocumentDto(parse({ document: null, source: {} }))).toEqual({ status: "NOT_APPLICABLE", fileName: null, storedAt: null, hasLink: false, attemptCount: 0, message: "No new signed document for this version", canStore: false });
  });
});

describe("client DTOs carry no uid / scope / locator / identity values", () => {
  it("head DTO", () => {
    const dto = toAgreementHeadDto(head, "Acme Partner");
    expectClean(dto);
    expect(dto).toMatchObject({ agreementRef: AGR, counterparty: { type: "PARTNER", ref: "partner-ref-1", platformScope: ["instagram", "youtube"] }, counterpartyDisplayName: "Acme Partner", docVersion: 3 });
  });

  it("vendor head DTO has empty account/platform lists", () => {
    const vendorHead = agreementHeadDocSchema.parse({ ...head, counterparty: { type: "VENDOR", vendorRef: "vendor-ref-1" }, partnerUid: null, vendorUid: VENDOR_UID });
    const dto = toAgreementHeadDto(vendorHead, null);
    expectClean(dto);
    expect(dto.counterparty).toEqual({ type: "VENDOR", ref: "vendor-ref-1", partnerAccountRefs: [], platformScope: [] });
  });

  it("version DTO (draft) - identity entries carry a decision but never a value", () => {
    const dto = toAgreementVersionDto(version, { identityDetailVisible: false });
    expectClean(dto);
    expect(dto.draft.panNumber).toMatchObject({ value: null, decision: "PENDING" });
    expect(dto.draft.state).toMatchObject({ value: "Kerala", origin: "EXTRACTED" });
    expect(dto.confirmed).toBe(false);
  });

  it("version summary DTO", () => {
    expectClean(toAgreementVersionSummaryDto(version));
  });

  it("identity status DTO: state always visible, component detail RESTRICTED without the identity category, never any value", () => {
    const snapshot = { state: "INCOMPLETE" as const, components: { pan: "PRESENT" as const, aadhaar: "MISSING" as const, gst: "NOT_APPLICABLE" as const, bank: "MISSING" as const }, capturedAt: NOW };
    const hidden = toIdentityStatusDto(snapshot, { identityDetailVisible: false });
    expect(hidden).toEqual({ state: "INCOMPLETE", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" }, valuesVisible: false, capturedAt: NOW });
    const shown = toIdentityStatusDto(snapshot, { identityDetailVisible: true });
    expect(shown?.components).toEqual({ pan: "PRESENT", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "MISSING" });
    expect(shown?.valuesVisible).toBe(false);
    expect(toIdentityStatusDto(null, { identityDetailVisible: true })).toBeNull();
    // Step 14B.1: a component-level INCOMPLETE is passed through as status (visible) and hidden with the rest when restricted
    const withIncomplete = { state: "INCOMPLETE" as const, components: { pan: "PRESENT" as const, aadhaar: "MISSING" as const, gst: "INCOMPLETE" as const, bank: "INCOMPLETE" as const }, capturedAt: NOW };
    expect(toIdentityStatusDto(withIncomplete, { identityDetailVisible: true })?.components).toEqual({ pan: "PRESENT", aadhaar: "MISSING", gst: "INCOMPLETE", bank: "INCOMPLETE" });
    expect(toIdentityStatusDto(withIncomplete, { identityDetailVisible: false })?.components).toEqual({ pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" });
  });

  it("event DTO re-screens metadata through the allowlist even if a stored event held extra keys", () => {
    const event = agreementEventSchema.parse({ kind: "field_decided", version: 1, actorUserRef: "user-ref-1", metadata: { fieldKey: "state", value: "Kerala", panNumber: "ABCDE1234F" }, requestId: "req-1", createdAt: NOW });
    const dto = toAgreementEventDto(event);
    expect(dto.metadata).toEqual({ fieldKey: "state" });
    expectClean(dto);
  });

  it("contract artifact DTO: safe metadata only - no storage locator, no full digest", () => {
    const dto = toContractArtifactDto(artifact);
    expectClean(dto);
    expect(dto).toEqual({
      artifactRef: artifact.artifactRef,
      fileName: "contract.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      sha256Prefix: "abcdef012345",
      uploadedAt: NOW,
      uploadedByUserRef: "user-ref-1",
      status: "UPLOADED",
      counterparty: { type: "PARTNER", ref: "partner-ref-1" },
    });
  });

  it("extraction run DTO: proposals without any raw snippet or locator", () => {
    const dto = toExtractionRunDto(run);
    expectClean(dto);
    expect(dto.proposals[0]).toEqual({ fieldKey: "state", normalizedValue: "Kerala", confidence: "MEDIUM", warnings: ["low text quality"], requiresHumanConfirmation: true, page: 2 });
  });

  it("the sentinel scan itself works (a leaking DTO would be caught)", () => {
    expect(() => expectClean({ ownerUid: OWNER })).toThrow();
    expect(() => expectClean({ note: LOCATOR })).toThrow();
  });
});
