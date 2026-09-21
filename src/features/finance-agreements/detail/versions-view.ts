import type { AgreementHeadDto, AgreementVersionSummaryDto } from "@/server/finance-agreements/client-dto";

import { NO_VALUE_TEXT, formatEffectivePeriod, formatInstant, sourceModeLabel, versionStatusChip, type ChipSpec } from "../format";

// Step 14B: the immutable version list of an Agreement, mapped for display (pure). Version documents are never edited once
// confirmed: a superseded / ended version stays readable exactly as it was frozen.
export type VersionRole = "governing" | "open_draft" | "awaiting_activation" | "ended" | "superseded" | "historical";

export type VersionRow = {
  version: number;
  status: ChipSpec;
  role: VersionRole;
  // "Current · in force", "Open draft", "Superseded by version 3" ...
  roleText: string;
  effectivePeriod: string;
  // "14 Sep 2026, 10:24" or the dash; the actor is separate so it can be styled quietly.
  confirmedAt: string;
  confirmedBy: string | null;
  activatedAt: string;
  activatedBy: string | null;
  sourceMode: string;
  isViewing: boolean;
  isGoverning: boolean;
  isOpen: boolean;
};

export function versionRole(head: Pick<AgreementHeadDto, "openVersion" | "activeVersion" | "lastEndedVersion">, version: Pick<AgreementVersionSummaryDto, "version" | "status" | "confirmed">): VersionRole {
  if (head.activeVersion === version.version) return "governing";
  if (head.openVersion === version.version) return version.confirmed ? "awaiting_activation" : "open_draft";
  if (head.activeVersion === null && head.lastEndedVersion === version.version) return "ended";
  if (version.status === "SUPERSEDED") return "superseded";
  return "historical";
}

export function versionRoleText(role: VersionRole, version: Pick<AgreementVersionSummaryDto, "status" | "supersededByVersion">): string {
  switch (role) {
    case "governing":
      return version.status === "SUSPENDED" ? "Current · suspended" : "Current · in force";
    case "open_draft":
      return "Open draft · not confirmed";
    case "awaiting_activation":
      return "Confirmed · waiting for activation";
    case "ended":
      return "Ended";
    case "superseded":
      return version.supersededByVersion !== null ? `Superseded by version ${version.supersededByVersion}` : "Superseded";
    default:
      return "Earlier version";
  }
}

// Newest version first.
export function buildVersionRows(versions: readonly AgreementVersionSummaryDto[], head: Pick<AgreementHeadDto, "openVersion" | "activeVersion" | "lastEndedVersion">, viewingVersion: number | null): VersionRow[] {
  return [...versions]
    .sort((a, b) => b.version - a.version)
    .map((entry) => {
      const role = versionRole(head, entry);
      return {
        version: entry.version,
        status: versionStatusChip(entry),
        role,
        roleText: versionRoleText(role, entry),
        effectivePeriod: entry.confirmed ? formatEffectivePeriod(entry.effectiveFrom, entry.effectiveTo) : "Set when confirmed",
        confirmedAt: entry.confirmedAt ? formatInstant(entry.confirmedAt) : NO_VALUE_TEXT,
        confirmedBy: entry.confirmedByUserRef,
        activatedAt: entry.activatedAt ? formatInstant(entry.activatedAt) : NO_VALUE_TEXT,
        activatedBy: entry.activatedByUserRef,
        sourceMode: sourceModeLabel(entry.sourceMode),
        isViewing: viewingVersion === entry.version,
        isGoverning: role === "governing",
        isOpen: head.openVersion === entry.version,
      };
    });
}

// The version a given version is compared with for "changed fields":
//   - the OPEN version (a revision draft / a confirmed replacement) -> the version that governs today (else the last ended one);
//   - any other confirmed version -> the version it superseded at activation (null for a first version).
// Null when there is nothing earlier to compare with (a first Agreement version).
export function priorVersionNumber(head: Pick<AgreementHeadDto, "openVersion" | "activeVersion" | "lastEndedVersion">, version: Pick<AgreementVersionSummaryDto, "version" | "supersededVersion">): number | null {
  if (head.openVersion === version.version) return head.activeVersion ?? head.lastEndedVersion ?? null;
  return version.supersededVersion ?? null;
}

// The version to show by default: the one that governs (or governed last), else the open draft, else the newest.
export function defaultViewedVersion(head: Pick<AgreementHeadDto, "openVersion" | "activeVersion" | "lastEndedVersion" | "latestVersion">): number {
  return head.activeVersion ?? head.lastEndedVersion ?? head.openVersion ?? head.latestVersion;
}

// The version a head names as "current" for the header strip (same rule as the default view).
export const currentVersionNumber = defaultViewedVersion;
