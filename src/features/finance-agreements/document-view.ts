import type { AgreementDocumentDto, AgreementDocumentStatusDto, AgreementHeadDto, AgreementVersionSummaryDto, CounterpartyAgreementDocumentDto } from "@/server/finance-agreements/client-dto";

import {
  AGREEMENT_DOCUMENT_ON_FILE,
  DRIVE_NOT_CONFIGURED_TEXT,
  NO_NEW_SIGNED_DOCUMENT_TEXT,
  STORE_AGREEMENT_DOCUMENT_LABEL,
  documentStatusChip,
  formatInstant,
  lifecycleDisplayLabel,
  type ChipSpec,
} from "./format";

// Step 14B.1: the ORIGINAL signed Agreement document, as the browser shows it (pure view-models; unit-tested).
//
// The server decides everything that matters and the UI mirrors it - nothing is inferred here:
//   - the status (STORED | PENDING | FAILED | NOT_CONFIGURED | NOT_APPLICABLE) and whether a store / retry is meaningful (`canStore`);
//   - whether the actor may see the Drive link at all (`link` exists ONLY for holders of the contract-detail category);
//   - whether activation is blocked (the same rule the activate service enforces: `agreement_document_not_stored`).
// A version with no signed file of its own is NOT_APPLICABLE and says so honestly - the prior version's file is never presented as its own.

// --- The store / retry button ---------------------------------------------------------------------------------------------------------------------
export type DocumentActionKind = "store" | "retry";
export type DocumentAction = { kind: DocumentActionKind; label: string; busyLabel: string };

export type DocumentView = {
  status: AgreementDocumentStatusDto;
  chip: ChipSpec;
  fileName: string | null;
  // "Stored 14 Sep 2026, 10:24" (only when STORED).
  storedAtText: string | null;
  // One plain sentence about the state.
  headline: string;
  // A second sentence of explanation (a server failure text, or the honest copy for a version without a document of its own).
  note: string | null;
  // The Drive link - ONLY when the server DTO carries it (a holder of the contract-detail category).
  link: string | null;
  // STORED but no link for this actor: a neutral "on file" line, never a link.
  onFileText: string | null;
  // Present only when the server says a store / retry is meaningful AND this person may manage Agreements.
  action: DocumentAction | null;
};

export const STORING_TEXT = "Storing the original Agreement…";

// The server sends a Drive link only to a holder of the contract-detail category. A link is still rendered only when it is a plain http(s) URL -
// never a script / data URL, whatever a stored value might be.
export function safeDocumentLink(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? link : null;
  } catch {
    return null;
  }
}

export function buildDocumentView(input: { document: AgreementDocumentDto; canManage: boolean }): DocumentView {
  const { document, canManage } = input;
  const chip = documentStatusChip(document.status);
  const action: DocumentAction | null =
    document.canStore && canManage ? { kind: document.status === "PENDING" ? "store" : "retry", label: document.status === "PENDING" ? STORE_AGREEMENT_DOCUMENT_LABEL : "Retry", busyLabel: "Storing…" } : null;
  const base = { status: document.status, chip, fileName: document.fileName, storedAtText: null, link: null, onFileText: null, action } satisfies Omit<DocumentView, "headline" | "note">;

  switch (document.status) {
    case "STORED":
      return {
        ...base,
        headline: "The original signed Agreement is stored in Drive.",
        note: null,
        storedAtText: document.storedAt ? `Stored ${formatInstant(document.storedAt)}` : null,
        link: safeDocumentLink(document.link),
        onFileText: safeDocumentLink(document.link) ? null : AGREEMENT_DOCUMENT_ON_FILE,
        action: null,
      };
    case "PENDING":
      return document.canStore
        ? { ...base, headline: "The original signed Agreement is not stored yet.", note: "It is kept safely until it is stored. A version with its own signed file must have it stored before it can be activated." }
        : { ...base, headline: "The original signed Agreement is stored after this version is confirmed.", note: null, action: null };
    case "FAILED":
      return {
        ...base,
        headline: "The original signed Agreement could not be stored.",
        note: `${document.message ?? "The document could not be stored."} Nothing was recorded as stored and the original file is kept.${action ? " Retry to store it." : ""}`,
      };
    case "NOT_CONFIGURED":
      return { ...base, headline: `${DRIVE_NOT_CONFIGURED_TEXT}.`, note: `The original signed Agreement is kept safely and can be stored once Drive storage is set up${action ? ". Then retry" : ""}.` };
    default:
      return {
        ...base,
        headline: NO_NEW_SIGNED_DOCUMENT_TEXT,
        note: "Earlier versions keep their own documents. None is presented as belonging to this version.",
        action: null,
      };
  }
}

