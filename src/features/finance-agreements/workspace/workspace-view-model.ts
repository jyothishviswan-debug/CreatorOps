// Step 14B: the PURE row -> view-model mapping of the Agreements workspace. Everything a row renders is decided here (labels,
// chip specs, hrefs), so the table, the card view and the tests all read one source. It only ever reads fields of the
// allowlisted AgreementWorkspaceRowDto: no restricted value, storage locator or scope internal can appear.
import type { AgreementWorkspacePrimaryActionKind, AgreementWorkspaceRowDto } from "@/server/finance-agreements/workspace-dto";
import type { CounterpartyType } from "@/server/finance-agreements/types";

import {
  agreementTypeLabel,
  counterpartyTypeLabel,
  extractionStatusChip,
  formatEffectivePeriod,
  formatInstant,
  formatPlatformName,
  formatRelativeInstant,
  kycStateChip,
  lifecycleDisplayChip,
  PRIMARY_ACTION_LABELS,
  type ChipSpec,
  type PillTone,
} from "../format";

export const AGREEMENTS_BASE_HREF = "/finance/agreements";
export const NEW_AGREEMENT_HREF = `${AGREEMENTS_BASE_HREF}/new`;

// --- Hrefs (refs are opaque ids; always encoded) ------------------------------------------------------------------------------------
export function agreementDetailHref(agreementRef: string, options: { tab?: string } = {}): string {
  const base = `${AGREEMENTS_BASE_HREF}/${encodeURIComponent(agreementRef)}`;
  return options.tab ? `${base}?tab=${encodeURIComponent(options.tab)}` : base;
}

// The intake editor resumes a draft (or a revision in progress) from `?agreementRef=&version=`.
export function agreementDraftHref(agreementRef: string, version: number | null): string {
  const search = new URLSearchParams({ agreementRef });
  if (version !== null && Number.isInteger(version) && version > 0) search.set("version", String(version));
  return `${NEW_AGREEMENT_HREF}?${search.toString()}`;
}

// The primary button's destination by kind. The destination re-checks everything server-side; this is only a hint:
//   CONTINUE_DRAFT   -> the intake editor on the open version
//   REVIEW / OPEN    -> the Agreement detail
//   CREATE_REVISION  -> the detail's Versions tab (it hosts the confirmation dialog)
export function primaryActionHref(input: { agreementRef: string; kind: AgreementWorkspacePrimaryActionKind; version: number | null; openVersion: number | null }): string {
  switch (input.kind) {
    case "CONTINUE_DRAFT":
      return agreementDraftHref(input.agreementRef, input.version ?? input.openVersion);
    case "CREATE_REVISION":
      return agreementDetailHref(input.agreementRef, { tab: "versions" });
    case "REVIEW":
    case "OPEN":
    default:
      return agreementDetailHref(input.agreementRef);
  }
}

// --- Row view model -----------------------------------------------------------------------------------------------------------------
export type WorkspaceRowView = {
  key: string;
  agreementRef: string;
  detailHref: string;
  counterpartyName: string;
  counterpartyType: CounterpartyType;
  counterpartyTypeLabel: string;
  counterpartyTypeTone: PillTone;
  // Display names ("Instagram", "YouTube"); empty for a Vendor or an Agreement with no platform scope.
  platforms: string[];
  // The Agreement reference (the opaque, stable id) and, when one was captured, the Agreement number from the document.
  reference: string;
  agreementNumber: string | null;
  versionLabel: string;
  // A revision (a second version) is open while another governs.
  revisionNote: string | null;
  lifecycle: ChipSpec;
  effective: string;
  commercialType: string;
  commercialTypeSet: boolean;
  kyc: ChipSpec;
  extraction: ChipSpec | null;
  extractionText: string;
  unresolvedCount: number;
  unresolvedText: string;
  lastUpdated: string;
  lastUpdatedTitle: string;
  lastUpdatedIso: string;
  primary: { kind: AgreementWorkspacePrimaryActionKind; label: string; href: string; emphasis: boolean; ariaLabel: string };
};

export const NOT_SET_TEXT = "Not set";
export const NO_EXTRACTION_TEXT = "No extraction";

export function unresolvedFieldsText(count: number): string {
  if (count <= 0) return "No unresolved fields";
  return `${count} unresolved ${count === 1 ? "field" : "fields"}`;
}

export function versionLabelOf(version: number): string {
  return `Version ${version}`;
}

export function initialsOfName(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "");
  const text = letters.join("").toUpperCase();
  return text || "?";
}

export function toWorkspaceRowView(row: AgreementWorkspaceRowDto): WorkspaceRowView {
  const name = row.counterparty.displayName.trim() || "Unnamed counterparty";
  const isPartner = row.counterparty.type === "PARTNER";
  const kind = row.primaryAction.kind;
  const label = PRIMARY_ACTION_LABELS[kind];
  const href = primaryActionHref({ agreementRef: row.agreementRef, kind, version: row.primaryAction.version, openVersion: row.openVersion });
  const revisionOpen = row.openVersion !== null && row.openVersion !== row.currentVersion;
  const agreementNumber = row.agreementNumber?.trim() || null;

  return {
    key: row.agreementRef,
    agreementRef: row.agreementRef,
    detailHref: agreementDetailHref(row.agreementRef),
    counterpartyName: name,
    counterpartyType: row.counterparty.type,
    counterpartyTypeLabel: counterpartyTypeLabel(row.counterparty.type),
    counterpartyTypeTone: isPartner ? "blue" : "purple",
    platforms: isPartner ? row.counterparty.platformScope.map(formatPlatformName) : [],
    reference: row.agreementRef,
    agreementNumber,
    versionLabel: versionLabelOf(row.currentVersion),
    revisionNote: revisionOpen ? `Revision open: version ${row.openVersion}` : null,
    lifecycle: lifecycleDisplayChip(row.lifecycle, row.awaitingActivation),
    effective: row.effectiveFrom || row.effectiveTo ? formatEffectivePeriod(row.effectiveFrom, row.effectiveTo) : NOT_SET_TEXT,
    commercialType: row.agreementType ? agreementTypeLabel(row.agreementType) : NOT_SET_TEXT,
    commercialTypeSet: row.agreementType !== null,
    // Status ONLY: the components are never rendered in a row.
    kyc: kycStateChip(row.kyc.state),
    extraction: row.extractionStatus ? extractionStatusChip(row.extractionStatus) : null,
    extractionText: row.extractionStatus ? extractionStatusChip(row.extractionStatus).label : NO_EXTRACTION_TEXT,
    unresolvedCount: row.unresolvedFieldCount,
    unresolvedText: unresolvedFieldsText(row.unresolvedFieldCount),
    lastUpdated: formatRelativeInstant(row.lastUpdatedAt),
    lastUpdatedTitle: formatInstant(row.lastUpdatedAt),
    lastUpdatedIso: row.lastUpdatedAt,
    primary: {
      kind,
      label,
      href,
      // Orange = action: only a draft awaiting work is the emphasized call to action.
      emphasis: kind === "CONTINUE_DRAFT",
      ariaLabel: `${label} - ${name}, Agreement ${agreementNumber ?? row.agreementRef}`,
    },
  };
}
