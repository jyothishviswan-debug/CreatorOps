import type { AgreementVersionDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { INTAKE_SECTION_LABELS, type IntakeSectionId } from "../field-view-model";
import { changedFieldKeys, diffConfirmedTerms, diffDraftAgainstPrior, type FieldChange } from "../revision-diff";

// Step 14B: what a REVISION (or a version that replaced an earlier one) changes compared with the prior confirmed terms (pure).
//   - an editable DRAFT revision:   the fields already decided to a different value (a still-PENDING field is undecided, not changed);
//   - a CONFIRMED version:          every field whose frozen value differs from the prior version.
// The prior version itself never changes: it stays in force (and readable) until the replacement is activated.
export type RevisionChanges = {
  priorVersion: number;
  // "draft": compared with the working draft (may still change); "confirmed": the frozen replacement.
  basis: "draft" | "confirmed";
  changes: FieldChange[];
  changedKeys: Set<AgreementFieldKey>;
  // Draft entries still awaiting a decision (a draft only).
  pendingCount: number;
};

export function buildRevisionChanges(input: { viewed: Pick<AgreementVersionDto, "version" | "terms" | "contactSnapshot" | "draft"> | null; prior: Pick<AgreementVersionDto, "version" | "terms" | "contactSnapshot"> | null }): RevisionChanges | null {
  const { viewed, prior } = input;
  if (!viewed || !prior || prior.terms === null || prior.version === viewed.version) return null;
  const priorSet = { terms: prior.terms, contactSnapshot: prior.contactSnapshot };

  if (viewed.terms !== null) {
    const changes = diffConfirmedTerms(priorSet, { terms: viewed.terms, contactSnapshot: viewed.contactSnapshot });
    return { priorVersion: prior.version, basis: "confirmed", changes, changedKeys: changedFieldKeys(changes), pendingCount: 0 };
  }

  const draft = viewed.draft ?? {};
  const changes = diffDraftAgainstPrior(draft, priorSet);
  const pendingCount = Object.values(draft).filter((entry) => entry?.decision === "PENDING").length;
  return { priorVersion: prior.version, basis: "draft", changes, changedKeys: changedFieldKeys(changes), pendingCount };
}

export type ChangeGroup = { section: IntakeSectionId; label: string; changes: FieldChange[] };

// The changes grouped by the intake section they are edited in (registry order inside a group).
export function groupChangesBySection(changes: readonly FieldChange[]): ChangeGroup[] {
  const groups = new Map<IntakeSectionId, FieldChange[]>();
  for (const change of changes) groups.set(change.section, [...(groups.get(change.section) ?? []), change]);
  return [...groups.entries()].map(([section, items]) => ({ section, label: INTAKE_SECTION_LABELS[section], changes: items }));
}
