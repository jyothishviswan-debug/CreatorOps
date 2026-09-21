import { normalizePlatformIdentifier } from "@/server/shared/platform";

import { governingVersionNumber } from "./agreement-head-display";
import { AGREEMENT_HEAD_STATUSES, COUNTERPARTY_TYPES, type AgreementHeadDisplay, type AgreementHeadDoc } from "./types";
import type { AgreementWorkspacePrimaryActionDto, AgreementWorkspaceQuery } from "./workspace-dto";

// Step 14B: the PURE pieces of the Agreement workspace - query parsing, filters, ordering, the opaque offset cursor and the
// primary-action hint. No Firestore, no actor: unit-testable in isolation. The service (agreement-workspace-service.ts) wires
// them to the scope-first bounded head scan.

export const WORKSPACE_DEFAULT_PAGE_SIZE = 20;
export const WORKSPACE_MAX_PAGE_SIZE = 20;
export const WORKSPACE_SEARCH_MAX_LENGTH = 80;
const MAX_CURSOR_OFFSET = 100_000;

// --- Query ------------------------------------------------------------------------------------------------------------------------
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export type ParsedWorkspaceQuery = { query: AgreementWorkspaceQuery; ignoredFilters: string[] };

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Lenient by design: this is URL state a person can hand-edit. An unknown or malformed FILTER value is dropped (and named in
// `ignoredFilters` so the page can show one neutral notice) instead of failing the page; a tampered cursor is dropped by the
// cursor decoder; the page size is clamped. It never widens access (filters only narrow an already scope-bounded set).
export function parseWorkspaceQuery(raw: unknown): ParsedWorkspaceQuery {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ignoredFilters: string[] = [];

  const enumOf = <T extends string>(name: string, allowed: readonly T[]): T | null => {
    const value = cleanString(source[name]);
    if (value === null) return null;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    ignoredFilters.push(name);
    return null;
  };

  const lifecycle = enumOf("lifecycle", AGREEMENT_HEAD_STATUSES);
  const counterpartyType = enumOf("counterpartyType", COUNTERPARTY_TYPES);
  const discrepancy = enumOf("discrepancy", ["open"] as const);

  let period: AgreementWorkspaceQuery["period"] = null;
  const periodRaw = cleanString(source.period);
  if (periodRaw !== null) {
    if (periodRaw === "current" || MONTH_PATTERN.test(periodRaw)) period = periodRaw;
    else ignoredFilters.push("period");
  }

  const qRaw = cleanString(source.q);
  const q = qRaw === null ? null : qRaw.slice(0, WORKSPACE_SEARCH_MAX_LENGTH);

  const platformRaw = cleanString(source.platform);
  const platform = platformRaw === null ? null : normalizePlatformIdentifier(platformRaw).slice(0, 60) || null;

  const cursorRaw = cleanString(source.cursor);
  const cursor = cursorRaw !== null && cursorRaw.length <= 300 ? cursorRaw : null;

  let limit = WORKSPACE_DEFAULT_PAGE_SIZE;
  const limitRaw = source.limit;
  const limitNumber = typeof limitRaw === "number" ? limitRaw : typeof limitRaw === "string" && /^\d{1,4}$/.test(limitRaw.trim()) ? Number(limitRaw.trim()) : null;
  if (limitNumber !== null && Number.isInteger(limitNumber)) limit = Math.max(1, Math.min(limitNumber, WORKSPACE_MAX_PAGE_SIZE));

  return { query: { lifecycle, counterpartyType, q, platform, period, discrepancy, cursor, limit }, ignoredFilters };
}

// --- Opaque offset cursor -----------------------------------------------------------------------------------------------------------
export function encodeWorkspaceCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

// A malformed / tampered cursor is dropped (the list simply starts over), never trusted.
export function decodeWorkspaceCursor(raw: string | null | undefined): number {
  if (!raw || raw.length > 300) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { o?: unknown };
    if (Number.isInteger(parsed.o) && (parsed.o as number) >= 0 && (parsed.o as number) <= MAX_CURSOR_OFFSET) return parsed.o as number;
  } catch {
    // fall through
  }
  return 0;
}

// --- Filters + order -----------------------------------------------------------------------------------------------------------------
export type WorkspaceCandidate = {
  head: AgreementHeadDoc;
  // LIVE counterparty display name (the authority); the stored display snapshot serves search too.
  liveName: string;
};

