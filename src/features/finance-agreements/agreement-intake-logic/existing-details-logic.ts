import type { AgreementKycComponentStatus } from "@/server/finance-agreements/kyc-status-service";
import type { CounterpartyPartnerAccountDto, CounterpartyPreviewDto } from "@/server/finance-agreements/workspace-dto";

import { formatPlatformName, kycComponentChip, kycStateChip, NO_VALUE_TEXT, NOT_AVAILABLE_IN_CREATOROPS, type ChipSpec } from "../format";
import { accountLabel } from "./agreement-for-ui";

// Step 14B intake, section 3 (`Existing CreatorOps details`): CreatorOps master data as display rows (pure). Only what the preview DTO
// carries is shown - ordinary facts and STATUS. A value CreatorOps does not hold (address, PIN) reads `Not available in CreatorOps`;
// it is never invented and never prefilled from anywhere else.

export type DetailRow = { key: string; label: string; value: string; muted?: boolean; chip?: ChipSpec };

const orDash = (text: string | null | undefined): string => (text && text.trim() ? text : NO_VALUE_TEXT);

export function contactRows(preview: CounterpartyPreviewDto): DetailRow[] {
  const rows: DetailRow[] = [
    { key: "name", label: preview.type === "PARTNER" ? "Partner name" : "Vendor name", value: orDash(preview.displayName) },
  ];
  if (preview.legalName) rows.push({ key: "legalName", label: "Legal name", value: preview.legalName });
  rows.push(
    { key: "phone", label: "Phone", value: orDash(preview.phone) },
    { key: "email", label: "Email", value: orDash(preview.email) },
    { key: "state", label: "State", value: preview.regions.length > 0 ? preview.regions.join(", ") : NO_VALUE_TEXT },
  );
  // Address / PIN: no canonical field exists. The DTO says so explicitly; the row is shown only for what it lists.
  for (const unavailable of preview.unavailableFields) {
    rows.push({ key: unavailable.fieldKey, label: unavailable.fieldKey === "address" ? "Address" : "PIN code", value: NOT_AVAILABLE_IN_CREATOROPS, muted: true });
  }
  return rows;
}

export function gstinStatusChip(status: CounterpartyPreviewDto["gstinStatus"]): ChipSpec {
  switch (status) {
    case "PRESENT":
      return { label: "On record", tone: "default" };
    case "MISSING":
      return { label: "Not on record", tone: "orange" };
    case "INCOMPLETE":
      return { label: "Incomplete", tone: "orange" };
    case "NOT_APPLICABLE":
      return { label: "Not applicable", tone: "gray" };
    default:
      return { label: "Restricted", tone: "purple" };
  }
}

export type KycRow = { key: "pan" | "aadhaar" | "gst" | "bank"; label: string; chip: ChipSpec };

// PAN / Aadhaar (Partner only) / Bank details / GST certificate as status chips. A component the actor may not see is `Restricted`.
export function kycRows(preview: CounterpartyPreviewDto): KycRow[] {
  const chipFor = (status: AgreementKycComponentStatus): ChipSpec => kycComponentChip(status);
  const rows: KycRow[] = [{ key: "pan", label: "PAN", chip: chipFor(preview.kyc.components.pan) }];
  if (preview.type === "PARTNER") rows.push({ key: "aadhaar", label: "Aadhaar", chip: chipFor(preview.kyc.components.aadhaar) });
  rows.push({ key: "bank", label: "Bank details", chip: chipFor(preview.kyc.components.bank) }, { key: "gst", label: "GST certificate", chip: chipFor(preview.kyc.components.gst) });
  return rows;
}

export const overallKycChip = (preview: CounterpartyPreviewDto): ChipSpec => kycStateChip(preview.kyc.state);

// The Partner Account / page identity lines: platform + handle (a display name alone never identifies an account).
export function accountRows(preview: CounterpartyPreviewDto): Array<{ key: string; platform: string; title: string; detail: string | null; inactive: boolean }> {
  return preview.partnerAccounts.map((account: CounterpartyPartnerAccountDto) => {
    const label = accountLabel(account);
    return { key: account.partnerAccountRef, platform: formatPlatformName(account.platform), title: label.title, detail: label.detail, inactive: account.status !== "ACTIVE" };
  });
}
