import { txGetAgreementVersion } from "./firestore";
import {
  utcDateSchema,
  type AgreementHeadDisplay,
  type AgreementHeadDoc,
  type AgreementVersionDoc,
  type ExtractionRunStatus,
} from "./types";

// Step 14B: the head `display` LIST PROJECTION - a pure builder plus the one in-transaction helper every
// head-writing mutation uses. The projection serves ONLY the bounded workspace list (name search, period
// and discrepancy filters, the row summary "as of last update"); it is never authorization and never
// lifecycle truth.
//
// Which version each field describes:
//   dates / agreementNumber / agreementType / sourceMode   the GOVERNING version (ACTIVE / SUSPENDED, else the
//                                                          ENDED one); with none, the OPEN version (a first
//                                                          draft, read from its confirmed terms or, while
//                                                          unconfirmed, from its draft entries)
//   unresolvedFieldCount                                   PENDING entries of the OPEN version's working draft
//                                                          (0 when there is no open version or it is confirmed)
//   extractionStatus                                       the most recent extraction recorded for the open
//                                                          version - carried over between writes, set by an
//                                                          extraction run / attach, reset by a new revision
//
// Concurrency (the finding this design rests on): writing `display` NEVER changes head.docVersion. A
// decide / attach / extract / confirm command rewrites the head with the SAME docVersion, so a client that
// last saw head docVersion N can still activate / revise / suspend / resume / end with N afterwards. The
// head rewrite is inside the same transaction that already read the head, so it is serialized against a
// racing lifecycle command by Firestore's own transaction contention (the loser retries and re-reads).

type HeadForDisplay = Pick<AgreementHeadDoc, "status" | "openVersion" | "activeVersion" | "lastEndedVersion">;

export type BuildHeadDisplayInput = {
  head: HeadForDisplay;
  counterpartyName: string;
  // The head's OPEN version document (null when there is none).
  open: AgreementVersionDoc | null;
  // The GOVERNING version document (see governingVersionNumber; null when there is none).
  governing: AgreementVersionDoc | null;
  extractionStatus: ExtractionRunStatus | null;
  projectedAt: string;
};

// The version whose dates / number / type describe the Agreement in a list: the ACTIVE/SUSPENDED version,
// else - once ended - the ended one. null while nothing was ever activated.
export function governingVersionNumber(head: HeadForDisplay): number | null {
  return head.activeVersion ?? (head.status === "ENDED" ? head.lastEndedVersion : null);
}

// PENDING entries = proposed / prefilled values no human has decided yet (the same set the confirm step
// reports as `field_pending`). A confirmed version has cleared its draft, so it has none.
export function countUnresolvedDraftFields(version: AgreementVersionDoc | null): number {
  if (!version || version.confirmation !== null) return 0;
  return Object.values(version.draft).filter((entry) => entry?.decision === "PENDING").length;
}

function draftText(version: AgreementVersionDoc, key: "agreementNumber"): string | null {
  const value = version.draft[key]?.value;
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100 ? value.trim() : null;
}

function draftDate(version: AgreementVersionDoc, key: "effectiveDate" | "terminationDate"): string | null {
  const value = version.draft[key]?.value;
  const parsed = utcDateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildHeadDisplay(input: BuildHeadDisplayInput): AgreementHeadDisplay {
  const described = input.governing ?? input.open;
  let agreementNumber: string | null = null;
  let effectiveFrom: string | null = null;
  let effectiveTo: string | null = null;
  let agreementType: AgreementHeadDisplay["agreementType"] = null;

  if (described) {
    if (described.terms && described.effective) {
      agreementNumber = described.terms.agreementNumber;
      agreementType = described.terms.agreementType;
      effectiveFrom = described.effective.effectiveFrom;
      effectiveTo = described.effective.effectiveTo;
    } else if (described.confirmation === null) {
      agreementNumber = draftText(described, "agreementNumber");
      effectiveFrom = draftDate(described, "effectiveDate");
      effectiveTo = draftDate(described, "terminationDate");
    }
  }

  const name = input.counterpartyName.trim().slice(0, 200) || "Unknown";
  return {
    counterpartyName: name,
    counterpartyNameLower: name.toLowerCase(),
    agreementNumber,
    agreementType,
    effectiveFrom,
    effectiveTo,
    sourceMode: described?.sourceMode ?? null,
    unresolvedFieldCount: Math.min(countUnresolvedDraftFields(input.open), 1000),
    openVersionConfirmed: input.open !== null && input.open.confirmation !== null,
    extractionStatus: input.extractionStatus,
    governingStatus: input.head.status,
    projectedAt: input.projectedAt,
  };
}

// --- In-transaction helpers -------------------------------------------------------------------------------------------------------
// MUST be called before the transaction's first write (Firestore requires every read first). `known` are the
// version docs the caller has already read (or is about to write) - passing the POST-mutation doc makes the
// projection describe the new state, and avoids re-reading it.
export async function txResolveDisplayVersions(
  tx: FirebaseFirestore.Transaction,
  head: HeadForDisplay & { agreementRef: string },
  known: ReadonlyArray<AgreementVersionDoc>,
): Promise<{ open: AgreementVersionDoc | null; governing: AgreementVersionDoc | null }> {
  const byNumber = new Map(known.map((version) => [version.version, version]));
  const resolve = async (number: number | null): Promise<AgreementVersionDoc | null> => {
    if (number === null) return null;
    const cached = byNumber.get(number);
    if (cached) return cached;
    const read = await txGetAgreementVersion(tx, head.agreementRef, number);
    if (read) byNumber.set(number, read);
    return read;
  };
  return { open: await resolve(head.openVersion), governing: await resolve(governingVersionNumber(head)) };
}

// Returns the head with a refreshed `display` - docVersion and every other field UNTOUCHED. `touchedBy`
// (draft-editing commands: decide / attach / extract / confirm) also records who last touched the
// Agreement and when (updatedAt / updatedByUserRef), so the workspace's newest-first order reflects real
// activity; it never affects docVersion or any lifecycle pointer. Lifecycle commands already set those
// fields themselves and omit it.
export function withHeadDisplay(
  head: AgreementHeadDoc,
  input: Omit<BuildHeadDisplayInput, "head" | "extractionStatus"> & { extractionStatus?: ExtractionRunStatus | null; touchedBy?: { actorUserRef: string } },
): AgreementHeadDoc {
  const { touchedBy, ...rest } = input;
  const extractionStatus = rest.extractionStatus !== undefined ? rest.extractionStatus : (head.display?.extractionStatus ?? null);
  const touched = touchedBy ? { updatedAt: rest.projectedAt, updatedByUserRef: touchedBy.actorUserRef } : {};
  return { ...head, ...touched, display: buildHeadDisplay({ ...rest, head, extractionStatus }) };
}
