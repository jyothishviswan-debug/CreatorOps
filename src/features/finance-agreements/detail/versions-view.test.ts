import { describe, expect, it } from "vitest";

import type { AgreementVersionSummaryDto } from "@/server/finance-agreements/client-dto";

import { buildVersionRows, currentVersionNumber, defaultViewedVersion, priorVersionNumber, versionRole } from "./versions-view";

const summary = (overrides: Partial<AgreementVersionSummaryDto> & { version: number }): AgreementVersionSummaryDto => ({
  status: "ACTIVE",
  docVersion: 3,
  sourceMode: "MANUAL",
  confirmed: true,
  confirmedAt: "2026-09-01T10:00:00.000Z",
  confirmedByUserRef: "usr_a",
  activatedAt: "2026-09-02T10:00:00.000Z",
  activatedByUserRef: "usr_b",
  supersededVersion: null,
  supersededByVersion: null,
  suspendedAt: null,
  suspendReason: null,
  endedAt: null,
  endReason: null,
  signedDate: "2026-08-30",
  effectiveFrom: "2026-09-01",
  effectiveTo: "2027-08-31",
  agreementType: "FIXED_ONLY",
  createdAt: "2026-08-31T10:00:00.000Z",
  createdByUserRef: "usr_a",
  updatedAt: "2026-09-02T10:00:00.000Z",
  updatedByUserRef: "usr_b",
  ...overrides,
});

const V1_SUPERSEDED = summary({ version: 1, status: "SUPERSEDED", supersededByVersion: 2 });
const V2_ACTIVE = summary({ version: 2, supersededVersion: 1, effectiveFrom: "2027-01-01", effectiveTo: null });
const V3_DRAFT = summary({ version: 3, status: "DRAFT", confirmed: false, confirmedAt: null, confirmedByUserRef: null, activatedAt: null, activatedByUserRef: null, effectiveFrom: null, effectiveTo: null, signedDate: null, agreementType: null });

const HEAD = { openVersion: 3, activeVersion: 2, lastEndedVersion: null, latestVersion: 3 };

describe("version rows", () => {
  const rows = buildVersionRows([V1_SUPERSEDED, V3_DRAFT, V2_ACTIVE], HEAD, 2);

  it("lists every version newest first without hiding a superseded one", () => {
    expect(rows.map((row) => row.version)).toEqual([3, 2, 1]);
  });

  it("marks the roles: open draft, governing (current), superseded", () => {
    expect(rows.map((row) => row.role)).toEqual(["open_draft", "governing", "superseded"]);
    expect(rows.map((row) => row.roleText)).toEqual(["Open draft · not confirmed", "Current · in force", "Superseded by version 2"]);
    expect(rows.find((row) => row.isGoverning)?.version).toBe(2);
    expect(rows.find((row) => row.isOpen)?.version).toBe(3);
  });

  it("marks the version being viewed", () => {
    expect(rows.filter((row) => row.isViewing).map((row) => row.version)).toEqual([2]);
    expect(buildVersionRows([V2_ACTIVE], HEAD, null).some((row) => row.isViewing)).toBe(false);
  });

  it("shows effective dates only for a confirmed version; a draft says they are set when confirmed", () => {
    expect(rows[0]!.effectivePeriod).toBe("Set when confirmed");
    expect(rows[1]!.effectivePeriod).toBe("From 1 Jan 2027");
    expect(rows[2]!.effectivePeriod).toBe("1 Sep 2026 – 31 Aug 2027");
  });

  it("carries the confirming / activating actor and a dash where a step has not happened", () => {
    expect(rows[1]!.confirmedBy).toBe("usr_a");
    expect(rows[1]!.activatedBy).toBe("usr_b");
    expect(rows[0]!.confirmedAt).toBe("—");
    expect(rows[0]!.activatedAt).toBe("—");
    expect(rows[1]!.sourceMode).toBe("Manual");
  });

  it("a confirmed but not yet active replacement reads as waiting for activation, with a Confirmed chip", () => {
    const confirmedDraft = summary({ version: 3, status: "DRAFT", confirmed: true, activatedAt: null, activatedByUserRef: null });
    const [row] = buildVersionRows([confirmedDraft], HEAD, null);
    expect(row!.role).toBe("awaiting_activation");
    expect(row!.roleText).toBe("Confirmed · waiting for activation");
    expect(row!.status.label).toBe("Confirmed · not active");
  });
});

describe("versionRole", () => {
  it("a suspended governing version is still 'governing' (current, suspended)", () => {
    const suspended = summary({ version: 1, status: "SUSPENDED" });
    const head = { openVersion: null, activeVersion: 1, lastEndedVersion: null };
    expect(versionRole(head, suspended)).toBe("governing");
    expect(buildVersionRows([suspended], head, 1)[0]!.roleText).toBe("Current · suspended");
  });

  it("the last ended version is 'ended' only while nothing governs", () => {
    const ended = summary({ version: 1, status: "ENDED" });
    expect(versionRole({ openVersion: null, activeVersion: null, lastEndedVersion: 1 }, ended)).toBe("ended");
    expect(versionRole({ openVersion: null, activeVersion: 2, lastEndedVersion: 1 }, ended)).toBe("historical");
  });
});

describe("priorVersionNumber", () => {
  it("compares an open revision with the governing version (or the last ended one)", () => {
    expect(priorVersionNumber(HEAD, V3_DRAFT)).toBe(2);
    expect(priorVersionNumber({ openVersion: 2, activeVersion: null, lastEndedVersion: 1 }, summary({ version: 2, status: "DRAFT", confirmed: false }))).toBe(1);
  });

  it("compares a superseding version with the version it superseded, and a first version with nothing", () => {
    expect(priorVersionNumber(HEAD, V2_ACTIVE)).toBe(1);
    expect(priorVersionNumber(HEAD, summary({ version: 1 }))).toBeNull();
    expect(priorVersionNumber({ openVersion: 1, activeVersion: null, lastEndedVersion: null }, summary({ version: 1, status: "DRAFT", confirmed: false }))).toBeNull();
  });
});

describe("defaultViewedVersion", () => {
  it("shows what governs, else the last ended, else the open draft, else the newest", () => {
    expect(defaultViewedVersion({ openVersion: 3, activeVersion: 2, lastEndedVersion: null, latestVersion: 3 })).toBe(2);
    expect(defaultViewedVersion({ openVersion: 2, activeVersion: null, lastEndedVersion: 1, latestVersion: 2 })).toBe(1);
    expect(defaultViewedVersion({ openVersion: 1, activeVersion: null, lastEndedVersion: null, latestVersion: 1 })).toBe(1);
    expect(defaultViewedVersion({ openVersion: null, activeVersion: null, lastEndedVersion: null, latestVersion: 4 })).toBe(4);
    expect(currentVersionNumber({ openVersion: null, activeVersion: 5, lastEndedVersion: null, latestVersion: 5 })).toBe(5);
  });
});
