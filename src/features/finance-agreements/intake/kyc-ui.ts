import type { ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementKycComponentStatus, AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementEntryDecision, CounterpartyType } from "@/server/finance-agreements/types";

import type { KycEvidenceDocType } from "../api-client";
import { KYC_AVAILABLE_NOTE, KYC_COMPONENT_LABELS, counterpartyTypeLabel, kycComponentChip, type ChipSpec, type KycComponentKey } from "../format";

// Step 14B intake (KYC & restricted details): the display rules of the section and of its `Upload / Update KYC` dialog (pure).
// KYC lives ONLY in the Partner / Vendor record. This screen shows its STATUS, and - for a person who is authorized - offers the owning
// module's own ways to add to it. Nothing here ever holds or shows a value.

export type KycRowKind = "available" | "missing" | "restricted" | "unavailable" | "not_applicable";

export type KycRowView = {
  component: KycComponentKey;
  label: string;
  chip: ChipSpec;
  kind: KycRowKind;
  message: string;
  // Offer `Upload / Update KYC` for this component.
  canUpload: boolean;
};

export const KYC_UNAVAILABLE_CHIP: ChipSpec = { label: "Unavailable", tone: "gray" };

// Aadhaar is a Partner-only component.
export function applicableKycComponents(type: CounterpartyType): KycComponentKey[] {
  return type === "PARTNER" ? ["pan", "aadhaar", "bank", "gst"] : ["pan", "bank", "gst"];
}

export type BuildKycRowsInput = {
  counterpartyType: CounterpartyType;
  // null while the status has not loaded (or could not be read).
  kyc: Pick<AgreementKycStatusDto, "state" | "components"> | null;
  // The owning identity category for this counterparty type AND the owning manage action.
  canViewIdentity: boolean;
  canManageKyc: boolean;
};

export function buildKycRows(input: BuildKycRowsInput): KycRowView[] {
  const noun = counterpartyTypeLabel(input.counterpartyType);
  const mayAdd = input.canViewIdentity && input.canManageKyc;
  return applicableKycComponents(input.counterpartyType).map((component) => {
    const label = KYC_COMPONENT_LABELS[component];
    const status: AgreementKycComponentStatus | null = !input.kyc || input.kyc.state === "UNAVAILABLE" ? null : input.kyc.components[component];
    if (status === null) return { component, label, chip: KYC_UNAVAILABLE_CHIP, kind: "unavailable", message: "The KYC status could not be read right now.", canUpload: false } satisfies KycRowView;
    if (status === "PRESENT") return { component, label, chip: kycComponentChip(status), kind: "available", message: KYC_AVAILABLE_NOTE, canUpload: false } satisfies KycRowView;
    if (status === "NOT_APPLICABLE") return { component, label, chip: kycComponentChip(status), kind: "not_applicable", message: `Not required for this ${noun}.`, canUpload: false } satisfies KycRowView;
    if (status === "RESTRICTED") return { component, label, chip: kycComponentChip(status), kind: "restricted", message: "Restricted. Only the overall status is visible to you.", canUpload: false } satisfies KycRowView;
    return {
      component,
      label,
      chip: kycComponentChip(status),
      kind: "missing",
      message: mayAdd ? `Not in the ${noun} record yet.` : `Not in the ${noun} record yet. Someone with KYC access can add it.`,
      canUpload: mayAdd,
    } satisfies KycRowView;
  });
}

// --- The dialog ---------------------------------------------------------------------------------------------------------------------------------
// The Agreement identity field a component is applied from (bank cannot be applied from a contract at all).
export const KYC_APPLY_FIELD: Record<Exclude<KycComponentKey, "bank">, AgreementFieldKey> = { pan: "panNumber", aadhaar: "aadhaarNumber", gst: "gstin" };

export const KYC_DOC_TYPES: Record<KycComponentKey, KycEvidenceDocType> = { pan: "pan", aadhaar: "aadhaar", gst: "gst", bank: "bank" };

export type KycApplyOption = { available: boolean; reasons: string[] };

