import { describe, expect, it } from "vitest";

import { AGREEMENT_EVENT_METADATA_ALLOWLIST, buildAgreementEvent, redactAgreementEventMetadata } from "./agreement-events";
import { AGREEMENT_FIELD_KEYS } from "./fields";
import { AGREEMENT_EVENT_KINDS } from "./types";

describe("redactAgreementEventMetadata (explicit ALLOWLIST)", () => {
  it("keeps allowlisted keys with safe values", () => {
    const kept = redactAgreementEventMetadata({
      version: 2,
      previousVersion: 1,
      fromStatus: "DRAFT",
      toStatus: "ACTIVE",
      fieldKey: "currency",
      decision: "CORRECTED",
      origin: "EXTRACTED",
      sourceMode: "MIXED",
      counterpartyType: "PARTNER",
      agreementType: "FIXED_ONLY",
      pendingCount: 0,
      proposalCount: 12,
      artifactRef: "ca_0123456789abcdef0123",
      runRef: "run_0123456789abcdef0123",
      parserVersion: "unpdf-1.2.3",
      mode: "FILL_MISSING",
      component: "pan",
      resolutionAcknowledged: true,
      idempotentReplay: false,
      reason: "Contract terminated by mutual consent",
      fieldKeys: ["emailAddress", "contactNumber"],
    });
    expect(Object.keys(kept ?? {}).sort()).toEqual(
      [
        "version", "previousVersion", "fromStatus", "toStatus", "fieldKey", "decision", "origin", "sourceMode", "counterpartyType", "agreementType",
        "pendingCount", "proposalCount", "artifactRef", "runRef", "parserVersion", "mode", "component", "resolutionAcknowledged", "idempotentReplay", "reason", "fieldKeys",
      ].sort(),
    );
  });

  it("drops EVERY non-allowlisted key - identity, contract, extracted/confirmed values and amounts - however they are named", () => {
    const dropped = redactAgreementEventMetadata({
      panNumber: "ABCDE1234F",
      pan: "ABCDE1234F",
      aadhaarNumber: "123412341234",
      bankAccountNumber: "123456789012",
      accountNumber: "123456789012",
      ifsc: "HDFC0001234",
      gstin: "22AAAAA0000A1Z5",
      panHolderName: "Someone",
      value: "secret",
      extractedValue: "secret",
      confirmedValue: "secret",
      rawSnippet: "the contract says ...",
      locator: "p3",
      amountMinor: 500000,
      amount: "5,00,000",
      currency: "INR",
      terms: { commercial: {} },
      normalizedValue: "x",
      storageLocator: "gs://bucket/path",
      password: "x",
      token: "x",
      someBrandNewKey: "x",
    });
    expect(dropped).toBeNull();
  });

  it("drops an allowlisted key whose VALUE is not the expected safe shape (no coercion)", () => {
    expect(redactAgreementEventMetadata({ fieldKey: "ABCDE1234F", decision: "SECRET", version: "2", pendingCount: -1, artifactRef: "gs://b/p", parserVersion: "has space", toStatus: "PAN", component: "ifsc" })).toBeNull();
    expect(redactAgreementEventMetadata({ fieldKey: { nested: "ABCDE1234F" }, fieldKeys: ["panNumberValue"], reason: 12345 })).toBeNull();
    expect(redactAgreementEventMetadata({ version: 1.5 })).toBeNull();
  });

  it("free-text reason/note is refused when it contains an identity, email or amount shape", () => {
    for (const text of [
      "PAN is ABCDE1234F",
      "ifsc hdfc0001234",
      "Aadhaar 1234 5678 9012",
      "account 123456789012",
      "GST 22AAAAA0000A1Z5",
      "mail me at someone@example.com",
      "advance of Rs. 50,000 waived",
      "waived ₹5000",
      "changed to 50000 INR",
      "agreed 5 lakhs",
    ]) {
      expect(redactAgreementEventMetadata({ reason: text }), text).toBeNull();
      expect(redactAgreementEventMetadata({ note: text }), text).toBeNull();
    }
    expect(redactAgreementEventMetadata({ reason: "Partner requested early termination" })).toEqual({ reason: "Partner requested early termination" });
    expect(redactAgreementEventMetadata({ reason: "   " })).toBeNull();
    expect(redactAgreementEventMetadata({ reason: "x".repeat(1001) })).toBeNull();
  });

  it("nested objects and arrays (other than a list of registry field keys) never pass", () => {
    expect(redactAgreementEventMetadata({ fieldKeys: ["nonsense"] })).toBeNull();
    expect(redactAgreementEventMetadata({ fieldKeys: [{ panNumber: "x" }] })).toBeNull();
    expect(redactAgreementEventMetadata({ version: [1] })).toBeNull();
  });

  it("returns null for null/undefined/empty input and never mutates its input", () => {
    expect(redactAgreementEventMetadata(null)).toBeNull();
    expect(redactAgreementEventMetadata(undefined)).toBeNull();
    expect(redactAgreementEventMetadata({})).toBeNull();
    const input = { version: 1, panNumber: "ABCDE1234F" };
    redactAgreementEventMetadata(input);
    expect(input).toEqual({ version: 1, panNumber: "ABCDE1234F" });
  });

  it("no allowlisted KEY name is, or contains, an identity / value / amount / contract-content name", () => {
    const forbidden = /pan|aadhaar|bank|ifsc|gst|account(?!Count)|value|amount|snippet|locator|storage|token|secret|password|terms|currency|price|rate/i;
    for (const key of Object.keys(AGREEMENT_EVENT_METADATA_ALLOWLIST)) expect(key, key).not.toMatch(forbidden);
  });

  it("hostile prototype-style keys do not pass through", () => {
    const hostile = JSON.parse('{"__proto__": {"version": 3}, "constructor": "x", "toString": "x", "hasOwnProperty": "x"}');
    expect(redactAgreementEventMetadata(hostile)).toBeNull();
  });

  it("a fieldKey that names an identity FIELD is fine (it is a NAME, never a value)", () => {
    expect(redactAgreementEventMetadata({ fieldKey: "panNumber", decision: "ACCEPTED" })).toEqual({ fieldKey: "panNumber", decision: "ACCEPTED" });
    for (const key of AGREEMENT_FIELD_KEYS) expect(redactAgreementEventMetadata({ fieldKey: key })).toEqual({ fieldKey: key });
  });
});

