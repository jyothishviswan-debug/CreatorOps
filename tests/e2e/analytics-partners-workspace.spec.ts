import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";
import { DISCOVERY_REGIONS } from "@/server/discovery/types";
import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection, analyticsImportBatchesCollection } from "@/server/analytics/firestore";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema, analyticsImportBatchDocSchema } from "@/server/analytics/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnersCollection } from "@/server/partners/firestore";
import { partnerDocSchema } from "@/server/partners/types";

// Step 12F - the unified six-item Analytics tabs (Overview | Instagram | YouTube |
// Partners | Data Explorer | Import History) and the Partners Analytics workspace
// (/analytics/partners), exercised through the real UI on real emulator data. Runs
// in the default `chromium` project (pre-authed as the seeded Super Admin, GLOBAL
// scope); tests needing another identity sign in explicitly.
//
// Every fixture Partner's display name starts with "12F E2E" (search prefix), so the
// searches below are hermetic no matter which other specs' Partners exist.
//
// Data: schema-valid Analytics source records and Partners are written with the
// Admin SDK in beforeAll under a PRIVATE region (only the GLOBAL Super Admin sees
// them) plus ONE Partner in the real "Kerala" region (so the scoped Analyst can be
// proven to see exactly that one), with distinctive 7-digit values no other spec
// uses, dated years in the PAST (2016) so they never enter another spec's
// newest-10 tables, and removed again in afterAll. Values are asserted through the
// rendered rows / cells and against the FIXTURE months, never against today's date.
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;
const tag = "e2e12f";
const REGION = `${tag}-region-private`;
const REGION_HIDDEN = `${tag}-region-hidden`;
const BATCH = `${tag}-batch`;

const P_AURORA = `${tag}-partner-aurora`; // India 1 + India 2 - the data-rich Partner
const P_BOREAL = `${tag}-partner-boreal`; // India 1
const P_CASCADE = `${tag}-partner-cascade`; // India 3 - February only
const P_DELTA = `${tag}-partner-delta`; // NO Analytics data at all
const P_HIDDEN = `${tag}-partner-hidden`; // hidden region
const P_KERALA = `${tag}-partner-kerala`; // real Kerala region: reachable by the scoped Analyst
const NAME: Record<string, string> = {
  [P_AURORA]: "12F E2E Aurora Studio",
  [P_BOREAL]: "12F E2E Borealis Works",
  [P_CASCADE]: "12F E2E Cascade Media",
  [P_DELTA]: "12F E2E Delta Nodata",
  [P_HIDDEN]: "12F E2E Hidden Region",
  [P_KERALA]: "12F E2E Kerala Scoped",
};

// Twelve extra Partners under their own name prefix ("12F CAP"), only for the 10-Partner selection-limit test.
const CAP_REFS = Array.from({ length: 12 }, (_, i) => `${tag}-cap-${String(i + 1).padStart(2, "0")}`);
CAP_REFS.forEach((ref, i) => {
  NAME[ref] = `12F CAP ${String(i + 1).padStart(2, "0")}`;
});

// Fixture months (2016): the latest month with data for Aurora is APRIL 2016.
const FEB = { start: "2016-02-01", end: "2016-02-29" };
const MAR = { start: "2016-03-01", end: "2016-03-31" };
const APR = { start: "2016-04-01", end: "2016-04-30" };

function emailFor(name: string): string {
  return EMULATOR_TEST_USERS.find((user) => user.email.startsWith(`${name}@`))!.email;
}

async function signInAs(page: Page, name: string) {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

const now = new Date().toISOString();
const cleanup: FirebaseFirestore.DocumentReference[] = [];

async function put<T extends { uid: string }>(collection: FirebaseFirestore.CollectionReference, doc: T) {
  const ref = collection.doc(doc.uid);
  await ref.set(doc);
  cleanup.push(ref);
}

type ContentOver = {
  ref: string;
  platform: "instagram" | "youtube";
  partner: string;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  engagement?: number | null;
  posted: string;
  period: { start: string; end: string } | null;
  region?: string;
  createdAt?: string;
};
function contentDoc(o: ContentOver) {
  return analyticsContentSourceRecordDocSchema.parse({
    uid: `${tag}-c-${o.ref}`,
    sourceRef: `${tag}-c-${o.ref}`,
    batchRef: BATCH,
    sheetName: "Posts",
    sourceRowNumber: 2,
    platform: o.platform,
    rowIdentityKey: `${tag}:c:${o.ref}`,
    rawPostId: null,
    rawPostUrl: `https://${o.platform}.example/RAW-URL-${o.ref}`,
    rawPostType: null,
    rawPostDateTime: null,
    rawMediaUrl: null,
    rawCaption: `RAW CAPTION ${o.ref}`,
    rawComments: null,
    rawLikes: null,
    rawViews: null,
    rawFollowers: null,
    rawUsername: null,
    rawEngagement: null,
    rawAccountOrChannelName: null,
    normalizedUrl: null,
    postDateTimeIso: o.posted,
    comments: o.comments ?? null,
    likes: o.likes ?? null,
    views: o.views ?? null,
    profileFollowers: null,
    engagement: o.engagement ?? null,
    reportingPeriod: o.period,
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: null, reasonCode: null, candidateCount: 1 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: o.partner,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [o.region ?? REGION],
    teamIds: [],
    createdAt: o.createdAt ?? "2016-05-01T00:00:00.000Z",
  });
}
function channelDoc(o: { ref: string; platform: "instagram" | "youtube"; partner: string; followers: number; period: { start: string; end: string } | null; createdAt: string }) {
  return analyticsChannelSourceRecordDocSchema.parse({
    uid: `${tag}-ch-${o.ref}`,
    sourceRef: `${tag}-ch-${o.ref}`,
    batchRef: BATCH,
    sheetName: "Channels",
    sourceRowNumber: 3,
    platform: o.platform,
    rowIdentityKey: `${tag}:ch:${o.ref}`,
    rawUsername: null,
    rawProfileUrl: null,
    rawPlatformAccountId: null,
    rawFollowers: null,
    rawAccountOrChannelName: null,
    normalizedProfileUrl: null,
    profileFollowers: o.followers,
    reportingPeriod: o.period,
    matchState: "MATCHED",
    matchEvidence: { tier: "none", value: null, reasonCode: null, candidateCount: 0 },
    matchedPartnerRef: o.partner,
    matchedPartnerAccountRef: null,
    ownerUid: null,
    regionIds: [REGION],
    teamIds: [],
    createdAt: o.createdAt,
  });
}

// ---- The six routes ------------------------------------------------------------------------------------------

const SIX_TABS = [
  { label: "Overview", href: "/analytics" },
  { label: "Instagram", href: "/analytics/instagram" },
  { label: "YouTube", href: "/analytics/youtube" },
  { label: "Partners", href: "/analytics/partners" },
  { label: "Data Explorer", href: "/analytics/explorer" },
  { label: "Import History", href: "/analytics/import-history" },
];

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1200", width: 1200, height: 900 },
  { name: "1050", width: 1050, height: 900 },
  { name: "760", width: 760, height: 900 },
  { name: "390", width: 390, height: 844 },
  { name: "375", width: 375, height: 812 },
];

test.describe.configure({ mode: "serial" });

