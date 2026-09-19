import { COMMERCIAL_EVIDENCE_POLICY_VERSION, type CommercialEvidence, type EvidenceLfcSfc, type EvidenceMonthlyDeliverable, type EvidenceSnapshot } from "./types";

// Step 13A.1 (revised): the explicit all-unavailable commercial shapes. Kept
// in its own dependency-free module (types only) so the actor-facing redaction
// and the handoff can present a version that has no commercial evidence
// without reaching the builder or any upstream reader.

export function unavailableDeliverable(reason: string, over: Partial<EvidenceMonthlyDeliverable> = {}): EvidenceMonthlyDeliverable {
  return {
    requiredCount: null,
    requirementSource: null,
    qualifyingUnit: null,
    actualQualifyingCount: null,
    actualCountSources: null,
    variance: null,
    evaluation: "unavailable",
    unavailableReason: reason,
    affectsPayment: false,
    ...over,
  };
}

export function unavailableLfcSfc(reason: string, over: Partial<EvidenceLfcSfc> = {}): EvidenceLfcSfc {
  return {
    status: "unavailable",
    unavailableReason: reason,
    ruleRef: null,
    ruleSource: null,
    qualifyingUnit: null,
    qualifyingUnitSource: null,
    lfcCount: null,
    sfcCount: null,
    unclassifiedCount: null,
    units: [],
    affectsPayment: false,
    ...over,
  };
}

// What a version with no governing policy holds, and what an old stored
// version (which has no `commercial` key) is presented as.
export function neutralCommercialEvidence(): CommercialEvidence {
  return {
    policyVersion: COMMERCIAL_EVIDENCE_POLICY_VERSION,
    governingAgreement: null,
    monthlyDeliverable: unavailableDeliverable("no_agreement_requirement"),
    lfcSfc: unavailableLfcSfc("no_agreement_rule"),
    targets: [],
  };
}

// Every reader goes through this so an old stored version reads as neutral.
export function commercialOrNeutral(snapshot: Pick<EvidenceSnapshot, "commercial">): CommercialEvidence {
  return snapshot.commercial ?? neutralCommercialEvidence();
}