describe("original signed document events (Step 14B.1)", () => {
  it("keeps the status word, a failure CODE, the attempt count and a safe original file name - and nothing that names a link or a Drive id", () => {
    expect(redactAgreementEventMetadata({ version: 2, documentStatus: "STORED", fileName: "Acme Media Agreement 2026-01-15.pdf", artifactRef: "ca_0123456789abcdef0123", attemptCount: 3 })).toEqual({
      version: 2, documentStatus: "STORED", fileName: "Acme Media Agreement 2026-01-15.pdf", artifactRef: "ca_0123456789abcdef0123", attemptCount: 3,
    });
    expect(redactAgreementEventMetadata({ documentStatus: "FAILED", failureCode: "drive_unavailable" })).toEqual({ documentStatus: "FAILED", failureCode: "drive_unavailable" });
    // link / id / locator-shaped keys are simply not on the list
    expect(redactAgreementEventMetadata({ driveLink: "https://drive.google.com/x", driveFileId: "abc", webViewLink: "https://x", fileId: "abc", storageLocator: "finance-contracts/x.pdf", folderId: "abc" })).toBeNull();
  });

  it("refuses an unknown status, an unknown failure code and a file name that looks like an identity value, an e-mail or a path", () => {
    expect(redactAgreementEventMetadata({ documentStatus: "PENDING", failureCode: "Bearer secret-token" })).toBeNull();
    for (const fileName of ["ABCPE1234F agreement.pdf", "29ABCPE1234F1Z5.pdf", "HDFC0001234.pdf", "2341 2341 2346.pdf", "asha@example.com.pdf", "../../etc/passwd.pdf", "a\\b.pdf", "line\nbreak.pdf", "", "x".repeat(256)]) {
      expect(redactAgreementEventMetadata({ fileName }), JSON.stringify(fileName)).toBeNull();
    }
    expect(redactAgreementEventMetadata({ fileName: "Agreement 20260115093000.pdf" })).toEqual({ fileName: "Agreement 20260115093000.pdf" });
  });

  it("both document event kinds build with the redacted metadata", () => {
    const base = { agreementRef: "agr_0123456789abcdef0123", version: 1, actorUserRef: "user-ref", requestId: "req-1", createdAt: "2026-01-01T00:00:00.000Z" };
    for (const kind of ["document_stored", "document_store_failed"] as const) {
      expect(buildAgreementEvent({ ...base, kind, metadata: { documentStatus: "STORED", driveLink: "https://x", fileName: "a.pdf" } }).metadata).toEqual({ documentStatus: "STORED", fileName: "a.pdf" });
    }
  });
});