function monthBounds(month: string): { start: string; end: string } {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

// `current` = the GOVERNING (ACTIVE / SUSPENDED) version's effective range covers `today`; `YYYY-MM` = the projected effective
// range (governing version, else the open version's dates) overlaps that calendar month. Both compare ISO date strings.
export function matchesPeriodFilter(head: Pick<AgreementHeadDoc, "status" | "activeVersion" | "lastEndedVersion">, display: Pick<AgreementHeadDisplay, "effectiveFrom" | "effectiveTo"> | null, period: string, today: string): boolean {
  if (!display || !display.effectiveFrom) return false;
  if (period === "current") {
    if (governingVersionNumber({ ...head, openVersion: null }) === null || head.status === "ENDED") return false;
    return display.effectiveFrom <= today && (display.effectiveTo === null || display.effectiveTo >= today);
  }
  if (!MONTH_PATTERN.test(period)) return false;
  const { start, end } = monthBounds(period);
  return display.effectiveFrom <= end && (display.effectiveTo === null || display.effectiveTo >= start);
}

export function matchesWorkspaceFilters(candidate: WorkspaceCandidate, query: AgreementWorkspaceQuery, today: string): boolean {
  const { head } = candidate;
  if (query.lifecycle && head.status !== query.lifecycle) return false;
  if (query.counterpartyType && head.counterparty.type !== query.counterpartyType) return false;

  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystacks = [candidate.liveName.toLowerCase(), head.display?.counterpartyNameLower ?? ""];
    if (!haystacks.some((text) => text.includes(needle))) return false;
  }
  if (query.platform) {
    if (head.counterparty.type !== "PARTNER" || !head.counterparty.platformScope.some((platform) => normalizePlatformIdentifier(platform) === query.platform)) return false;
  }
  if (query.period && !matchesPeriodFilter(head, head.display, query.period, today)) return false;
  if (query.discrepancy === "open" && (head.display?.unresolvedFieldCount ?? 0) <= 0) return false;
  return true;
}

// Deterministic total order: last touched (head.updatedAt) newest first, then agreementRef ascending.
export function compareWorkspaceHeads(a: Pick<AgreementHeadDoc, "updatedAt" | "agreementRef">, b: Pick<AgreementHeadDoc, "updatedAt" | "agreementRef">): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.agreementRef < b.agreementRef ? -1 : a.agreementRef > b.agreementRef ? 1 : 0;
}

// --- Row helpers -----------------------------------------------------------------------------------------------------------------------
// The governing version, else the open draft, else the latest.
export function currentVersionOf(head: Pick<AgreementHeadDoc, "status" | "activeVersion" | "lastEndedVersion" | "openVersion" | "latestVersion">): number {
  return governingVersionNumber(head) ?? head.openVersion ?? head.latestVersion;
}

// Step 14C: a never-activated Agreement (head DRAFT) whose open version is already confirmed is "Confirmed · awaiting activation"
// (read from the head's display projection, exactly like the primary-action hint). An ACTIVE Agreement with a confirmed open
// revision is still Active - the revision, not the Agreement, awaits activation.
export function isAwaitingActivation(head: Pick<AgreementHeadDoc, "status" | "openVersion" | "display">): boolean {
  return head.status === "DRAFT" && head.openVersion !== null && head.display?.openVersionConfirmed === true;
}

// A HINT for the row's primary button (the destination re-checks everything server-side):
//   open version unconfirmed + may manage    -> CONTINUE_DRAFT (first draft or revision in progress)
//   open version confirmed + may activate    -> REVIEW (awaiting activation)
//   ACTIVE, nothing open, may activate       -> CREATE_REVISION
//   anything else                            -> OPEN (read-only entry to the current version)
export function primaryActionHint(
  head: Pick<AgreementHeadDoc, "status" | "activeVersion" | "lastEndedVersion" | "openVersion" | "latestVersion" | "display">,
  permissions: { canManage: boolean; canActivate: boolean },
): AgreementWorkspacePrimaryActionDto {
  if (head.openVersion !== null) {
    const confirmed = head.display?.openVersionConfirmed === true;
    if (!confirmed && permissions.canManage) return { kind: "CONTINUE_DRAFT", version: head.openVersion };
    if (confirmed && permissions.canActivate) return { kind: "REVIEW", version: head.openVersion };
  } else if (head.status === "ACTIVE" && permissions.canActivate) {
    return { kind: "CREATE_REVISION", version: null };
  }
  return { kind: "OPEN", version: currentVersionOf(head) };
}
