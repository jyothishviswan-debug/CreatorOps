import type { AgreementHeadDto, AgreementVersionDto, AgreementVersionSummaryDto } from "@/server/finance-agreements/client-dto";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import type { RevisionChanges } from "./revision-changes";

// The one view of the page every tab receives (all actor-safe DTOs; no Firestore doc, no scope internals).
export type TabContext = {
  head: AgreementHeadDto;
  versions: AgreementVersionSummaryDto[];
  hasMoreVersions: boolean;
  permissions: FinanceAgreementPermissionsDto;
  // The version being viewed (default: the one that governs) - its summary always exists, its full document may still be loading.
  viewNumber: number;
  viewed: AgreementVersionSummaryDto | null;
  viewedDoc: AgreementVersionDto | null;
  // The counterpart a change is measured against (see priorVersionNumber) and the resulting changed fields, when there is one.
  priorDoc: AgreementVersionDto | null;
  revision: RevisionChanges | null;
  // The OPEN version's document (an unconfirmed draft or a confirmed replacement waiting for activation) and, when it replaces an earlier
  // version, its changed fields - shown on the Overview whichever version is being viewed.
  openDoc: AgreementVersionDto | null;
  openRevision: RevisionChanges | null;
  counterpartyName: string;
  reconciliation: AgreementReconciliationDto | null;
  reconciliationState: "ready" | "loading" | "error";
  kycStatus: AgreementKycStatusDto | null;
};