describe("onboarding provenance on the created event (Step 14B.1)", () => {
  it("keeps the provenance marker, the mode word and the opaque ledger ref - and refuses any other value", () => {
    const ref = `onb_${"a".repeat(64)}`;
    expect(redactAgreementEventMetadata({ counterpartyType: "PARTNER", createdVia: "FINANCE_AGREEMENT_ONBOARDING", onboardingMode: "NEW_COUNTERPARTY", onboardingRef: ref })).toEqual({ counterpartyType: "PARTNER", createdVia: "FINANCE_AGREEMENT_ONBOARDING", onboardingMode: "NEW_COUNTERPARTY", onboardingRef: ref });
    expect(redactAgreementEventMetadata({ onboardingMode: "EXISTING_COUNTERPARTY" })).toEqual({ onboardingMode: "EXISTING_COUNTERPARTY" });
    expect(redactAgreementEventMetadata({ createdVia: "SOMETHING_ELSE", onboardingMode: "ELSEWHERE", onboardingRef: "has spaces and /slashes" })).toBeNull();
  });

  it("records the deliberate duplicate decision as a flag plus the reviewer's own reason - and drops a reason that looks like an identity value or an e-mail", () => {
    expect(redactAgreementEventMetadata({ createdVia: "FINANCE_AGREEMENT_ONBOARDING", duplicatesAcknowledged: true, reason: "A different person who shares the studio inbox" })).toEqual({ createdVia: "FINANCE_AGREEMENT_ONBOARDING", duplicatesAcknowledged: true, reason: "A different person who shares the studio inbox" });
    expect(redactAgreementEventMetadata({ reason: "same as asha@example.com" })).toBeNull();
    expect(redactAgreementEventMetadata({ duplicatesAcknowledged: "yes" })).toBeNull();
  });

  it("carries no counterparty ref, name, email, phone, account handle or link key", () => {
    expect(redactAgreementEventMetadata({ partnerRef: "p", vendorRef: "v", displayName: "Asha", email: "a@b.co", phone: "9876543210", handle: "asha", profileUrl: "https://x", partnerAccountRef: "acc" })).toBeNull();
  });
});

describe("buildAgreementEvent", () => {
  const base = { agreementRef: "agr_0123456789abcdef0123", version: 1, actorUserRef: "user-ref", requestId: "req-1", createdAt: "2026-01-01T00:00:00.000Z" };

  it("validates against the event schema and redacts the metadata it is given", () => {
    const event = buildAgreementEvent({ ...base, kind: "field_decided", metadata: { fieldKey: "state", decision: "ACCEPTED", value: "Kerala", panNumber: "ABCDE1234F" } });
    expect(event).toEqual({ kind: "field_decided", version: 1, actorUserRef: "user-ref", metadata: { fieldKey: "state", decision: "ACCEPTED" }, requestId: "req-1", createdAt: base.createdAt });
    expect(JSON.stringify(event)).not.toMatch(/Kerala|ABCDE/);
  });

  it("a null / fully-redacted metadata becomes null; every kind builds", () => {
    for (const kind of AGREEMENT_EVENT_KINDS) expect(buildAgreementEvent({ ...base, kind, metadata: { secret: "x" } }).metadata).toBeNull();
  });

  it("rejects an unknown kind", () => {
    expect(() => buildAgreementEvent({ ...base, kind: "deleted" as never, metadata: null })).toThrow();
  });
});
