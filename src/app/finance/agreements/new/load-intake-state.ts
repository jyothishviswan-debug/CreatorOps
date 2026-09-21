// Step 14B intake: SERVER-side seeding of the intake page (imported by the server page only - it reads the Finance services directly;
// it lives beside the route, not in the feature folder, because the feature folder is browser-safe and imports server code type-only).
// Everything the form needs to render its first frame is resolved here BEFORE render, so nothing about access is decided in the browser
// and no control is revealed and then hidden:
//   - the permissions object (computeFinanceAgreementPermissions, for the resumed Agreement's counterparty type or the deep link's);
//   - for a RESUMED draft / revision: the Agreement detail, its reconciliation, KYC status, the latest extraction (+ its artifact), the
//     counterparty's master-data preview and, for a revision, the prior confirmed terms to diff against;
//   - for a deep link (?counterpartyType=&ref=): the preselected counterparty's preview;
//   - for a create-new deep link (?counterpartyType=&mode=new): the "Create new Partner / Vendor from Agreement" choice already made (Step 14B.1).
//   The permissions object also carries the OWNING modules' create rights (canCreatePartner / canCreateVendor / canManagePartnerAccounts), computed
//   here on the server, so the wizard's final step is rendered enabled or disabled-with-a-reason from the first frame - never revealed then hidden.
// A missing / forged / out-of-scope reference is ONE neutral not_found; every other refusal is ONE neutral denied. Never distinguished.
import type { ActorContext } from "@/server/authz/types";
import {
  computeFinanceAgreementPermissions,
  getAgreementDetail,
  getAgreementKycStatus,
  getAgreementReconciliation,
  getContractArtifactSummary,
  getCounterpartyPreview,
  getExtractionResult,
} from "@/server/finance-agreements";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import type { IntakeProviderProps } from "@/features/finance-agreements/intake/intake-context";
import { findPriorConfirmedVersion, intakeRouteKey, type IntakeUrlParams } from "@/features/finance-agreements/intake/intake-logic";

export type IntakePageState =
  | { kind: "denied" }
  | { kind: "not_found" }
  | { kind: "ready"; routeKey: string; permissions: FinanceAgreementPermissionsDto; initial: NonNullable<IntakeProviderProps["initial"]>; mode: "new" | "resume"; title: string };

export const INTAKE_TITLES = { new: "New Agreement", draft: "Agreement draft", revision: "Agreement revision", view: "Agreement" } as const;

export async function loadIntakePageState(actor: ActorContext | null, params: IntakeUrlParams): Promise<IntakePageState> {
  if (params.agreementRef) return loadResume(actor, params);
  return loadNew(actor, params);
}

async function loadNew(actor: ActorContext | null, params: IntakeUrlParams): Promise<IntakePageState> {
  const permissions = await computeFinanceAgreementPermissions(actor, params.counterpartyType);
  // Starting a draft needs manage_agreements; a viewer has nothing to do on the new-Agreement form.
  if (!permissions.canView || !permissions.canManage) return { kind: "denied" };

  const initial: NonNullable<IntakeProviderProps["initial"]> = {};
  if (params.mode === "new" && params.counterpartyType) {
    // Create-new deep link: no counterparty exists yet, so nothing is looked up (a ref in the URL is ignored). A person who may review but not
    // create still opens the wizard - the final step tells them why it is disabled.
    initial.onboarding = { mode: "new", counterpartyType: params.counterpartyType };
  } else if (params.counterpartyType && params.ref) {
    // A deep link only PRESELECTS: a counterparty that is not visible to this actor simply starts the form empty (nothing is echoed).
    const preview = await getCounterpartyPreview(actor, { type: params.counterpartyType, ref: params.ref });
    if (preview.ok) initial.preview = preview.data;
  }
  return { kind: "ready", routeKey: intakeRouteKey(params), permissions, initial, mode: "new", title: INTAKE_TITLES.new };
}

async function loadResume(actor: ActorContext | null, params: IntakeUrlParams): Promise<IntakePageState> {
  const agreementRef = params.agreementRef!;
  const detail = await getAgreementDetail(actor, agreementRef, params.version !== null ? { version: params.version } : {});
  if (!detail.ok) return detail.code === "not_found" || detail.code === "invalid_input" ? { kind: "not_found" } : { kind: "denied" };
  const agreement = detail.data;
  const selected = agreement.selectedVersion;
  if (!selected) return { kind: "not_found" };

  const type = agreement.head.counterparty.type;
  const permissions = await computeFinanceAgreementPermissions(actor, type);
  if (!permissions.canView) return { kind: "denied" };

  const priorVersion = selected.status === "DRAFT" && selected.version > 1 ? findPriorConfirmedVersion(agreement.versions, selected.version) : null;

  const [reconciliation, kyc, extraction, preview, prior] = await Promise.all([
    getAgreementReconciliation(actor, { agreementRef, version: selected.version }),
    getAgreementKycStatus(actor, agreementRef),
    getExtractionResult(actor, { agreementRef }),
    // The preview needs manage_agreements; a read-only viewer sees the Agreement without it.
    permissions.canManage ? getCounterpartyPreview(actor, { type, ref: agreement.head.counterparty.ref }) : Promise.resolve(null),
    priorVersion !== null ? getAgreementDetail(actor, agreementRef, { version: priorVersion }) : Promise.resolve(null),
  ]);

  const initial: NonNullable<IntakeProviderProps["initial"]> = { agreement };
  if (reconciliation.ok) initial.reconciliation = reconciliation.data;
  if (kyc.ok) initial.kyc = kyc.data;
  if (extraction.ok) initial.extraction = extraction.data;
  if (preview && preview.ok) initial.preview = preview.data;

  const artifactRef = extraction.ok ? extraction.data.run.artifactRef : selected.source.contractArtifactRef;
  if (artifactRef) {
    const artifact = await getContractArtifactSummary(actor, artifactRef);
    if (artifact.ok) initial.artifact = artifact.data;
  }

  const priorSelected = prior && prior.ok ? prior.data.selectedVersion : null;
  if (priorVersion !== null && priorSelected) {
    initial.revisionBase = { terms: priorSelected.terms, contactSnapshot: priorSelected.contactSnapshot };
    initial.revisionBaseVersion = priorVersion;
  }

  const title = selected.status !== "DRAFT" || selected.confirmed ? INTAKE_TITLES.view : selected.version > 1 ? INTAKE_TITLES.revision : INTAKE_TITLES.draft;
  return { kind: "ready", routeKey: intakeRouteKey(params), permissions, initial, mode: "resume", title };
}
