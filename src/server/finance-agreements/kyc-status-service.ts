import type { ActorContext } from "@/server/authz/types";
import { getRestrictedFinancialIdentityDoc } from "@/server/shared/restricted-financial-identity";

import { loadAuthorizedAgreement, requireIdentitySensitiveAccess } from "./finance-agreements-gate";
import { computeIdentityStatus } from "./identity-status";
import type { CounterpartyType, FinanceAgreementsServiceResult, IdentityComponentStatus } from "./types";

// Step 14A: the KYC STATUS of an Agreement's counterparty - status only, never a value.
//
//   state       AVAILABLE | MISSING | INCOMPLETE | UNAVAILABLE - visible to ANY actor authorized for
//               the Agreement (finance view + live Record Scope). It is computed by the same
//               computeIdentityStatus the confirm step uses, from the canonical restricted store; AVAILABLE
//               needs PAN + bank (+ GST when it applies). RESTRICTED is part of the contract's state
//               vocabulary but is not emitted: the state itself is not the restricted part.
//   components  per-component detail only with the counterparty's identity category (payment_details for
//               a Partner, vendor_payment_details for a Vendor); otherwise every component is RESTRICTED.
//   valuesVisible  whether the actor holds that category (i.e. may see the values through the OWNING
//               module). This DTO never carries a value either way.
//   evidenceTypesPresent  which document evidence TYPES exist (pan/aadhaar/gst/bank/other) - names only,
//               never a link or file name - and only with the identity category.
//
// Fails CLOSED: if the store cannot be read the state is UNAVAILABLE and no component is ever
// reported PRESENT, so an unreadable store can never make a counterparty look KYC-complete.

export const AGREEMENT_KYC_STATES = ["AVAILABLE", "MISSING", "INCOMPLETE", "RESTRICTED", "UNAVAILABLE"] as const;
export type AgreementKycState = (typeof AGREEMENT_KYC_STATES)[number];

export type AgreementKycComponentStatus = IdentityComponentStatus | "RESTRICTED";
export type AgreementKycComponents = { pan: AgreementKycComponentStatus; aadhaar: AgreementKycComponentStatus; gst: AgreementKycComponentStatus; bank: AgreementKycComponentStatus };

export type AgreementKycStatusDto = {
  agreementRef: string;
  counterpartyType: CounterpartyType;
  state: AgreementKycState;
  components: AgreementKycComponents;
  valuesVisible: boolean;
  evidenceTypesPresent?: string[];
};

const RESTRICTED_COMPONENTS: AgreementKycComponents = { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" };

export async function getAgreementKycStatus(actor: ActorContext | null, agreementRef: unknown): Promise<FinanceAgreementsServiceResult<AgreementKycStatusDto>> {
  const loaded = await loadAuthorizedAgreement(actor, typeof agreementRef === "string" ? agreementRef : "");
  if (!loaded.ok) return loaded.error;
  const { head, counterpartyType } = loaded.authorized;

  const identityCategory = await requireIdentitySensitiveAccess(actor!, counterpartyType);
  const valuesVisible = identityCategory.ok;
  const subjectUid = (counterpartyType === "PARTNER" ? head.partnerUid : head.vendorUid) ?? "";

  // computeIdentityStatus already fails to UNAVAILABLE; this outer guard keeps a thrown error from ever escaping as anything but UNAVAILABLE.
  let status: Awaited<ReturnType<typeof computeIdentityStatus>>;
  try {
    status = await computeIdentityStatus(counterpartyType, subjectUid);
  } catch {
    status = { state: "UNAVAILABLE", components: { pan: "MISSING", aadhaar: counterpartyType === "VENDOR" ? "NOT_APPLICABLE" : "MISSING", gst: "MISSING", bank: "MISSING" }, capturedAt: new Date().toISOString() };
  }

  const dto: AgreementKycStatusDto = {
    agreementRef: head.agreementRef,
    counterpartyType,
    state: status.state,
    components: valuesVisible ? status.components : RESTRICTED_COMPONENTS,
    valuesVisible,
  };

  if (valuesVisible && status.state !== "UNAVAILABLE") {
    try {
      const doc = await getRestrictedFinancialIdentityDoc(counterpartyType, subjectUid);
      dto.evidenceTypesPresent = [...new Set((doc?.evidence ?? []).map((item) => item.docType))].sort();
    } catch {
      // Evidence presence is optional detail; leave it out rather than guess.
    }
  }
  return { ok: true, data: dto };
}
