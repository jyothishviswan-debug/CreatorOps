// Step 14B: the pure URL-state / navigation model of the Agreement detail page (no React, no server code).
//   ?tab=      one of the six local tabs (unknown / repeated / missing -> Overview)
//   ?version=  a positive integer version number to view read-only (anything else is reported, never guessed)

export const DETAIL_TABS = ["overview", "terms", "verification", "kyc", "versions", "activity"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export const DETAIL_TAB_LABELS: Record<DetailTab, string> = {
  overview: "Overview",
  terms: "Terms",
  verification: "Verification",
  kyc: "KYC",
  versions: "Versions",
  activity: "Activity",
};

export const DEFAULT_DETAIL_TAB: DetailTab = "overview";
export const AGREEMENTS_WORKSPACE_HREF = "/finance/agreements";

type RawParam = string | string[] | null | undefined;

function firstValue(raw: RawParam): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw ?? undefined;
}

// An unusable (unknown, empty, array-of-junk) value falls back to the Overview.
export function parseDetailTab(raw: RawParam): DetailTab {
  const value = firstValue(raw)?.trim().toLowerCase();
  return (DETAIL_TABS as readonly string[]).includes(value ?? "") ? (value as DetailTab) : DEFAULT_DETAIL_TAB;
}

export type VersionParam = { state: "absent" } | { state: "valid"; version: number } | { state: "invalid" };

// A plain positive integer string only (no signs, decimals, exponents, whitespace tricks); 1..200 mirrors the server's version range.
export function parseVersionParam(raw: RawParam): VersionParam {
  const value = firstValue(raw);
  if (value === undefined || value === "") return { state: "absent" };
  if (!/^[1-9]\d{0,2}$/.test(value)) return { state: "invalid" };
  const version = Number(value);
  return version >= 1 && version <= 200 ? { state: "valid", version } : { state: "invalid" };
}

export function detailHref(agreementRef: string, options: { tab?: DetailTab; version?: number | null } = {}): string {
  const search = new URLSearchParams();
  if (options.tab && options.tab !== DEFAULT_DETAIL_TAB) search.set("tab", options.tab);
  if (options.version !== undefined && options.version !== null) search.set("version", String(options.version));
  const query = search.toString();
  return `${AGREEMENTS_WORKSPACE_HREF}/${encodeURIComponent(agreementRef)}${query ? `?${query}` : ""}`;
}

// The intake editor (create / edit a DRAFT or a revision) is /finance/agreements/new?agreementRef=&version= .
// `anchorId` (a field / section DOM id) jumps straight to the place a confirm blocker names.
export function intakeHref(agreementRef: string, version: number | null | undefined, anchorId?: string): string {
  const search = new URLSearchParams({ agreementRef });
  if (version !== null && version !== undefined) search.set("version", String(version));
  return `${AGREEMENTS_WORKSPACE_HREF}/new?${search.toString()}${anchorId ? `#${anchorId}` : ""}`;
}

export const tabElementId = (tab: DetailTab): string => `agreement-tab-${tab}`;
export const TAB_PANEL_ID = "agreement-tabpanel";

// Keyboard roving for the tab strip: Arrow keys wrap, Home / End jump. Returns null for any other key.
export function tabKeyTarget(current: DetailTab, key: string): DetailTab | null {
  const index = DETAIL_TABS.indexOf(current);
  const count = DETAIL_TABS.length;
  switch (key) {
    case "ArrowRight":
      return DETAIL_TABS[(index + 1) % count]!;
    case "ArrowLeft":
      return DETAIL_TABS[(index - 1 + count) % count]!;
    case "Home":
      return DETAIL_TABS[0]!;
    case "End":
      return DETAIL_TABS[count - 1]!;
    default:
      return null;
  }
}