export type KycApplyInput = {
  component: KycComponentKey;
  counterpartyType: CounterpartyType;
  // none = no extraction yet; not_attached = extracted but not attached to this draft; attached.
  extractionState: "none" | "not_attached" | "attached";
  // The attached extraction carries a usable value for this component that this person may use (extractionHasIdentityValue).
  extractedValueUsable: boolean;
  // The Agreement's decision on the matching identity field (a human must have accepted the value found in the Agreement).
  identityDecision: AgreementEntryDecision | null;
  canViewContractDetail: boolean;
  canManageKyc: boolean;
  canViewIdentity: boolean;
  // The component is empty in the record (this option fills a MISSING component only).
  componentMissing: boolean;
};

export const BANK_NOT_FROM_CONTRACT = "Bank details cannot be applied from a contract: the bank record also needs the holder name, bank name and branch. Add them on the Partner / Vendor record.";

// Option (a): `Apply KYC values found in the Agreement`. Available only when every condition the server checks holds, so the person is
// told what is missing instead of getting a refusal.
export function evaluateApplyOption(input: KycApplyInput): KycApplyOption {
  if (input.component === "bank") return { available: false, reasons: [BANK_NOT_FROM_CONTRACT] };
  const reasons: string[] = [];
  const label = KYC_COMPONENT_LABELS[input.component];
  if (input.component === "aadhaar" && input.counterpartyType === "VENDOR") reasons.push("Aadhaar applies to Partners only.");
  if (!input.canManageKyc || !input.canViewIdentity) reasons.push("You do not have access to update KYC in the Partner / Vendor record.");
  if (!input.canViewContractDetail) reasons.push("You need access to contract details to apply values found in the Agreement.");
  if (!input.componentMissing) reasons.push(`${label} is already in the record. Replacing it is a separate step in Cross-verification.`);
  if (input.extractionState === "none") reasons.push("Extract the Agreement first.");
  else if (input.extractionState === "not_attached") reasons.push("Attach the extracted values to this draft first.");
  else if (!input.extractedValueUsable) reasons.push(`The extraction found no ${label} value you can use.`);
  if (input.identityDecision !== "ACCEPTED") reasons.push(`Confirm the ${label} found in the Agreement in Cross-verification first.`);
  return { available: reasons.length === 0, reasons };
}

// Whether the extraction carries a usable (visible, non-empty) value for the component.
export function extractionHasIdentityValue(extraction: Pick<ExtractionResultDto, "fields" | "identityValuesVisible"> | null, component: Exclude<KycComponentKey, "bank">): boolean {
  if (!extraction || !extraction.identityValuesVisible) return false;
  const key = KYC_APPLY_FIELD[component];
  return extraction.fields.some((field) => field.fieldKey === key && field.valueState === "VISIBLE" && field.normalizedValue !== null && field.normalizedValue !== undefined && String(field.normalizedValue).length > 0);
}

// Option (c): the owning record's page, where identity details are entered by hand.
export function owningRecordHref(type: CounterpartyType, ref: string): string {
  return `${type === "PARTNER" ? "/partners" : "/vendors"}/${encodeURIComponent(ref)}`;
}

// A link to attach as evidence: an http(s) URL of a sane length.
export function validateEvidenceLink(text: string): { ok: true; value: string } | { ok: false; message: string } {
  const value = text.trim();
  if (value.length === 0) return { ok: false, message: "Enter the link to the document." };
  if (value.length > 1000) return { ok: false, message: "The link is too long (at most 1,000 characters)." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Enter a full link that starts with https://." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, message: "Enter a full link that starts with https://." };
  return { ok: true, value };
}

export const EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;

// A document to upload: non-empty, at most 15 MB (the owning module's limit; the server is the truth).
export function validateEvidenceFile(file: { name: string; size: number }): string | null {
  if (file.size <= 0) return "This file is empty.";
  if (file.size > EVIDENCE_MAX_BYTES) return "This file is larger than 15 MB.";
  return null;
}

// The overall line above the component rows.
export function kycHeadline(kyc: Pick<AgreementKycStatusDto, "state"> | null): string {
  if (!kyc) return "KYC status has not loaded yet.";
  switch (kyc.state) {
    case "AVAILABLE":
      return KYC_AVAILABLE_NOTE;
    case "MISSING":
      return "KYC is missing from the Partner / Vendor record.";
    case "INCOMPLETE":
      return "KYC in the Partner / Vendor record is incomplete.";
    case "RESTRICTED":
      return "KYC details are restricted. Only the overall status is visible to you.";
    default:
      return "The KYC status could not be read right now.";
  }
}