// --- The result of a store / retry call ------------------------------------------------------------------------------------------------------------------
export type StoreOutcomeLike = { outcome: "stored" | "already_stored" | "failed"; document: Pick<AgreementDocumentDto, "message" | "status"> };
export type DocumentNotice = { tone: "success" | "error"; text: string };

export function describeStoreOutcome(result: StoreOutcomeLike): DocumentNotice {
  if (result.outcome === "stored") return { tone: "success", text: "The original signed Agreement is stored." };
  if (result.outcome === "already_stored") return { tone: "success", text: "The original signed Agreement was already stored." };
  const reason = result.document.status === "NOT_CONFIGURED" ? `${DRIVE_NOT_CONFIGURED_TEXT}.` : (result.document.message ?? "It could not be stored.");
  return { tone: "error", text: `The Agreement document was not stored. ${reason} You can retry.` };
}

// --- Activation readiness (mirrors the server rule) ---------------------------------------------------------------------------------------------------
// A version that has its OWN signed file must have it STORED before it can be activated; a version without one (manual entry, or a revision
// without a new signed file) is never blocked. The server enforces this (`agreement_document_not_stored`); this mirrors it from the DTO so the button
// state matches and nobody presses a button that is certain to be refused.
export type ActivationDocumentGate = { blocked: boolean; reason: string | null };

export const ACTIVATION_NEEDS_STORE_TEXT = "Store the signed Agreement document before activating this version.";

export function activationDocumentGate(document: Pick<AgreementDocumentDto, "status" | "message"> | null | undefined): ActivationDocumentGate {
  if (!document || document.status === "STORED" || document.status === "NOT_APPLICABLE") return { blocked: false, reason: null };
  if (document.status === "NOT_CONFIGURED") return { blocked: true, reason: `The signed Agreement document is not stored: ${DRIVE_NOT_CONFIGURED_TEXT}. Configure Drive storage, then store the document before activating.` };
  if (document.status === "FAILED") return { blocked: true, reason: `The signed Agreement document could not be stored yet${document.message ? ` (${document.message})` : ""}. Retry storing it before activating.` };
  return { blocked: true, reason: ACTIVATION_NEEDS_STORE_TEXT };
}

// --- Review & confirm: the state right after Confirm ----------------------------------------------------------------------------------------------------
export type ReviewDocumentPhase = "storing" | "stored" | "not_applicable" | "pending" | "failed";
export type ReviewDocumentState = { phase: ReviewDocumentPhase; chip: ChipSpec; text: string; note: string | null; action: DocumentAction | null };

// null while the version is not confirmed (nothing is stored before confirmation).
export function reviewDocumentState(input: { confirmed: boolean; document: AgreementDocumentDto | null; storing: boolean; canManage: boolean }): ReviewDocumentState | null {
  if (!input.confirmed || !input.document) return null;
  const view = buildDocumentView({ document: input.document, canManage: input.canManage });
  if (input.storing) return { phase: "storing", chip: { label: "Storing", tone: "blue" }, text: STORING_TEXT, note: null, action: null };
  switch (input.document.status) {
    case "STORED":
      return { phase: "stored", chip: view.chip, text: "Stored. The original signed Agreement is in Drive.", note: view.link ? null : view.onFileText, action: null };
    case "NOT_APPLICABLE":
      return { phase: "not_applicable", chip: view.chip, text: NO_NEW_SIGNED_DOCUMENT_TEXT, note: null, action: null };
    case "PENDING":
      return { phase: "pending", chip: view.chip, text: "The original signed Agreement is not stored yet.", note: null, action: view.action };
    default:
      return { phase: "failed", chip: view.chip, text: view.headline, note: view.note, action: view.action };
  }
}

