import { describe, expect, it } from "vitest";

import type { AgreementEventDto } from "@/server/finance-agreements/client-dto";
import { AGREEMENT_EVENT_KINDS } from "@/server/finance-agreements/types";

import { describeAgreementEvent } from "./event-view";

const event = (kind: AgreementEventDto["kind"], metadata: Record<string, unknown> | null, version = 1): AgreementEventDto => ({ kind, version, actorUserRef: "usr_abc", metadata, createdAt: "2026-09-02T10:00:00.000Z" });

describe("describeAgreementEvent", () => {
  it("gives every event kind a human label (never the raw kind)", () => {
    for (const kind of AGREEMENT_EVENT_KINDS) {
      const view = describeAgreementEvent(event(kind, null));
      expect(view.label.length).toBeGreaterThan(3);
      expect(view.label).not.toBe(kind);
      expect(view.label).not.toMatch(/_/);
    }
  });

  it("created: says who / what without values", () => {
    expect(describeAgreementEvent(event("created", { counterpartyType: "PARTNER", sourceMode: "MANUAL", platformCount: 2 })).detail).toBe("Draft version 1 opened (Partner Agreement · source: Manual).");
    expect(describeAgreementEvent(event("created", null)).detail).toBe("Draft version 1 opened.");
  });

  it("field_decided: names the field and the decision, never a value", () => {
    const view = describeAgreementEvent(event("field_decided", { fieldKey: "currency", decision: "ACCEPTED", version: 1 }));
    expect(view.detail).toBe("Currency: Accepted.");
    expect(describeAgreementEvent(event("field_decided", { fieldKey: "monthlyRequiredQualifyingContentCount", decision: "NOT_APPLICABLE" })).detail).toBe("Monthly required qualifying content: Not applicable.");
  });

  it("ignores an unknown field key rather than echoing it", () => {
    const view = describeAgreementEvent(event("field_decided", { fieldKey: "bankAccountNumber987654321", decision: "ACCEPTED" }));
    expect(view.detail).toBeNull();
    expect(JSON.stringify(view)).not.toContain("987654321");
  });

  it("extraction_attached: counts proposals that still need a decision", () => {
    expect(describeAgreementEvent(event("extraction_attached", { attachedCount: 12 })).detail).toBe("12 extracted values attached as proposals that still need a decision.");
    expect(describeAgreementEvent(event("extraction_attached", { attachedCount: 1 })).detail).toMatch(/^1 extracted value attached/);
  });

  it("confirmed / activated / superseded / revision", () => {
    expect(describeAgreementEvent(event("confirmed", { agreementType: "FIXED_ONLY", effectiveFrom: "2026-09-01", effectiveTo: "2027-08-31" })).detail).toBe("Terms frozen · Fixed only · 1 Sep 2026 – 31 Aug 2027.");
    expect(describeAgreementEvent(event("activated", { supersededVersion: 1 }, 2)).detail).toBe("Version 2 is now the current version and replaces version 1.");
    expect(describeAgreementEvent(event("activated", null, 1)).detail).toBe("Version 1 is now the current version.");
    expect(describeAgreementEvent(event("superseded", { supersededByVersion: 2 }, 1)).detail).toBe("Version 1 was replaced by version 2. It stays readable.");
    expect(describeAgreementEvent(event("revision_created", { previousVersion: 1, newVersion: 2 }, 2)).detail).toMatch(/^Version 2 opened as a revision of version 1\. Version 1 stays in force/);
  });

  it("suspend / end show the typed reason; resume does not need one", () => {
    expect(describeAgreementEvent(event("suspended", { reason: "Awaiting KYC refresh" })).detail).toBe("Reason: Awaiting KYC refresh");
    expect(describeAgreementEvent(event("ended", { reason: "Partner left" })).detail).toBe("Reason: Partner left");
    expect(describeAgreementEvent(event("suspended", null)).detail).toBeNull();
    expect(describeAgreementEvent(event("resumed", null)).detail).toBe("Version 1 is in force again.");
  });

  it("master data and KYC updates describe the action, not the value", () => {
    expect(describeAgreementEvent(event("master_data_updated", { fieldKey: "emailAddress", counterpartyType: "VENDOR", mode: "OVERWRITE_MISMATCH" })).detail).toBe("Email address on the Vendor record: replaced a different value after confirmation.");
    expect(describeAgreementEvent(event("master_data_updated", { fieldKey: "contactNumber", counterpartyType: "PARTNER", mode: "FILL_MISSING" })).detail).toBe("Contact number on the Partner record: filled a missing value.");
    expect(describeAgreementEvent(event("kyc_updated_from_agreement", { components: ["pan", "gst"] })).detail).toBe("KYC updated in the owning record: PAN, GST certificate.");
    expect(describeAgreementEvent(event("kyc_updated_from_agreement", null)).detail).toBe("KYC updated in the owning record.");
  });

  it("never renders anything beyond the allowlisted shapes (a smuggled value key is ignored)", () => {
    const view = describeAgreementEvent(event("confirmed", { agreementType: "FIXED_ONLY", panNumber: "ABCDE1234F", amountMinor: 3500000, rawSnippet: "secret clause" }));
    expect(JSON.stringify(view)).not.toMatch(/ABCDE1234F|3500000|secret clause/);
  });

  it("carries the version, the actor ref, the time and a tone that supports (never replaces) the label", () => {
    const view = describeAgreementEvent(event("suspended", { reason: "Hold" }, 3));
    expect(view).toMatchObject({ version: 3, actorRef: "usr_abc", tone: "orange", label: "Agreement suspended" });
    expect(view.at).toMatch(/2026/);
    expect(describeAgreementEvent(event("resumed", null)).tone).toBe("default");
  });
});