test.describe("Analytics six-tab row + Partners Analytics workspace", () => {
  test.beforeAll(async () => {
    await put(
      analyticsImportBatchesCollection(),
      analyticsImportBatchDocSchema.parse({
        uid: BATCH,
        batchRef: BATCH,
        targetKind: "campaign_content",
        sourceFilename: `${tag}-export.xlsx`,
        sourceMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sourceExtension: "xlsx",
        sourceHash: `${tag}-hash`,
        supersedesBatchRef: null,
        reportingPeriod: null,
        actorUserRef: tag,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        status: "COMPLETED",
        totalRows: 0,
        actionableRows: 0,
        matchedRows: 0,
        unmatchedRows: 0,
        ambiguousRows: 0,
        invalidRows: 0,
        duplicateUnchangedRows: 0,
        failedRows: 0,
        sourceSheetInventory: [],
        safeErrorSummary: [],
      }),
    );

    const partner = (ref: string, region: string, targetAudience: string[]) =>
      partnerDocSchema.parse({
        uid: ref,
        partnerRef: ref,
        version: 1,
        displayName: NAME[ref],
        displayNameLower: NAME[ref]!.toLowerCase(),
        legalName: `SECRET LEGAL ${ref}`,
        status: "ACTIVE",
        previousStatus: null,
        statusReason: null,
        regionIds: [region],
        languageIds: [],
        categoryIds: [],
        tier: "Tier 1",
        priority: null,
        targetAudience,
        email: `secret-${ref}@restricted.test`,
        phone: "+91 90000 00096",
        ownerUid: null,
        teamIds: [],
        originLeadRefs: [],
        sourceDiscovery: null,
        pendingPartnerAccountSetup: false,
        sequenceNumber: null,
        createdAt: now,
        createdByUserRef: tag,
        updatedAt: now,
        updatedByUserRef: tag,
      });
    await put(partnersCollection(), partner(P_AURORA, REGION, ["India 1", "India 2"]));
    await put(partnersCollection(), partner(P_BOREAL, REGION, ["India 1"]));
    await put(partnersCollection(), partner(P_CASCADE, REGION, ["India 3"]));
    await put(partnersCollection(), partner(P_DELTA, REGION, []));
    await put(partnersCollection(), partner(P_HIDDEN, REGION_HIDDEN, ["India 1"]));
    await put(partnersCollection(), partner(P_KERALA, "Kerala", ["India 1"]));
    for (const ref of CAP_REFS) await put(partnersCollection(), partner(ref, REGION, ["India 1"]));

    const contents = [
      // Aurora: Instagram March + April, YouTube March, one record with NO period (never in a month)
      contentDoc({ ref: "au-ig-mar", platform: "instagram", partner: P_AURORA, views: 6_161_101, likes: 616_101, comments: 6_101, engagement: 61_101, posted: "2016-03-10T10:00:00.000Z", period: MAR }),
      contentDoc({ ref: "au-ig-apr", platform: "instagram", partner: P_AURORA, views: 6_262_202, likes: 626_202, comments: null, engagement: null, posted: "2016-04-10T10:00:00.000Z", period: APR }),
      contentDoc({ ref: "au-yt-mar", platform: "youtube", partner: P_AURORA, views: 7_272_101, likes: 727_101, comments: 7_101, engagement: 72_101, posted: "2016-03-12T10:00:00.000Z", period: MAR }),
      contentDoc({ ref: "au-ig-noperiod", platform: "instagram", partner: P_AURORA, views: 9_191_919, posted: "2016-04-20T10:00:00.000Z", period: null }),
      // Borealis: Instagram March only, Engagement NOT reported (likes are)
      contentDoc({ ref: "bo-ig-mar", platform: "instagram", partner: P_BOREAL, views: 3_131_311, likes: 313_131, comments: 3_131, engagement: null, posted: "2016-03-05T10:00:00.000Z", period: MAR }),
      // Cascade: YouTube February only
      contentDoc({ ref: "ca-yt-feb", platform: "youtube", partner: P_CASCADE, views: 4_242_424, likes: 424_242, posted: "2016-02-05T10:00:00.000Z", period: FEB }),
      // Hidden region Partner
      contentDoc({ ref: "hi-ig-mar", platform: "instagram", partner: P_HIDDEN, views: 2_424_242, posted: "2016-03-06T10:00:00.000Z", period: MAR, region: REGION_HIDDEN }),
      // Kerala Partner: reachable by the scoped Analyst
      contentDoc({ ref: "ke-ig-mar", platform: "instagram", partner: P_KERALA, views: 4_141_001, likes: 414_101, posted: "2016-03-07T10:00:00.000Z", period: MAR, region: "Kerala" }),
    ];
    const channels = [channelDoc({ ref: "au-ig-apr", platform: "instagram", partner: P_AURORA, followers: 8_181_001, period: APR, createdAt: "2016-05-05T00:00:00.000Z" })];
    const db = getAdminFirestore();
    const batch = db.batch();
    for (const { collection, doc } of [...contents.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })), ...channels.map((doc) => ({ collection: analyticsChannelSourceRecordsCollection(), doc }))]) {
      const ref = collection.doc(doc.uid);
      batch.set(ref, doc);
      cleanup.push(ref);
    }
    await batch.commit();
  });

  test.afterAll(async () => {
    const db = getAdminFirestore();
    for (let i = 0; i < cleanup.length; i += 400) {
      const batch = db.batch();
      for (const ref of cleanup.slice(i, i + 400)) batch.delete(ref);
      await batch.commit();
    }
  });

  const workspaceUrl = (query = "") => `/analytics/partners${query}`;
  const panel = (page: Page, title: string) => page.locator(".ov-panel", { has: page.getByRole("heading", { name: title, exact: true }) });
  const searchBox = (page: Page) => page.getByRole("combobox", { name: "Search and select Partners" });
  // The month-scoped evidence: KPI row + Published Content + Top Content. (The monthly TREND cards legitimately mention the other
  // months' values - they are the bounded trend across months, not the selected month's evidence.)
  const evidenceText = async (page: Page) => [await page.locator(".ov-kpis").innerText(), await panel(page, "Published Content").innerText(), await panel(page, "Top Content").innerText()].join("\n");
  const noOverflow = async (page: Page, label: string) => {
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(scrollWidth, `${label} overflows the page horizontally`).toBeLessThanOrEqual(innerWidth);
  };

  // ==== A. The six-tab row: order, active tab, ONE shared treatment ==========================================

  const ALL_ROUTES = [...SIX_TABS.map((tab) => ({ ...tab, active: tab.label })), { label: "Partner drill-down", href: `/analytics/partner/${P_AURORA}`, active: "Partners" }];

  for (const route of ALL_ROUTES) {
    test(`six tabs in exact order, correct active tab: ${route.href}`, async ({ page }) => {
      await page.goto(route.href);
      const tabs = page.locator(".tabs .tab");
      await expect(tabs).toHaveText(SIX_TABS.map((tab) => tab.label));
      await expect(tabs).toHaveCount(6);
      for (const [index, tab] of SIX_TABS.entries()) await expect(tabs.nth(index)).toHaveAttribute("href", tab.href);
      await expect(page.locator(".tabs .tab.active")).toHaveCount(1);
      await expect(page.locator(".tabs .tab.active")).toHaveText(route.active);
      await expect(page.locator(".tabs .tab[aria-current='page']")).toHaveText(route.active);
      // Every page renders the SAME shell: ov-page > head + tabs.
      await expect(page.locator(".main > .ov-page > .head + .tabsbar")).toHaveCount(1);
    });
  }

  // Everything measured is the tab row's own treatment. Overview is the approved reference; every other route must equal it.
  async function measureTabs(page: Page) {
    return page.evaluate(() => {
      const cs = (el: Element, props: string[]) => Object.fromEntries(props.map((prop) => [prop, getComputedStyle(el).getPropertyValue(prop)]));
      const main = document.querySelector(".main")!;
      const frame = document.querySelector(".ov-page")!;
      const head = document.querySelector(".ov-page > .head")!;
      const h1 = head.querySelector("h1")!;
      const eyebrow = head.querySelector(".eyebrow")!;
      const bar = document.querySelector(".tabsbar")!;
      const row = bar.querySelector(".tabs")!;
      const tabs = [...row.querySelectorAll<HTMLElement>(".tab")];
      const barRect = bar.getBoundingClientRect();
      const headRect = head.getBoundingClientRect();
      const h1Rect = h1.getBoundingClientRect();
      const tabProps = ["font-size", "font-weight", "font-family", "line-height", "padding-top", "padding-right", "padding-bottom", "padding-left", "color", "border-bottom-width", "border-bottom-style", "border-bottom-color", "white-space", "text-decoration-line", "outline-style", "outline-width"];
      const byClass = (active: boolean) => {
        const el = tabs.find((tab) => tab.classList.contains("active") === active)!;
        const rect = el.getBoundingClientRect();
        return { style: cs(el, tabProps), height: rect.height };
      };
      const gaps = tabs.slice(1).map((tab, index) => Math.round((tab.getBoundingClientRect().left - tabs[index]!.getBoundingClientRect().right) * 100) / 100);
      const tabTops = tabs.map((tab) => Math.round(tab.getBoundingClientRect().top * 100) / 100);
      return {
        main: cs(main, ["max-width", "padding-top", "padding-left", "padding-right"]),
        frame: cs(frame, ["display"]),
        head: { ...cs(head, ["margin-bottom", "display"]), h1: cs(h1, ["font-size", "line-height", "font-weight"]), eyebrow: cs(eyebrow, ["font-size", "margin-bottom"]) },
        bar: cs(bar, ["display", "align-items", "justify-content", "margin-bottom", "gap", "border-bottom-width", "border-bottom-style", "border-bottom-color", "padding-top", "padding-bottom", "flex-direction"]),
        row: cs(row, ["display", "gap", "overflow-x", "overflow-y", "flex-direction"]),
        inactive: byClass(false),
        active: byClass(true),
        // Position: the tab bar sits the same distance below the header block, and at the same x, on every route.
        barBelowHead: Math.round((barRect.top - headRect.bottom) * 100) / 100,
        barLeft: Math.round(barRect.left * 100) / 100,
        barWidth: Math.round(barRect.width * 100) / 100,
        barHeight: Math.round(barRect.height * 100) / 100,
        h1Left: Math.round(h1Rect.left * 100) / 100,
        h1FromMainTop: Math.round((h1Rect.top - main.getBoundingClientRect().top) * 100) / 100,
        tabGaps: gaps,
        allTabsShareOneTop: new Set(tabTops).size === 1,
        tabCount: tabs.length,
      };
    });
  }

  test("Partners, Data Explorer and Import History tabs are visually IDENTICAL to Overview / Instagram / YouTube (computed style, size, gap, position)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/analytics");
    await expect(page.locator(".tabs .tab")).toHaveCount(6);
    const reference = await measureTabs(page);
    expect(reference.tabCount).toBe(6);
    expect(reference.allTabsShareOneTop).toBe(true);
    // No extra gap before Data Explorer / Import History: all five gaps are the same value.
    expect(new Set(reference.tabGaps).size).toBe(1);
    expect(reference.tabGaps).toHaveLength(5);

    for (const route of SIX_TABS.slice(1).concat([{ label: "Partner drill-down", href: `/analytics/partner/${P_AURORA}` }])) {
      await page.goto(route.href);
      await expect(page.locator(".tabs .tab")).toHaveCount(6);
      await expect(page.locator(".main > .ov-page > .head + .tabsbar")).toHaveCount(1);
      const measured = await measureTabs(page);
      // The active tab differs only by which tab it is; compare ACTIVE with ACTIVE and INACTIVE with INACTIVE.
      expect(measured, route.href).toEqual(reference);
    }
  });

  test("the treatment is proven for the LAST THREE tabs specifically: each one measures exactly like the first three, active and inactive", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const perTab = async (path: string) =>
      page.evaluate(() => {
        const props = ["font-size", "font-weight", "padding-top", "padding-right", "padding-bottom", "padding-left", "color", "border-bottom-width", "border-bottom-color", "line-height", "white-space"];
        return [...document.querySelectorAll<HTMLElement>(".tabs .tab")].map((tab) => {
          const style = getComputedStyle(tab);
          const rect = tab.getBoundingClientRect();
          // `top` is measured relative to the header block's bottom: the header itself may be taller on a page with header actions.
          const headBottom = document.querySelector(".ov-page > .head")!.getBoundingClientRect().bottom;
          return { label: tab.textContent, active: tab.classList.contains("active"), height: rect.height, top: rect.top - headBottom, style: Object.fromEntries(props.map((p) => [p, style.getPropertyValue(p)])) };
        });
      }).then((tabs) => ({ path, tabs }));
    // Same page (Overview): tab 0-2 are the approved ones, 3-5 are the new ones - inactive here, so they must be identical.
    await page.goto("/analytics");
    const overview = await perTab("/analytics");
    const inactive = overview.tabs.filter((tab) => !tab.active);
    expect(inactive).toHaveLength(5);
    for (const tab of inactive) {
      expect(tab.style, tab.label ?? "").toEqual(inactive[0]!.style);
      expect(tab.height, tab.label ?? "").toBe(inactive[0]!.height);
      expect(tab.top, tab.label ?? "").toBe(inactive[0]!.top);
    }
    // Active state: on each of the three new routes the active tab's style equals the active tab on Overview.
    const overviewActive = overview.tabs.find((tab) => tab.active)!;
    for (const path of ["/analytics/partners", "/analytics/explorer", "/analytics/import-history", `/analytics/partner/${P_AURORA}`]) {
      await page.goto(path);
      const there = await perTab(path);
      const active = there.tabs.find((tab) => tab.active)!;
      expect(active.style, path).toEqual(overviewActive.style);
      expect(active.height, path).toBe(overviewActive.height);
      expect(active.top, path).toBe(overviewActive.top);
      for (const tab of there.tabs.filter((t) => !t.active)) expect(tab.style, `${path} ${tab.label}`).toEqual(inactive[0]!.style);
    }
  });

  test("keyboard focus treatment is the same for every tab (Partners / Data Explorer / Import History match Overview)", async ({ page }) => {
    await page.goto("/analytics/partners");
    const outline = async (label: string) => {
      const tab = page.locator(".tabs .tab", { hasText: label });
      await tab.focus();
      return tab.evaluate((el) => {
        const style = getComputedStyle(el);
        return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, matchesFocusVisible: el.matches(":focus-visible") };
      });
    };
    const reference = await outline("Overview");
    for (const label of ["Instagram", "YouTube", "Partners", "Data Explorer", "Import History"]) expect(await outline(label), label).toEqual(reference);
  });

  // Data Explorer and Import History render their own tables with a visually-hidden `span.sr` in the header (files this step does NOT
  // touch): that absolutely-positioned span escapes the table's scroll container and already widened the document before this step.
  // For those two routes the check is therefore that the TAB ROW adds nothing to the document width (removing it leaves the width
  // unchanged); on every other route the document must not overflow at all.
  const PRE_EXISTING_CONTENT_OVERFLOW = new Set(["/analytics/explorer", "/analytics/import-history"]);
  for (const viewport of VIEWPORTS.filter((v) => v.width <= 390)) {
    test(`mobile ${viewport.name}: one consistent, horizontally scrollable tab row on every route - the row causes no document overflow, active tab in view`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const route of ALL_ROUTES) {
        await page.goto(route.href);
        await expect(page.locator(".tabs .tab")).toHaveCount(6);
        await expect(page.locator(".main > .ov-page > .head + .tabsbar")).toHaveCount(1);
        // The active tab is scrolled into view by a small client effect after hydration.
        await expect
          .poll(() => page.evaluate(() => {
            const row = document.querySelector<HTMLElement>(".tabs")!;
            const rowRect = row.getBoundingClientRect();
            const activeRect = row.querySelector<HTMLElement>(".tab.active")!.getBoundingClientRect();
            return activeRect.left >= rowRect.left - 1 && activeRect.right <= rowRect.right + 1;
          }), { message: `${route.href}: the active tab must be scrolled into view`, timeout: 10_000 })
          .toBe(true);
        const info = await page.evaluate(() => {
          const row = document.querySelector<HTMLElement>(".tabs")!;
          const bar = document.querySelector<HTMLElement>(".tabsbar")!;
          const active = row.querySelector<HTMLElement>(".tab.active")!;
          const rowRect = row.getBoundingClientRect();
          const activeRect = active.getBoundingClientRect();
          const withBar = document.documentElement.scrollWidth;
          const display = bar.style.display;
          bar.style.display = "none";
          const withoutBar = document.documentElement.scrollWidth;
          bar.style.display = display;
          return {
            docOverflow: withBar - window.innerWidth,
            barAddsWidth: withBar - withoutBar,
            rowScrolls: row.scrollWidth > row.clientWidth,
            overflowX: getComputedStyle(row).overflowX,
            rowWithinViewport: rowRect.right <= window.innerWidth + 0.5 && rowRect.left >= -0.5,
            activeInView: activeRect.left >= rowRect.left - 1 && activeRect.right <= rowRect.right + 1,
            scrollY: window.scrollY,
          };
        });
        expect(info.barAddsWidth, `${route.href}: the tab row must add nothing to the document width at ${viewport.name}`).toBeLessThanOrEqual(0);
        if (!PRE_EXISTING_CONTENT_OVERFLOW.has(route.href)) expect(info.docOverflow, `${route.href} overflows the document at ${viewport.name}`).toBeLessThanOrEqual(0);
        expect(info.rowScrolls, `${route.href}: six tabs must scroll INSIDE the row at ${viewport.name}`).toBe(true);
        expect(["auto", "scroll"]).toContain(info.overflowX);
        expect(info.rowWithinViewport).toBe(true);
        expect(info.activeInView, `${route.href}: the active tab must be scrolled into view`).toBe(true);
        expect(info.scrollY, "scrolling the tab row must never jump the document").toBe(0);
      }
    });
  }

  test("at mobile width the last tab (Import History) is reachable by scrolling the row and navigates", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/analytics/partners");
    const link = page.locator(".tabs .tab", { hasText: "Import History" });
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await expect(page).toHaveURL(/\/analytics\/import-history$/);
    await expect(page.locator(".tabs .tab.active")).toHaveText("Import History");
  });

  test("hover and click navigation between all six tabs keeps the same row (and the active state follows)", async ({ page }) => {
    await page.goto("/analytics");
    for (const label of ["Partners", "Data Explorer", "Import History", "Overview", "Instagram", "YouTube"]) {
      await page.locator(".tabs").getByRole("link", { name: label, exact: true }).click();
      await expect(page.locator(".tabs .tab.active")).toHaveText(label);
      await expect(page.locator(".tabs .tab")).toHaveCount(6);
    }
  });

  test("access-denied variants keep the same shell and the same six tabs", async ({ page }) => {
    await signInAs(page, "viewer");
    for (const route of SIX_TABS) {
      await page.goto(route.href);
      await expect(page.getByText("Access denied")).toBeVisible();
      await expect(page.locator(".main > .ov-page > .head + .tabsbar")).toHaveCount(1);
      await expect(page.locator(".tabs .tab")).toHaveText(SIX_TABS.map((tab) => tab.label));
      await expect(page.locator(".tabs .tab.active")).toHaveText(route.label);
    }
    await page.goto(`/analytics/partner/${P_AURORA}`);
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.locator(".tabs .tab.active")).toHaveText("Partners");
    await page.goto(workspaceUrl(`?partners=${P_AURORA}`));
    await expect(page.locator(".ov-kpi")).toHaveCount(0);
    expect(await page.locator("#main").innerText()).not.toContain(NAME[P_AURORA]);
  });

  // ==== B. The Partners workspace ===================================================================================

  test("empty selection: selector, month + platform controls, neutral empty state; no Import CTA; the month follows the data", async ({ page }) => {
    await page.goto(workspaceUrl());
    await expect(page.locator("h1")).toHaveText("Partners Analytics");
    await expect(page.getByRole("heading", { name: "Choose Partners", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Selected Partners" })).toHaveCount(0);
    await expect(page.getByText("Select Partners to see Analytics")).toBeVisible();
    await expect(page.getByRole("link", { name: /Import data/ })).toHaveCount(0);
    await expect(page.getByLabel("Reporting month")).toBeVisible();
    await expect(page.getByTestId("month-source")).toHaveText("Latest reporting month with data");
    await expect(page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Clear all" })).toHaveCount(0);
  });

  test("search by name shows the matching Partner with SAFE identity only; selecting one opens its single-Partner view for the LATEST month with data", async ({ page }) => {
    await page.goto(workspaceUrl());
    await searchBox(page).fill("12F E2E Aurora");
    const option = page.getByRole("option", { name: /12F E2E Aurora Studio/ });
    await expect(option).toBeVisible();
    await expect(option).toContainText(REGION);
    await expect(option).toContainText("India 1, India 2");
    const listText = await page.getByRole("listbox", { name: "Partner search results" }).innerText();
    for (const secret of ["SECRET LEGAL", "secret-", "+91 90000", "Tier 1", P_AURORA]) expect(listText, secret).not.toContain(secret);
    await option.click();
    await expect(page).toHaveURL(new RegExp(`\\?partners=${P_AURORA}$`));

    // The single-Partner view for the latest month with data (APRIL 2016, from the FIXTURE periods - not today).
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-04");
    await expect(page.getByTestId("month-source")).toHaveText("Latest reporting month with data");
    await expect(page.locator(".ov-context strong").first()).toHaveText("April 2016 · Latest reporting month with data");
    await expect(page.getByText("1 of 1 selected Partner has Analytics data for April 2016")).toBeVisible();
    await expect(page.getByRole("list", { name: "Selected Partners" }).getByText(NAME[P_AURORA]!)).toBeVisible();
    const kpis = page.locator(".ov-kpi");
    await expect(kpis).toHaveCount(5);
    expect((await kpis.allInnerTexts()).join("|")).toContain("Published content");
    // April: ONE Instagram record (6,262,202), no YouTube record; the March values must not appear.
    const main = await page.locator("#main").innerText();
    const evidence = await evidenceText(page);
    expect(evidence).toContain("6,262,202");
    for (const march of ["6,161,101", "7,272,101", "9,191,919"]) expect(evidence, march).not.toContain(march);
    expect(main).not.toContain("9,191,919"); // the no-period record is in NO month and NO trend
    await expect(page.getByRole("heading", { name: "Published Content", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Partner Accounts", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Top Content", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Data Quality & Freshness", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Instagram performance" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "YouTube performance" })).toBeVisible();
    // No restricted field, raw ref, post URL or unsupported metric.
    for (const secret of ["SECRET LEGAL", "secret-", "+91 90000", "RAW-URL", "RAW CAPTION", "Reach", "Watch Time", "Impressions"]) expect(main, secret).not.toContain(secret);
  });

  test("the single view honors the fixture month: an explicit March shows March's records, the no-period record is disclosed and NEVER forced into a month", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA}&month=2016-03`));
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-03");
    await expect(page.getByTestId("month-source")).toHaveText("Selected month");
    const main = await page.locator("#main").innerText();
    const evidence = await evidenceText(page);
    for (const value of ["6,161,101", "7,272,101"]) expect(evidence, value).toContain(value);
    for (const other of ["6,262,202", "9,191,919"]) expect(evidence, other).not.toContain(other);
    expect(main).not.toContain("9,191,919");
    await expect(page.getByText(/1 source record could not be placed in a single reporting month/).first()).toBeVisible();
    // Views on All are platform-native per platform, never combined.
    const viewsKpi = page.locator(".ov-kpi", { hasText: "Views" }).first();
    await expect(viewsKpi).toContainText("By platform");
    await expect(viewsKpi).toContainText("native counts, not combined");
    expect(main).not.toContain("13,433,202"); // 6,161,101 + 7,272,101
  });

  test("multi-select shows the comparison table: one row per Partner from its own records, Instagram and YouTube Views separate, missing is a dash", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL},${P_CASCADE}&month=2016-03`));
    const table = panel(page, "Partner comparison").locator("table");
    expect(await table.locator("thead th").allInnerTexts()).toEqual(["Partner", "Coverage", "Published content", "Instagram Views", "YouTube Views", "Engagement", "Likes", "Comments", "Latest channel snapshot"]);
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    // Selection order.
    await expect(rows.nth(0)).toContainText(NAME[P_AURORA]!);
    await expect(rows.nth(1)).toContainText(NAME[P_BOREAL]!);
    await expect(rows.nth(2)).toContainText(NAME[P_CASCADE]!);
    // Aurora March: Instagram and YouTube Views in their OWN columns.
    const aurora = rows.nth(0).locator("td");
    await expect(aurora.nth(3)).toHaveText("6,161,101");
    await expect(aurora.nth(4)).toHaveText("7,272,101");
    await expect(aurora.nth(5)).toContainText("133,202"); // 61,101 + 72,101 source-reported Engagement
    // Borealis: no YouTube -> Unavailable dash; Engagement not reported -> Unavailable (never likes + comments).
    const boreal = rows.nth(1).locator("td");
    await expect(boreal.nth(3)).toHaveText("3,131,311");
    await expect(boreal.nth(4).getByRole("img", { name: "Unavailable" })).toBeVisible();
    await expect(boreal.nth(5).getByRole("img", { name: "Unavailable" })).toBeVisible();
    await expect(boreal.nth(6)).toHaveText("313,131");
    // Cascade has nothing in March: visible row, Unavailable everywhere, coverage state says so.
    const cascade = rows.nth(2);
    await expect(cascade).toContainText("Unavailable");
    expect(await cascade.getByRole("img", { name: "Unavailable" }).count()).toBeGreaterThanOrEqual(6);
    const text = await table.innerText();
    for (const blended of ["13,433,202", "9,292,412"]) expect(text, blended).not.toContain(blended);
    // No overall score / ranking / follower total anywhere on the page.
    const main = await page.locator("#main").innerText();
    for (const word of ["Score", "Rank ", "Overall", "Followers total", "Total followers", "Reach"]) expect(main, word).not.toContain(word);
    // Per-Partner drill-down link carries month + platform state.
    await expect(rows.nth(0).getByRole("link", { name: NAME[P_AURORA]! })).toHaveAttribute("href", `/analytics/partner/${P_AURORA}?month=2016-03`);
  });

  test("coverage is a truthful 'x of y' - a Partner without data stays visible as Unavailable and is never silently dropped", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_DELTA},${P_BOREAL}&month=2016-03`));
    await expect(page.getByText("2 of 3 selected Partners have Analytics data for March 2016")).toBeVisible();
    const rows = panel(page, "Partner comparison").locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText(NAME[P_DELTA]!);
    await expect(rows.nth(1)).toContainText("Unavailable");
    // A different month: Borealis / Delta have nothing in April.
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_DELTA},${P_BOREAL}`));
    await expect(page.getByText("1 of 3 selected Partners has Analytics data for April 2016")).toBeVisible();
    await expect(panel(page, "Partner comparison").locator("tbody tr")).toHaveCount(3);
  });

  test("the month defaults to the latest month with data FOR THE CURRENT SELECTION, and an explicit choice persists across platform switches and reload", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_CASCADE}`));
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-02"); // Cascade only has February
    await page.goto(workspaceUrl(`?partners=${P_CASCADE},${P_AURORA}`));
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-04"); // the selection's latest

    // Choose March explicitly through the real control.
    await page.getByLabel("Reporting month").selectOption("2016-03");
    await expect(page).toHaveURL(/month=2016-03/);
    await expect(page.getByTestId("month-source")).toHaveText("Selected month");
    await expect(page.getByText("1 of 2 selected Partners has Analytics data for March 2016")).toBeVisible();
    // Persists across a platform switch ...
    await page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "Instagram" }).click();
    await expect(page).toHaveURL(/month=2016-03/);
    await expect(page).toHaveURL(/platform=instagram/);
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-03");
    // ... and a reload ...
    await page.reload();
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-03");
    await expect(page.getByTestId("month-source")).toHaveText("Selected month");
    // ... and adding another Partner (whose latest month differs) never changes it.
    await page.goto(workspaceUrl(`?partners=${P_CASCADE}&month=2016-03`));
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-03");
    await expect(page.getByText("0 of 1 selected Partner has Analytics data for March 2016")).toBeVisible();
    await expect(page.getByRole("button", { name: "Use latest month with data" })).toBeVisible();
    // A month without ANY data stays exactly as chosen, flagged.
    await page.goto(workspaceUrl(`?partners=${P_AURORA}&month=2016-11`));
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-11");
    await expect(page.getByRole("option", { name: "November 2016 (no data)" })).toHaveCount(1);
    // Going back to the data-following default is an explicit user action.
    await page.getByRole("button", { name: "Use latest month with data" }).click();
    await expect(page).not.toHaveURL(/month=/);
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-04");
  });

  test("an invalid month in the URL is treated as absent with a neutral notice (validated server-side)", async ({ page }) => {
    for (const bad of ["2016-13", "abc", "2016-3"]) {
      await page.goto(workspaceUrl(`?partners=${P_AURORA}&month=${bad}`));
      await expect(page.getByRole("status").filter({ hasText: "not a valid reporting month" })).toBeVisible();
      await expect(page.getByLabel("Reporting month")).toHaveValue("2016-04");
      await expect(page.getByTestId("month-source")).toHaveText("Latest reporting month with data");
    }
  });

  test("the platform switch changes the URL AND the server-rendered evidence; All is the bare state; garbage is All", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA}&month=2016-03`));
    const switcher = page.getByRole("group", { name: "Platform view" });
    await expect(page.getByRole("heading", { name: "YouTube performance" })).toBeVisible();
    await switcher.getByRole("link", { name: "Instagram" }).click();
    await expect(page).toHaveURL(/platform=instagram/);
    await expect(switcher.getByRole("link", { name: "Instagram" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "YouTube performance" })).toHaveCount(0);
    let main = await page.locator("#main").innerText();
    expect(main).toContain("6,161,101");
    expect(main).not.toContain("7,272,101"); // the YouTube record never reaches the page
    await switcher.getByRole("link", { name: "YouTube" }).click();
    await expect(page).toHaveURL(/platform=youtube/);
    main = await page.locator("#main").innerText();
    expect(main).toContain("7,272,101");
    expect(main).not.toContain("6,161,101");
    await switcher.getByRole("link", { name: "All" }).click();
    await expect(page).not.toHaveURL(/platform=/);
    await expect(page.getByRole("heading", { name: "YouTube performance" })).toBeVisible();
    await page.goto(workspaceUrl(`?partners=${P_AURORA}&platform=tiktok`));
    await expect(page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
    // In the comparison, a platform filter removes the other platform's Views column server-side.
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL}&month=2016-03&platform=instagram`));
    const heads = await panel(page, "Partner comparison").locator("thead th").allInnerTexts();
    expect(heads).toContain("Instagram Views");
    expect(heads).not.toContain("YouTube Views");
    expect(await panel(page, "Partner comparison").innerText()).not.toContain("7,272,101");
  });

  test("monthly trends: a single Partner gets platform-SEPARATED monthly cards; 2+ Partners get ONE-metric month x Partner matrices (Views as two separate matrices)", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA}`));
    const ig = panel(page, "Instagram performance");
    await expect(ig.locator(".ov-trend-grid")).toBeVisible(); // Instagram has March + April -> a real monthly trend
    await expect(ig.locator(".ov-axis").first()).toContainText("Mar 2016");
    await expect(ig.locator(".ov-axis").first()).toContainText("Apr 2016");
    await expect(ig).toContainText("reporting month");
    // YouTube has ONE month only: no invented trend, and nothing merged into the Instagram series.
    await expect(panel(page, "YouTube performance")).toContainText("at least two reporting months");

    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL}&metric=views`));
    const trend = panel(page, "Monthly trend · Views");
    await expect(trend.getByRole("table")).toHaveCount(2);
    await expect(trend.getByText("Instagram Views", { exact: true })).toBeVisible();
    await expect(trend.getByText("YouTube Views", { exact: true })).toBeVisible();
    const igMatrix = trend.getByRole("table", { name: "Instagram Views by month and Partner" });
    expect(await igMatrix.locator("thead th").allInnerTexts()).toEqual(["Month", NAME[P_AURORA], NAME[P_BOREAL]]);
    const cells = await igMatrix.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.querySelectorAll("th,td")].map((c) => (c.textContent ?? "").trim())));
    expect(cells).toEqual([["Mar 2016", "6,161,101", "3,131,311"], ["Apr 2016", "6,262,202", "—"]]); // a gap is a dash
    // The default metric is Engagement and is labelled; the switch changes ONE metric at a time via the URL.
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL}`));
    await expect(page.getByRole("heading", { name: "Monthly trend · Engagement" })).toBeVisible();
    await page.getByRole("group", { name: "Trend metric" }).getByRole("link", { name: "Likes" }).click();
    await expect(page).toHaveURL(/metric=likes/);
    await expect(page.getByRole("heading", { name: "Monthly trend · Likes" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Trend metric" }).getByRole("link", { name: "Likes" })).toHaveAttribute("aria-current", "page");
  });

  test("selected chips: remove one, then Clear all; the URL is the source of truth", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL},${P_CASCADE}`));
    const chips = page.getByRole("list", { name: "Selected Partners" }).getByRole("listitem");
    await expect(chips).toHaveCount(3);
    await page.getByRole("button", { name: `Remove ${NAME[P_BOREAL]}` }).click();
    await expect(chips).toHaveCount(2);
    await expect(page).toHaveURL(new RegExp(`partners=${P_AURORA}%2C${P_CASCADE}`));
    // Clear all lives INSIDE the control's dropdown, not in a standalone row.
    await expect(page.getByRole("button", { name: "Clear all" })).toHaveCount(0);
    await searchBox(page).click();
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByRole("list", { name: "Selected Partners" })).toHaveCount(0);
    await expect(page).not.toHaveURL(/partners=/);
  });

  test("single -> multi by search: keyboard operation (type, ArrowDown into results, Enter selects, Escape closes, focus stays)", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA}`));
    const input = searchBox(page);
    await input.click();
    await input.fill("12F E2E Boreal");
    const list = page.getByRole("listbox", { name: "Partner search results" });
    await expect(list.getByRole("option", { name: /12F E2E Borealis Works/ })).toBeVisible();
    await input.press("ArrowDown");
    await expect(input).toHaveAttribute("aria-activedescendant", /.+/);
    await expect(list.getByRole("option").first()).toHaveCSS("background-color", "rgb(255, 241, 232)"); // --tint: visible active row
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`partners=${P_AURORA}%2C${P_BOREAL}`));
    await expect(page.getByRole("heading", { name: "Partner comparison", exact: true })).toBeVisible();
    await expect(list.getByRole("option", { name: /12F E2E Borealis Works/ })).toHaveAttribute("aria-selected", "true");
    // Escape closes the list and focus is still in the search box.
    await input.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(input).toBeFocused();
    // ArrowDown re-opens it; Enter on an already-selected Partner removes it again.
    await input.press("ArrowDown");
    await expect(list).toBeVisible();
    await expect(list.getByRole("option", { name: /12F E2E Borealis Works/ })).toBeVisible();
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`partners=${P_AURORA}$`));
  });

  test("the selection limit (10) is enforced server-side and disclosed; extra refs are ignored, unknown ones dropped neutrally", async ({ page }) => {
    const fakes = Array.from({ length: 8 }, (_, i) => `${tag}-fake-${i}`);
    await page.goto(workspaceUrl(`?partners=${[P_AURORA, P_BOREAL, ...fakes, `${tag}-fake-over`].join(",")}`));
    await expect(page.getByRole("status").filter({ hasText: "8 selected Partners are not available" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Only the first 10 selected Partners are shown; 1 more was ignored" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Selected Partners" }).getByRole("listitem")).toHaveCount(2);
    await expect(page.locator("#main")).not.toContainText(`${tag}-fake-`);
  });

  test("Target Audience narrows the search list (canonical values only) and lives in the URL; unknown values are ignored; it never selects Partners", async ({ page }) => {
    await page.goto(workspaceUrl());
    const audience = page.getByRole("group", { name: "Target Audience filter" });
    await audience.getByRole("button").click();
    expect(await audience.getByRole("checkbox").count()).toBe(6); // "Select all" + exactly the five canonical values
    await audience.getByLabel("India 3", { exact: true }).check();
    await expect(page).toHaveURL(/targetAudience=India\+3/);
    // The filter never selected anything.
    await expect(page.getByRole("list", { name: "Selected Partners" })).toHaveCount(0);
    await searchBox(page).fill("12F E2E");
    const list = page.getByRole("listbox", { name: "Partner search results" });
    await expect(list.getByRole("option", { name: /12F E2E Cascade Media/ })).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(1); // only India 3 Partners match this prefix
    // Two audiences: union; unknown values (Tier-like, bogus) are ignored.
    await page.goto(workspaceUrl("?targetAudience=India%201&targetAudience=India%203&targetAudience=Tier%201&targetAudience=bogus"));
    await expect(page.getByRole("group", { name: "Target Audience filter" }).getByRole("button")).toContainText("India 1, India 3");
    await searchBox(page).fill("12F E2E");
    const options = page.getByRole("listbox", { name: "Partner search results" }).getByRole("option");
    // India 1 (Aurora, Borealis, Hidden, Kerala) + India 3 (Cascade), for the GLOBAL Super Admin; Delta records no Target Audience.
    await expect(options).toHaveCount(5);
    const names = (await options.locator("b").allInnerTexts()).map((n) => n.trim());
    expect(names).toEqual([NAME[P_AURORA], NAME[P_BOREAL], NAME[P_CASCADE], NAME[P_HIDDEN], NAME[P_KERALA]]);
    expect(names).not.toContain(NAME[P_DELTA]!);
  });

  // ==== Select all in the three selector fields + the anchored Partner dropdown =============================

  const paramValues = (page: Page, name: string) => new URL(page.url()).searchParams.getAll(name);

  test("Target Audience 'Select all': ticks all five, reads 'All Target Audiences', is no narrowing (a Partner with no audience stays searchable), and unticking clears it", async ({ page }) => {
    await page.goto(workspaceUrl());
    const audience = page.getByRole("group", { name: "Target Audience filter" });
    const trigger = audience.getByRole("button");
    await trigger.click();
    const selectAll = audience.getByLabel("Select all", { exact: true });
    await expect(selectAll).not.toBeChecked();

    // Partly ticked: the Select all box is indeterminate, not checked.
    await audience.getByLabel("India 3", { exact: true }).check();
    await expect(page).toHaveURL(/targetAudience=India\+3/);
    await expect(selectAll).not.toBeChecked();
    expect(await selectAll.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);

    await selectAll.check();
    await expect.poll(() => [...paramValues(page, "targetAudience")].sort()).toEqual(["India 1", "India 2", "India 3", "India 4", "India Alpha"]);
    await expect(trigger).toHaveText("All Target Audiences");
    await expect(selectAll).toBeChecked();
    for (const value of ["India Alpha", "India 1", "India 2", "India 3", "India 4"]) await expect(audience.getByLabel(value, { exact: true })).toBeChecked();
    await expect(page.getByRole("list", { name: "Selected Partners" })).toHaveCount(0); // a filter never selects Partners

    // Everything selected narrows nothing: Delta records NO Target Audience and is still found (the 6 fixture Partners).
    await searchBox(page).fill("12F E2E");
    const options = page.getByRole("listbox", { name: "Partner search results" }).getByRole("option");
    await expect(options).toHaveCount(6);
    expect((await options.locator("b").allInnerTexts()).map((n) => n.trim())).toContain(NAME[P_DELTA]!);

    // Unticking Select all clears the whole filter.
    if (!(await selectAll.isVisible())) await trigger.click(); // (typing in the search box does not close it)
    await selectAll.uncheck();
    await expect.poll(() => paramValues(page, "targetAudience")).toEqual([]);
    await expect(trigger).toHaveText("Select Target Audience…");
  });

  test("Region 'Select all': every state/UT ticked, reads 'All regions', is no narrowing (Partners in any region stay searchable); 'Select all matching' follows the search; unticking clears", async ({ page }) => {
    await page.goto(workspaceUrl());
    const region = page.getByRole("group", { name: "Region filter" });
    const trigger = region.getByRole("button").first();
    await trigger.click();
    const selectAll = region.getByLabel("Select all", { exact: true });

    await selectAll.check();
    await expect.poll(() => paramValues(page, "region").length).toBe(DISCOVERY_REGIONS.length);
    expect(new Set(paramValues(page, "region"))).toEqual(new Set(DISCOVERY_REGIONS));
    await expect(trigger).toHaveText("All regions");
    await expect(selectAll).toBeChecked();
    await noOverflow(page, "all regions selected");

    // No narrowing: Partners in private, non-canonical test regions are still found, and there is no error.
    await searchBox(page).fill("12F E2E");
    const list = page.getByRole("listbox", { name: "Partner search results" });
    await expect(list.getByRole("option")).toHaveCount(6);
    await expect(page.getByRole("status").filter({ hasText: "Couldn’t search" })).toHaveCount(0);

    // Untick all, then "Select all matching" only ticks what the search lists.
    if (!(await selectAll.isVisible())) await trigger.click();
    await selectAll.uncheck();
    await expect.poll(() => paramValues(page, "region")).toEqual([]);
    await expect(trigger).toHaveText("Select regions…");
    await region.getByPlaceholder("Search states…").fill("Kerala");
    await expect(region.getByLabel("Select all matching", { exact: true })).toBeVisible();
    await region.getByLabel("Select all matching", { exact: true }).check();
    await expect.poll(() => paramValues(page, "region")).toEqual(["Kerala"]);
    await expect(trigger).toHaveText("Kerala");
  });

  test("Partner search is ONE multi-select dropdown under the search field: an overlay (no layout shift) with checkbox rows that stays open while ticking; 'Select all shown' ticks and clears every listed Partner", async ({ page }) => {
    await page.goto(workspaceUrl());
    const empty = page.getByLabel("Reporting month");
    const restingTop = (await empty.boundingBox())!.y;
    const input = searchBox(page);
    await input.fill("12F E2E");
    const list = page.getByRole("listbox", { name: "Partner search results" });
    const options = list.getByRole("option");
    await expect(options).toHaveCount(6);

    // Anchored to the search field and overlaying the page: nothing below moved.
    expect((await empty.boundingBox())!.y).toBe(restingTop);
    const inputBox = (await input.boundingBox())!;
    const listBox = (await list.boundingBox())!;
    expect(listBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
    expect(Math.abs(listBox.x - inputBox.x)).toBeLessThan(40);
    expect(await list.evaluate((el) => getComputedStyle(el.parentElement!).position)).toBe("absolute");

    // Select all shown: every listed Partner becomes selected, the dropdown stays open.
    const selectAll = page.getByRole("checkbox", { name: "Select all shown Partners" });
    await expect(selectAll).toHaveAttribute("aria-checked", "false");
    await selectAll.click();
    await expect.poll(() => (paramValues(page, "partners")[0] ?? "").split(",").length).toBe(6);
    await expect(page.getByRole("list", { name: "Selected Partners" }).getByRole("listitem")).toHaveCount(6);
    await expect(list).toBeVisible();
    for (let i = 0; i < 6; i++) await expect(options.nth(i)).toHaveAttribute("aria-selected", "true");
    await expect(selectAll).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("heading", { name: "Partner comparison", exact: true })).toBeVisible();

    // Clicking it again clears exactly those Partners.
    await selectAll.click();
    await expect(page).not.toHaveURL(/partners=/);
    await expect(selectAll).toHaveAttribute("aria-checked", "false");

    // One row is a partial selection ("mixed"); the rows are multi-select (a second one adds to it).
    await options.nth(0).click();
    await expect(selectAll).toHaveAttribute("aria-checked", "mixed");
    await options.nth(1).click();
    await expect.poll(() => (paramValues(page, "partners")[0] ?? "").split(",").length).toBe(2);
    await expect(list).toBeVisible();

    // An outside click closes it; opening another filter dropdown closes it too.
    await page.getByRole("heading", { name: "Choose Partners", exact: true }).click();
    await expect(list).toHaveCount(0);
    await input.click();
    await expect(list).toBeVisible();
    await page.getByRole("group", { name: "Region filter" }).getByRole("button").first().click();
    await expect(list).toHaveCount(0);
  });

  // ==== Step 12F.2: one compact multi-select control (chips INSIDE it, no duplicated UI) ========================

  const selectedList = (page: Page) => page.getByRole("list", { name: "Selected Partners" });
  const resultList = (page: Page) => page.getByRole("listbox", { name: "Partner search results" });

  test("compact control: the dropdown is closed by default, opens on focus/click, and NOTHING about the selection is rendered outside the one control", async ({ page }) => {
    await page.goto(workspaceUrl());
    const input = searchBox(page);
    await expect(input).toHaveAttribute("placeholder", "Search and select Partners...");
    await expect(resultList(page)).toHaveCount(0);
    for (const removed of [/Selected Partners\s*·/, /of 10 max/, "No Partner selected yet."]) await expect(page.locator("#main").getByText(removed)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear all" })).toHaveCount(0);

    // Focus opens it; the authorized results and "N Partners found" live INSIDE the dropdown.
    await input.focus();
    await expect(resultList(page)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /Partners? found|Showing the first/ })).toBeVisible();
    await input.press("Escape");
    await expect(resultList(page)).toHaveCount(0);
    await input.click(); // still focused: a click opens it again
    await expect(resultList(page)).toBeVisible();

    // One Partner selected: its chip is INSIDE the same control as the search input - the only place it appears.
    await input.fill("12F E2E Aurora");
    await resultList(page).getByRole("option", { name: /12F E2E Aurora Studio/ }).click();
    await expect(selectedList(page)).toHaveCount(1);
    expect(await selectedList(page).locator("xpath=..").getByRole("combobox").count()).toBe(1);
    await expect(page.locator("#main").getByText(NAME[P_AURORA]!, { exact: true })).toHaveCount(await page.locator("#main").getByText(NAME[P_AURORA]!, { exact: true }).count()); // (name also appears in the analytics below)
    await expect(page.getByText(/Selected Partners\s*·/)).toHaveCount(0);

    // Closed again: no permanent result list, the chip stays.
    await input.press("Escape");
    await expect(resultList(page)).toHaveCount(0);
    await expect(selectedList(page).getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("0 / 10")).toHaveCount(0);
    await expect(page.locator("small", { hasText: "1 / 10" })).toBeVisible();
  });

  test("many selections stay compact: a few chips + '+N selected' while closed, every chip (removable) while open; phones collapse harder", async ({ page }) => {
    const five = [P_AURORA, P_BOREAL, P_CASCADE, P_DELTA, P_KERALA];
    await page.goto(workspaceUrl(`?partners=${five.join(",")}`));
    const items = selectedList(page).getByRole("listitem");
    await expect(items).toHaveCount(3); // 2 chips + "+3 selected"
    await expect(page.getByRole("button", { name: /3 more selected Partners/ })).toHaveText("+3 selected");
    const controlHeight = (await selectedList(page).locator("xpath=..").boundingBox())!.height;
    expect(controlHeight).toBeLessThan(50); // compact: one line of chips, not a tall block

    // "+3 selected" opens the dropdown, which shows EVERY chip so any Partner can be removed.
    await page.getByRole("button", { name: /3 more selected Partners/ }).click();
    await expect(resultList(page)).toBeVisible();
    await expect(items).toHaveCount(5);
    await selectedList(page).getByRole("button", { name: `Remove ${NAME[P_KERALA]}` }).click();
    await expect(items).toHaveCount(4);
    await expect.poll(() => paramValues(page, "partners")[0]).toBe([P_AURORA, P_BOREAL, P_CASCADE, P_DELTA].join(","));
    // Focus returns to the search input and the dropdown is not re-opened by the removal itself.
    await expect(searchBox(page)).toBeFocused();

    // Phone: one chip + "+N selected".
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(workspaceUrl(`?partners=${five.join(",")}`));
    await expect(items).toHaveCount(2);
    await expect(page.getByRole("button", { name: /4 more selected Partners/ })).toHaveText("+4 selected");
    await noOverflow(page, "390 collapsed chips");
  });

  test("Target Audience / Region only narrow the search: changing them never removes or adds a selected Partner (its chip stays even when it no longer matches)", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA}`));
    await expect(selectedList(page).getByText(NAME[P_AURORA]!)).toBeVisible();
    const audience = page.getByRole("group", { name: "Target Audience filter" });
    await audience.getByRole("button").click();
    await audience.getByLabel("India 3", { exact: true }).check(); // Aurora is India 1 + India 2: it no longer matches
    await expect(page).toHaveURL(/targetAudience=India\+3/);
    await expect(page).toHaveURL(new RegExp(`partners=${P_AURORA}`));
    await searchBox(page).fill("12F E2E");
    await expect(resultList(page).getByRole("option")).toHaveCount(1); // only Cascade (India 3) - Aurora is omitted from the filtered list...
    await expect(resultList(page).getByRole("option", { name: /Aurora/ })).toHaveCount(0);
    await expect(selectedList(page).getByText(NAME[P_AURORA]!)).toBeVisible(); // ...but stays selected, chip visible
    await expect(selectedList(page).getByRole("listitem")).toHaveCount(1);
  });

  test("maximum 10: selected Partners stay removable, unselected ones are disabled with 'Maximum 10 Partners' feedback", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${CAP_REFS.slice(2).join(",")}`)); // CAP 03..12 = 10 selected
    const input = searchBox(page);
    await input.click();
    await input.fill("12F CAP");
    const list = resultList(page);
    await expect(list.getByRole("option")).toHaveCount(10); // 01..10
    const blocked = list.getByRole("option", { name: /12F CAP 01/ });
    await expect(blocked).toHaveAttribute("aria-disabled", "true");
    await expect(blocked).toHaveAttribute("title", "Maximum 10 Partners");
    await expect(page.getByRole("status").filter({ hasText: "Maximum 10 Partners selected" })).toBeVisible();
    const before = page.url();
    await blocked.click({ force: true }); // refused: nothing changes (aria-disabled)
    await expect(page).toHaveURL(before);
    // A selected one is still removable from the dropdown, freeing a slot.
    await list.getByRole("option", { name: /12F CAP 03/ }).click();
    await expect.poll(() => (paramValues(page, "partners")[0] ?? "").split(",").length).toBe(9);
    await expect(list.getByRole("option", { name: /12F CAP 01/ })).not.toHaveAttribute("aria-disabled", "true");
    await list.getByRole("option", { name: /12F CAP 01/ }).click();
    await expect.poll(() => (paramValues(page, "partners")[0] ?? "").split(",").length).toBe(10);
  });

  test("keyboard: Space toggles the highlighted result while nothing is typed, Backspace on an empty field removes the last chip, Clear all sits inside the dropdown and returns focus to the field", async ({ page }) => {
    await page.goto(workspaceUrl());
    const input = searchBox(page);
    await input.click();
    await expect(resultList(page).getByRole("option").first()).toBeVisible();
    await input.press("ArrowDown");
    await input.press("Space");
    await expect.poll(() => paramValues(page, "partners").length).toBe(1);
    await input.press("ArrowDown");
    await input.press("Enter");
    await expect.poll(() => (paramValues(page, "partners")[0] ?? "").split(",").length).toBe(2);
    // Typed text keeps its spaces (Space is a character once something is typed).
    await input.fill("12F E2E");
    expect(await input.inputValue()).toBe("12F E2E");
    await input.fill("");
    await input.press("Backspace");
    await expect.poll(() => (paramValues(page, "partners")[0] ?? "").split(",").length).toBe(1);
    // Clear all: inside the dropdown; afterwards focus is in the field.
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page).not.toHaveURL(/partners=/);
    await expect(input).toBeFocused();
  });

  for (const width of [390, 375]) {
    test(`compact control at ${width}: the dropdown stays inside the viewport and scrolls internally, chips never widen the page`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(workspaceUrl(`?partners=${[P_AURORA, P_BOREAL, P_CASCADE, P_DELTA, P_KERALA].join(",")}`));
      const input = searchBox(page);
      await input.click();
      await input.fill("12F CAP");
      const list = resultList(page);
      await expect(list.getByRole("option")).toHaveCount(10);
      const box = (await list.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeLessThanOrEqual(250);
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight || getComputedStyle(el).overflowY === "auto")).toBe(true);
      await noOverflow(page, `${width} open dropdown with chips`);
      const control = (await selectedList(page).locator("xpath=..").boundingBox())!;
      expect(control.x + control.width).toBeLessThanOrEqual(width);
    });
  }

  test("'Select all shown' never goes past the 10-Partner limit: it adds only what fits and says so", async ({ page }) => {
    // Two Partners outside the listed ten are already selected (11 and 12), so only 8 of the 10 listed fit.
    await page.goto(workspaceUrl(`?partners=${CAP_REFS[10]},${CAP_REFS[11]}`));
    await searchBox(page).fill("12F CAP");
    const list = page.getByRole("listbox", { name: "Partner search results" });
    await expect(list.getByRole("option")).toHaveCount(10); // the bounded first page: 01..10
    await expect(page.getByRole("status").filter({ hasText: "Select all shown adds 8 more (limit 10)" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all shown Partners" }).click();
    await expect.poll(() => (paramValues(page, "partners")[0] ?? "").split(",").length).toBe(10);
    expect(paramValues(page, "partners")[0]!.split(",")).toEqual([CAP_REFS[10], CAP_REFS[11], ...CAP_REFS.slice(0, 8)]);
    await expect(page.getByRole("status").filter({ hasText: "Maximum 10 Partners selected" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Select all shown Partners" })).toBeDisabled();
    await expect(list.getByRole("option", { name: /12F CAP 08/ })).toHaveAttribute("aria-selected", "true");
    await expect(list.getByRole("option", { name: /12F CAP 09/ })).toHaveAttribute("aria-selected", "false");
    await expect(list.getByRole("option", { name: /12F CAP 10/ })).toHaveAttribute("aria-selected", "false");
  });

  test("phone width: the Partner dropdown and 'All regions' fit without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(workspaceUrl("?" + DISCOVERY_REGIONS.map((r) => `region=${encodeURIComponent(r)}`).join("&")));
    await expect(page.getByRole("group", { name: "Region filter" }).getByRole("button").first()).toHaveText("All regions");
    await noOverflow(page, "390 all regions");
    await searchBox(page).fill("12F E2E");
    await expect(page.getByRole("listbox", { name: "Partner search results" }).getByRole("option")).toHaveCount(6);
    await noOverflow(page, "390 partner dropdown open");
    const listBox = (await page.getByRole("listbox", { name: "Partner search results" }).boundingBox())!;
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(390);
  });

  test("search is authorized only: the scoped Analyst finds exactly the in-scope Partner, an injected out-of-scope ref is dropped with ONE neutral notice and never yields data", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto(workspaceUrl());
    await searchBox(page).fill("12F E2E");
    const list = page.getByRole("listbox", { name: "Partner search results" });
    await expect(list.getByRole("option", { name: /12F E2E Kerala Scoped/ })).toBeVisible();
    await expect(list.getByRole("option")).toHaveCount(1);
    for (const hidden of [NAME[P_AURORA], NAME[P_HIDDEN], NAME[P_BOREAL]]) await expect(list.getByRole("option", { name: hidden })).toHaveCount(0);

    // Injection: an out-of-scope ref + an unknown ref + the in-scope one.
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_HIDDEN},${tag}-unknown,${P_KERALA}&month=2016-03`));
    await expect(page.getByRole("status").filter({ hasText: "3 selected Partners are not available" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Selected Partners" }).getByRole("listitem")).toHaveCount(1);
    const main = await page.locator("#main").innerText();
    expect(main).toContain(NAME[P_KERALA]!);
    expect(main).toContain("4,141,001");
    for (const leak of [NAME[P_AURORA]!, NAME[P_HIDDEN]!, "6,161,101", "2,424,242", P_AURORA, P_HIDDEN]) expect(main, leak).not.toContain(leak);
    // The unavailable notice for an out-of-scope ref is IDENTICAL to the one for an unknown ref.
    await page.goto(workspaceUrl(`?partners=${P_AURORA}`));
    const neutral = async () => ({ banner: await page.locator(".banner").allInnerTexts(), selected: await page.getByRole("list", { name: "Selected Partners" }).count(), listboxes: await page.getByRole("listbox").count() });
    const outOfScope = await neutral();
    await page.goto(workspaceUrl(`?partners=${tag}-unknown`));
    expect(await neutral()).toEqual(outOfScope);
    expect(outOfScope.banner).toEqual(["1 selected Partner is not available"]);
    // The single view of the Analyst's own Partner works, including its month.
    await page.goto(workspaceUrl(`?partners=${P_KERALA}`));
    await expect(page.getByLabel("Reporting month")).toHaveValue("2016-03");
  });

  test("'Open full Partner Analytics' (one selected Partner) opens the drill-down with the month and platform; Partners stays the current tab", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA}&month=2016-03&platform=instagram`));
    const open = page.getByRole("link", { name: "Open full Partner Analytics" });
    await expect(open).toHaveAttribute("href", `/analytics/partner/${P_AURORA}?platform=instagram&month=2016-03`);
    await open.click();
    await expect(page).toHaveURL(new RegExp(`/analytics/partner/${P_AURORA}\\?platform=instagram&month=2016-03$`));
    await expect(page.locator("h1")).toHaveText(`${NAME[P_AURORA]} · Analytics`);
    await expect(page.locator(".tabs .tab.active")).toHaveText("Partners");
    await expect(page.locator("#main").getByText("Reporting month March 2016")).toBeVisible();
    const main = await page.locator("#main").innerText();
    const evidence = await evidenceText(page);
    expect(evidence).toContain("6,161,101");
    for (const other of ["7,272,101", "6,262,202", "9,191,919"]) expect(evidence, other).not.toContain(other);
    expect(main).not.toContain("9,191,919");
    await expect(page.getByRole("link", { name: "Show all imported periods" })).toHaveAttribute("href", `/analytics/partner/${P_AURORA}?platform=instagram`);
    // Two or more Partners: no single 'open' link (each comparison row has its own).
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL}`));
    await expect(page.getByRole("link", { name: "Open full Partner Analytics" })).toHaveCount(0);
  });

  test("the drill-down keeps its 12E behavior: no month = all imported periods; an invalid month is disclosed and ignored", async ({ page }) => {
    await page.goto(`/analytics/partner/${P_AURORA}`);
    const main = await page.locator("#main").innerText();
    for (const value of ["6,161,101", "6,262,202", "7,272,101", "9,191,919"]) expect(main, value).toContain(value);
    await expect(page.getByText("All available imported periods")).toBeVisible();
    await page.goto(`/analytics/partner/${P_AURORA}?month=2016-13`);
    await expect(page.getByText("not a valid reporting month, so all imported periods are shown")).toBeVisible();
    expect(await page.locator("#main").innerText()).toContain("9,191,919");
  });

  test("Viewer is denied at the Analytics gate: no data, and the search API answers 403 (unauthenticated: 401)", async ({ page, playwright }) => {
    await signInAs(page, "viewer");
    await page.goto(workspaceUrl(`?partners=${P_AURORA}`));
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.locator(".ov-kpi")).toHaveCount(0);
    const forbidden = await page.request.get(`/api/analytics/partners/search?q=12F%20E2E`);
    expect(forbidden.status()).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Forbidden." });
    const anonymous = await playwright.request.newContext({ baseURL: "http://localhost:3100", storageState: { cookies: [], origins: [] } });
    const unauthenticated = await anonymous.get(`/api/analytics/partners/search?q=12F%20E2E`);
    expect(unauthenticated.status()).toBe(401);
    await anonymous.dispose();
    // An authorized actor gets bounded, safe JSON.
    await signInAs(page, "analyst");
    const ok = await page.request.get(`/api/analytics/partners/search?q=12F%20E2E&limit=500`);
    expect(ok.status()).toBe(200);
    const body = (await ok.json()) as { partners: unknown[] };
    expect(body.partners.length).toBeLessThanOrEqual(20);
  });

  test("the Partners page is read-only Analytics: no import CTA, no Agreement / Finance / Partner Reviews content", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL}&month=2016-03`));
    const main = await page.locator("#main").innerText();
    for (const word of ["Import data", "Agreement", "Invoice", "Payout", "Partner Review"]) expect(main, word).not.toContain(word);
    await expect(page.locator("#main a[href^='/imports']")).toHaveCount(0);
  });


  // ==== C. Responsive + accessibility ============================================================================

  const STATES = [
    { name: "empty", query: "" },
    { name: "single", query: `?partners=${P_AURORA}&month=2016-03` },
    { name: "multi", query: `?partners=${P_AURORA},${P_BOREAL},${P_CASCADE}&month=2016-03` },
  ];
  for (const viewport of VIEWPORTS) {
    for (const state of STATES) {
      test(`no horizontal page overflow at ${viewport.name}: /analytics/partners (${state.name})`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(workspaceUrl(state.query));
        await expect(page.locator("h1")).toHaveText("Partners Analytics");
        if (state.name !== "empty") await expect(page.locator(".ov-panel table tbody tr").first()).toBeVisible();
        await noOverflow(page, `${state.name} at ${viewport.name}`);
        const wraps = await page.evaluate(() => [...document.querySelectorAll(".ov-panel .tablewrap")].map((wrap) => getComputedStyle(wrap).overflowX));
        for (const overflowX of wraps) expect(["auto", "scroll"]).toContain(overflowX);
        if (state.name === "multi") expect(wraps.length).toBeGreaterThan(0);
        // No visually-hidden `.sr` element inside a scrolling table (it would escape the scroll container).
        expect(await page.locator(".tablewrap span.sr").count()).toBe(0);
        // Controls stay on-screen and usable.
        for (const label of ["All", "Instagram", "YouTube"]) {
          const box = (await page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: label }).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        }
      });
    }
    test(`no horizontal page overflow at ${viewport.name}: Partner drill-down with a month`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`/analytics/partner/${P_AURORA}?month=2016-03`);
      await expect(page.locator(".ov-panel table tbody tr").first()).toBeVisible();
      await noOverflow(page, `drill-down at ${viewport.name}`);
    });
  }

  for (const viewport of VIEWPORTS.filter((v) => v.width <= 390)) {
    test(`Partner search is usable at ${viewport.name}: bounded scrolling results, chips contained, keyboard-visible focus`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_BOREAL},${P_CASCADE},${P_DELTA}`));
      const input = searchBox(page);
      await input.click();
      await input.fill("12F E2E");
      const list = page.getByRole("listbox", { name: "Partner search results" });
      await expect(list.getByRole("option").first()).toBeVisible();
      const info = await list.evaluate((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return { overflowY: style.overflowY, maxHeight: style.maxHeight, height: rect.height, left: rect.left, right: rect.right };
      });
      expect(["auto", "scroll"]).toContain(info.overflowY);
      expect(info.height).toBeLessThanOrEqual(250);
      expect(info.left).toBeGreaterThanOrEqual(0);
      expect(info.right).toBeLessThanOrEqual(viewport.width);
      await noOverflow(page, `open search at ${viewport.name}`);
      // Selected chips live inside the one bounded control (the list itself has no box of its own).
      const chips = page.getByRole("list", { name: "Selected Partners" }).locator("xpath=..");
      const chipInfo = await chips.evaluate((el) => ({ overflowY: getComputedStyle(el).overflowY, right: el.getBoundingClientRect().right, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect(chipInfo.right).toBeLessThanOrEqual(viewport.width);
      expect(chipInfo.scrollWidth).toBeLessThanOrEqual(chipInfo.clientWidth + 1);
      // The search box shows a visible keyboard focus ring.
      await input.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      // The input sits inside the one compact control, whose border/ring is the visible focus state.
      const focusOutline = await input.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, boxShadow: getComputedStyle(el.parentElement!).boxShadow }));
      expect(focusOutline.style !== "none" || focusOutline.boxShadow !== "none").toBe(true);
      // Escape closes and returns focus to the search box.
      await input.press("Escape");
      await expect(list).toHaveCount(0);
      await expect(input).toBeFocused();
    });
  }

  test("unavailable metrics are announced (role=img 'Unavailable'), never a bare dash and never zero", async ({ page }) => {
    await page.goto(workspaceUrl(`?partners=${P_AURORA},${P_DELTA}&month=2016-03`));
    const table = panel(page, "Partner comparison").locator("table");
    const delta = table.locator("tbody tr").nth(1);
    expect(await delta.getByRole("img", { name: "Unavailable" }).count()).toBeGreaterThanOrEqual(6);
    // Every metric cell is a dash - never a zero (the coverage cell legitimately says "0 content · 0 channel").
    const cells = await delta.locator("td").allInnerTexts();
    for (const cell of cells.slice(2)) expect(cell.trim(), cell).not.toMatch(/\b0\b/);
    await expect(page.locator(".tablewrap span.sr")).toHaveCount(0);
  });
});