// --- Overview panel: which versions get a row ---------------------------------------------------------------------------------------------------------------
export type DocumentPanelRow = { version: number; roleText: string; document: AgreementDocumentDto };

// The version being viewed, plus the OPEN version when it is a different, confirmed one (a replacement waiting for activation: its document has to be
// stored before it can be activated, so its state and its store button belong on the Overview whichever version is being viewed).
export function documentPanelRows(input: { versions: readonly Pick<AgreementVersionSummaryDto, "version" | "confirmed" | "document">[]; head: Pick<AgreementHeadDto, "openVersion" | "activeVersion">; viewNumber: number }): DocumentPanelRow[] {
  const rows: DocumentPanelRow[] = [];
  const viewed = input.versions.find((entry) => entry.version === input.viewNumber);
  const open = input.head.openVersion === null ? undefined : input.versions.find((entry) => entry.version === input.head.openVersion);
  if (open && open.version !== input.viewNumber && open.confirmed) rows.push({ version: open.version, roleText: "Waiting for activation", document: open.document });
  if (viewed) rows.push({ version: viewed.version, roleText: viewed.version === input.head.activeVersion ? "Current version" : input.head.openVersion === viewed.version ? "Open version" : "Viewing", document: viewed.document });
  return rows;
}

// --- Versions tab: the Document column ---------------------------------------------------------------------------------------------------------------------
export type VersionDocumentCell = { chip: ChipSpec; fileName: string | null; link: string | null; note: string | null };

export function versionDocumentCell(document: AgreementDocumentDto): VersionDocumentCell {
  const chip = documentStatusChip(document.status);
  if (document.status === "STORED") {
    const link = safeDocumentLink(document.link);
    return { chip, fileName: document.fileName, link, note: link ? null : AGREEMENT_DOCUMENT_ON_FILE };
  }
  if (document.status === "NOT_APPLICABLE") return { chip, fileName: null, link: null, note: NO_NEW_SIGNED_DOCUMENT_TEXT };
  return { chip, fileName: document.fileName, link: null, note: null };
}

// --- Partner / Vendor contextual rows ---------------------------------------------------------------------------------------------------------------------
export type CounterpartyDocumentRow = {
  key: string;
  // The file name when the server sent one, else the neutral label.
  title: string;
  metaText: string;
  chip: ChipSpec | null;
  link: string | null;
  onFileText: string | null;
  note: string | null;
};

// One row per Agreement version that has (or should have) a document. The link is copied ONLY when the projection carries it.
export function buildCounterpartyDocumentRows(documents: readonly CounterpartyAgreementDocumentDto[]): CounterpartyDocumentRow[] {
  return documents.map((entry) => {
    const { document } = entry;
    const meta = [`Agreement version ${entry.version}`, lifecycleDisplayLabel(entry.lifecycle, entry.confirmed)];
    if (document.status === "STORED" && document.storedAt) meta.push(`Stored ${formatInstant(document.storedAt)}`);
    const link = document.status === "STORED" ? safeDocumentLink(document.link) : null;
    return {
      key: `${entry.agreementRef}:${entry.version}`,
      title: document.fileName ?? "Agreement document",
      metaText: meta.join(" · "),
      // The status text is the chip (Not stored yet | Storage failed | Drive storage not configured); a stored document and a version without a document of
      // its own carry a plain line instead.
      chip: document.status === "STORED" || document.status === "NOT_APPLICABLE" ? null : documentStatusChip(document.status),
      link,
      onFileText: document.status === "STORED" && !link ? AGREEMENT_DOCUMENT_ON_FILE : null,
      note: document.status === "NOT_APPLICABLE" ? NO_NEW_SIGNED_DOCUMENT_TEXT : null,
    };
  });
}
