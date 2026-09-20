import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";
import { analyticsChannelSourceRecordsCollection, analyticsContentSourceRecordsCollection, analyticsImportBatchesCollection } from "@/server/analytics/firestore";
import { analyticsChannelSourceRecordDocSchema, analyticsContentSourceRecordDocSchema, analyticsImportBatchDocSchema } from "@/server/analytics/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { partnerAccountDocSchema, partnerDocSchema } from "@/server/partners/types";

// Step 12E - the Partner-wise Analytics drill-down (/analytics/partner/[partnerId]),
// exercised through the real UI on real emulator data. Runs in the default
// `chromium` project (pre-authed as the seeded Super Admin, GLOBAL scope);
// tests needing another identity sign in explicitly.
//
// Data: schema-valid Analytics source records, Partners and Partner Accounts are
// written with the Admin SDK in beforeAll (a Partner-MATCHED content record needs
// a Content thread with a claimed URL to arise through the import pipeline, which
// is out of this step's scope) under a PRIVATE region - so only the GLOBAL Super
// Admin sees them - with distinctive 7-digit values no other spec uses, and
// removed again in afterAll. Values are asserted through the rendered
// rows/cells, never through totals other specs' data could move.
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;
const tag = "e2e12e";
const REGION = `${tag}-region-private`;
const REGION_HIDDEN = `${tag}-region-hidden`;
const BATCH = `${tag}-batch`;
const BATCH_FILENAME = `${tag}-export.xlsx`;

const P_MAIN = `${tag}-partner-main`;
const P_IG_ONLY = `${tag}-partner-ig-only`;
const P_ENG = `${tag}-partner-eng`;
const P_HIDDEN = `${tag}-partner-hidden`;
const P_OTHER = `${tag}-partner-other`;
const NAME: Record<string, string> = {
  [P_MAIN]: "E2E Aurora Studio 12E",
  [P_IG_ONLY]: "E2E Igonly Collective 12E",
  [P_ENG]: "E2E Engagement Only 12E",
  [P_HIDDEN]: "E2E Hidden Region Partner 12E",
  [P_OTHER]: "E2E Other Same Region 12E",
};
const ACC_IG1 = `${tag}-acct-ig1`;
const ACC_IG2 = `${tag}-acct-ig2`;
const ACC_YT1 = `${tag}-acct-yt1`;
const ACC_ONLY = `${tag}-acct-only`;
const ACC_OTHER = `${tag}-acct-other`;
const ACC_LABEL = { [ACC_IG1]: "E2E IG One 12E", [ACC_IG2]: "E2E IG Two 12E", [ACC_YT1]: "E2E YT One 12E" };

// Distinctive values. Main partner IG: views 6,161,101/102/103; YT: 7,272,101/102. Followers IG one 8,181,001
// (latest of 2) / IG two 1,818,181 / YT 9,191,919. Other same-region Partner: 5,353,535 (must never appear on Aurora's page).
const IG_VIEWS = ["6,161,101", "6,161,102", "6,161,103"];
const YT_VIEWS = ["7,272,101", "7,272,102"];

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
  account?: string | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  engagement?: number | null;
  posted: string;
  period?: { start: string; end: string } | null;
  createdAt?: string;
  region?: string;
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
    reportingPeriod: o.period ?? null,
    matchState: "MATCHED",
    matchEvidence: { tier: "published_url", value: null, reasonCode: null, candidateCount: 1 },
    matchedContentRef: null,
    matchedAssignmentRef: null,
    matchedCampaignRef: null,
    matchedPartnerRef: o.partner,
    matchedPartnerAccountRef: o.account ?? null,
    ownerUid: null,
    regionIds: [o.region ?? REGION],
    teamIds: [],
    createdAt: o.createdAt ?? now,
  });
}
function channelDoc(o: { ref: string; platform: "instagram" | "youtube"; partner: string; account: string | null; followers: number | null; period: { start: string; end: string } | null; createdAt?: string }) {
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
    matchedPartnerAccountRef: o.account,
    ownerUid: null,
    regionIds: [REGION],
    teamIds: [],
    createdAt: o.createdAt ?? now,
  });
}

const JAN = { start: "2097-01-01", end: "2097-01-31" };
const FEB = { start: "2097-02-01", end: "2097-02-28" };

test.describe.configure({ mode: "serial" });

test.describe("Partner Analytics drill-down", () => {
  test.beforeAll(async () => {
    await put(
      analyticsImportBatchesCollection(),
      analyticsImportBatchDocSchema.parse({
        uid: BATCH,
        batchRef: BATCH,
        targetKind: "campaign_content",
        sourceFilename: BATCH_FILENAME,
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

    const partner = (ref: string, region: string) =>
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
        tier: null,
        priority: null,
        targetAudience: [],
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
    for (const ref of [P_MAIN, P_IG_ONLY, P_ENG, P_OTHER]) await put(partnersCollection(), partner(ref, REGION));
    await put(partnersCollection(), partner(P_HIDDEN, REGION_HIDDEN));

    const account = (uid: string, partnerRef: string, platform: string, handle: string, displayName: string | null) =>
      partnerAccountDocSchema.parse({
        uid,
        partnerAccountRef: uid,
        version: 1,
        partnerRef,
        platform,
        handle,
        displayName,
        profileUrl: null,
        platformAccountId: null,
        normalizedIdentity: `${tag}:${uid}`,
        primary: false,
        status: "ACTIVE",
        followerSnapshot: null,
        originAssetDecision: null,
        originLeadRef: null,
        createdAt: now,
        createdByUserRef: tag,
        updatedAt: now,
        updatedByUserRef: tag,
      });
    await put(partnerAccountsCollection(), account(ACC_IG1, P_MAIN, "instagram", `${tag}_ig_one`, ACC_LABEL[ACC_IG1]));
    await put(partnerAccountsCollection(), account(ACC_IG2, P_MAIN, "instagram", `${tag}_ig_two`, ACC_LABEL[ACC_IG2]));
    await put(partnerAccountsCollection(), account(ACC_YT1, P_MAIN, "youtube", `${tag}_yt_one`, ACC_LABEL[ACC_YT1]));
    await put(partnerAccountsCollection(), account(ACC_ONLY, P_IG_ONLY, "instagram", `${tag}_only_ig`, "E2E Only IG 12E"));
    await put(partnerAccountsCollection(), account(ACC_OTHER, P_OTHER, "instagram", `${tag}_other_ig`, "E2E Other Account 12E"));

    // The Instagram / YouTube pages list only the 10 newest rows, and analytics-platform-views.spec.ts (which may run in
    // parallel) plants its own rows dated 2099-01..03. So THIS Partner's rows are dated 2098 (right behind those, well inside
    // the top 10) and every other fixture Partner's rows are dated 2050 - this spec never pushes another spec's rows out.
    const contents = [
      contentDoc({ ref: "main-ig-1", platform: "instagram", partner: P_MAIN, account: ACC_IG1, views: 6_161_101, likes: 616_101, comments: 6_101, engagement: 61_101, posted: "2098-06-01T10:00:00.000Z", period: JAN }),
      contentDoc({ ref: "main-ig-2", platform: "instagram", partner: P_MAIN, account: ACC_IG2, views: 6_161_102, likes: 616_102, comments: null, engagement: null, posted: "2098-05-01T10:00:00.000Z", period: FEB }),
      contentDoc({ ref: "main-ig-3", platform: "instagram", partner: P_MAIN, account: ACC_IG1, views: 6_161_103, likes: 616_103, comments: 6_103, engagement: 61_103, posted: "2098-04-01T10:00:00.000Z", period: FEB }),
      contentDoc({ ref: "main-yt-1", platform: "youtube", partner: P_MAIN, account: ACC_YT1, views: 7_272_101, likes: 727_101, comments: 7_101, engagement: 72_101, posted: "2098-06-02T10:00:00.000Z", period: JAN }),
      contentDoc({ ref: "main-yt-2", platform: "youtube", partner: P_MAIN, account: ACC_YT1, views: 7_272_102, likes: null, comments: 7_102, engagement: null, posted: "2098-05-02T10:00:00.000Z", period: FEB }),
      // Another Partner in the SAME region: must never appear on Aurora's page.
      contentDoc({ ref: "other-ig", platform: "instagram", partner: P_OTHER, account: ACC_OTHER, views: 5_353_535, likes: 535_353, posted: "2050-12-03T10:00:00.000Z", period: JAN }),
      contentDoc({ ref: "other-yt", platform: "youtube", partner: P_OTHER, views: 4_646_464, posted: "2050-12-04T10:00:00.000Z", period: JAN }),
      // Instagram-only Partner.
      contentDoc({ ref: "only-ig-1", platform: "instagram", partner: P_IG_ONLY, account: ACC_ONLY, views: 3_131_311, likes: 313_131, posted: "2050-09-01T10:00:00.000Z", period: JAN }),
      // Engagement-only Partner (no Views anywhere).
      contentDoc({ ref: "eng-1", platform: "instagram", partner: P_ENG, views: null, engagement: 8_181_811, likes: 1, posted: "2050-09-02T10:00:00.000Z", period: JAN }),
      contentDoc({ ref: "eng-2", platform: "instagram", partner: P_ENG, views: null, engagement: 8_181_822, likes: 2, posted: "2050-09-03T10:00:00.000Z", period: JAN }),
      // The hidden-region Partner has a record in the hidden region.
      contentDoc({ ref: "hidden-ig", platform: "instagram", partner: P_HIDDEN, views: 2_424_242, posted: "2050-09-04T10:00:00.000Z", period: JAN, region: REGION_HIDDEN }),
    ];
    const channels = [
      channelDoc({ ref: "ig1-old", platform: "instagram", partner: P_MAIN, account: ACC_IG1, followers: 8_181_000, period: JAN, createdAt: "2097-02-01T00:00:00.000Z" }),
      channelDoc({ ref: "ig1-new", platform: "instagram", partner: P_MAIN, account: ACC_IG1, followers: 8_181_001, period: FEB, createdAt: "2097-03-01T00:00:00.000Z" }),
      channelDoc({ ref: "ig2", platform: "instagram", partner: P_MAIN, account: ACC_IG2, followers: 1_818_181, period: FEB, createdAt: "2097-03-01T00:00:00.000Z" }),
      channelDoc({ ref: "yt1", platform: "youtube", partner: P_MAIN, account: ACC_YT1, followers: 9_191_919, period: FEB, createdAt: "2097-03-01T00:00:00.000Z" }),
      channelDoc({ ref: "other", platform: "instagram", partner: P_OTHER, account: ACC_OTHER, followers: 5_454_545, period: FEB }),
    ];
    const db = getAdminFirestore();
    const writes = [...contents.map((doc) => ({ collection: analyticsContentSourceRecordsCollection(), doc })), ...channels.map((doc) => ({ collection: analyticsChannelSourceRecordsCollection(), doc }))];
    const batch = db.batch();
    for (const { collection, doc } of writes) {
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

  const url = (partner: string, platform?: string) => `/analytics/partner/${partner}${platform ? `?platform=${platform}` : ""}`;
  const panel = (page: Page, title: string) => page.locator(".ov-panel", { has: page.getByRole("heading", { name: title, exact: true }) });

  // ---- Navigation / IA -----------------------------------------------------------------------------

  test("header, back links and the UNCHANGED tab bar (no new tab, none marked current)", async ({ page }) => {
    await page.goto(url(P_MAIN));
    await expect(page.locator("h1")).toHaveText(`${NAME[P_MAIN]} · Analytics`);
    const tabs = page.locator(".tabs .tab");
    await expect(tabs).toHaveText(["Overview", "Instagram", "YouTube", "Data Explorer", "Import History"]);
    await expect(tabs).toHaveCount(5);
    for (const [index, href] of ["/analytics", "/analytics/instagram", "/analytics/youtube", "/analytics/explorer", "/analytics/import-history"].entries()) await expect(tabs.nth(index)).toHaveAttribute("href", href);
    await expect(page.locator(".tabs .tab.active")).toHaveCount(0);
    await expect(page.locator(".tabs .tab[aria-current]")).toHaveCount(0);
    // Not a sidebar item either.
    await expect(page.locator("nav[aria-label='Global navigation'] a[href^='/analytics']")).toHaveCount(1);

    const actions = page.locator(".head .actions");
    await expect(actions.getByRole("link", { name: "Analytics Overview" })).toHaveAttribute("href", "/analytics");
    await expect(actions.getByRole("link", { name: "Instagram Analytics" })).toHaveAttribute("href", "/analytics/instagram");
    await expect(actions.getByRole("link", { name: "YouTube Analytics" })).toHaveAttribute("href", "/analytics/youtube");
    await expect(actions.getByRole("link", { name: "Data Explorer" })).toHaveAttribute("href", `/analytics/explorer?recordKind=content&partnerRef=${P_MAIN}`);
    await expect(actions.getByRole("link", { name: "View Partner profile" })).toHaveAttribute("href", `/partners/${P_MAIN}`);
    // The Explorer link carries ?platform= ONLY when a platform is selected here.
    await page.goto(url(P_MAIN, "youtube"));
    await expect(page.locator(".head .actions").getByRole("link", { name: "Data Explorer" })).toHaveAttribute("href", `/analytics/explorer?platform=youtube&recordKind=content&partnerRef=${P_MAIN}`);
    // No Import CTA / upload anywhere.
    const main = page.locator("#main");
    await expect(main.locator("input[type='file']")).toHaveCount(0);
    await expect(main.locator("a[href^='/imports']")).toHaveCount(0);
    await expect(main.getByRole("button", { name: /import|upload|execute/i })).toHaveCount(0);
  });

  test("no restricted Partner profile field, raw ref, post URL or unsupported metric is rendered", async ({ page }) => {
    await page.goto(url(P_MAIN));
    await expect(page.locator(".ov-kpi")).toHaveCount(5);
    const text = await page.locator("#main").innerText();
    for (const secret of [`SECRET LEGAL ${P_MAIN}`, `secret-${P_MAIN}@restricted.test`, "+91 90000 00096", "RAW CAPTION", "RAW-URL", `${tag}-c-`, `${tag}-ch-`, ACC_IG1, BATCH]) expect(text, `page leaks ${secret}`).not.toContain(secret);
    // (The Instagram card's footnote honestly DISCLOSES that reach is not in the verified registry; there is no Reach KPI / series / value.)
    expect(text).not.toMatch(/\bshares\b\s*[:\d]|\bsaves\b\s*[:\d]|watch time\s*[:\d]|impressions\s*[:\d]|subscribers? (gained|growth)|follower growth|\bscore\b|\brating\b|weighted|composite/i);
    expect((await page.locator(".ov-kpi-label").allTextContents()).join(" ")).not.toMatch(/reach/i);
    expect((await page.locator(".ov-trend-label").allTextContents()).join(" ")).not.toMatch(/reach/i);
    // Agreement / target context is deliberately not part of this page.
    expect(text).not.toMatch(/agreement|target context/i);
    expect(await page.locator("#main a[href^='http']").count()).toBe(0);
  });

  // ---- Structure -----------------------------------------------------------------------------------

  test("reporting period label, 5 KPI slots in order with the platform split under each, Views not combined on All", async ({ page }) => {
    await page.goto(url(P_MAIN));
    await expect(page.locator(".ov-context")).toContainText("Reporting period: All available imported periods: 2097-01-01 – 2097-02-28");
    await expect(page.locator(".ov-context")).toContainText("Not a filter");

    expect(await page.locator(".ov-kpi-label").allTextContents()).toEqual(["Published content", "Views", "Engagement", "Likes", "Comments"]);
    const values = await page.locator(".ov-kpi-value").allTextContents();
    const hints = await page.locator(".ov-kpi small").allTextContents();
    expect(values).toHaveLength(5);
    for (const value of values) expect(value).toMatch(/^(Unavailable|By platform|\d[\d.]*[KM]?)$/);
    // Published content totals across platforms (3 IG + 2 YT); Views is the per-platform headline.
    expect(values[0]).toBe("5");
    expect(values[1]).toBe("By platform");
    for (const [index, hint] of hints.entries()) {
      expect(hint, `KPI ${index} split`).toContain("Instagram");
      expect(hint, `KPI ${index} split`).toContain("YouTube");
    }
    expect(hints[1]).toMatch(/not combined/);
    // Comments: IG 6,101 + 6,103 (one missing) / YT 7,101 + 7,102 -> coverage disclosed, never a fabricated 0.
    expect(hints[4]).toMatch(/3 of 5 records|4 of 5 records/);
  });

  test("a single-platform selection shows that platform's own Views total and only its split", async ({ page }) => {
    await page.goto(url(P_MAIN, "instagram"));
    const values = await page.locator(".ov-kpi-value").allTextContents();
    expect(values[1]).toMatch(/^\d[\d.]*[KM]$/); // Instagram views, summed on its own
    expect(values[0]).toBe("3");
    const hints = await page.locator(".ov-kpi small").allTextContents();
    for (const hint of hints) {
      expect(hint).toContain("Instagram");
      expect(hint).not.toContain("YouTube");
    }
  });

  test("Platform Performance: separate Instagram and YouTube cards, in order, with every trend value also present as text", async ({ page }) => {
    await page.goto(url(P_MAIN));
    expect(await page.locator(".ov-panel-head h2").allTextContents()).toEqual(["Instagram performance", "YouTube performance", "Partner Accounts", "Published Content", "Top Content", "Data Quality & Freshness"]);
    for (const title of ["Instagram performance", "YouTube performance"]) {
      const card = panel(page, title);
      await expect(card.locator(".ov-trend svg").first()).toBeVisible();
      await expect(card.locator("svg[role='img']").first()).toHaveAttribute("aria-label", /by reporting period/);
      const text = (await card.textContent()) ?? "";
      expect(text).toContain("2097-01-01 – 2097-01-31");
      expect(text).toContain("2097-02-01 – 2097-02-28");
      // No Reach series (the footnote only DISCLOSES that reach is not in the verified registry).
      expect((await card.locator(".ov-trend-label").allTextContents()).join(" ")).not.toMatch(/reach/i);
    }
    // Every listed period reads a real value or "Unavailable" (a gap) - never a fabricated 0. (Gap semantics themselves are
    // proven with real data in partner-view.emulator.test.ts.)
    expect((await panel(page, "Instagram performance").textContent()) ?? "").not.toMatch(/\d{4}-\d{2}-\d{2}: 0(\D|$)/);
  });

  test("an Instagram-only Partner shows YouTube as an explicit 'Unavailable — no source data' card (never hidden)", async ({ page }) => {
    await page.goto(url(P_IG_ONLY));
    await expect(panel(page, "Instagram performance")).toBeVisible();
    const yt = panel(page, "YouTube performance");
    await expect(yt).toBeVisible();
    await expect(yt).toContainText("Unavailable");
    await expect(yt).toContainText("no source data");
    await expect(yt.locator(".ov-trend")).toHaveCount(0);
    // The KPI split reads Unavailable for YouTube, never 0.
    const hints = await page.locator(".ov-kpi small").allTextContents();
    for (const hint of hints) expect(hint).toContain("YouTube Unavailable");
    // Views on All: still the per-platform headline (Instagram value + YouTube Unavailable).
    expect(await page.locator(".ov-kpi-value").nth(1).innerText()).toBe("By platform");
  });

  test("Partner Accounts: one distinct row per account (two Instagram accounts stay separate), latest snapshot each, no total", async ({ page }) => {
    await page.goto(url(P_MAIN));
    const table = panel(page, "Partner Accounts").locator("table");
    expect(await table.locator("thead th").allInnerTexts()).toEqual(["Platform", "Account", "Profile followers (snapshot)", "Reporting period", "Snapshot imported", "Records in window", "Source", "Data Explorer"]);
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(3);
    const ig1 = rows.filter({ hasText: ACC_LABEL[ACC_IG1] });
    const ig2 = rows.filter({ hasText: ACC_LABEL[ACC_IG2] });
    const yt = rows.filter({ hasText: ACC_LABEL[ACC_YT1] });
    await expect(ig1).toHaveCount(1);
    await expect(ig2).toHaveCount(1);
    await expect(yt).toHaveCount(1);
    await expect(ig1).toContainText("8,181,001"); // latest of its two snapshots (not the older 8,181,000)
    await expect(ig1).toContainText("latest of 2 snapshots");
    await expect(ig1).not.toContainText("8,181,000");
    await expect(ig1).toContainText("2097-02-01 – 2097-02-28");
    await expect(ig1).toContainText("Instagram");
    await expect(ig2).toContainText("1,818,181");
    await expect(yt).toContainText("9,191,919");
    await expect(yt).toContainText("YouTube");
    // Records in window: content + channel for that account.
    await expect(ig1).toContainText(/4\s*\(2 content · 2 channel\)/);
    // Provenance affordance.
    await expect(yt).toContainText(`${BATCH_FILENAME} · sheet Channels · row 3`);
    // 8,181,001 + 1,818,181 = 9,999,182; + 9,191,919 = 19,191,101 - no such total anywhere.
    const main = await page.locator("#main").innerText();
    for (const fake of ["9,999,182", "19,191,101", "9,191,919 + ", "total followers", "subscribers"]) expect(main.toLowerCase()).not.toContain(fake.toLowerCase());
    // Per-account Data Explorer link is real (server-honored filter): follow it.
    await expect(ig2.getByRole("link", { name: /records in Data Explorer/ })).toHaveAttribute("href", `/analytics/explorer?platform=instagram&recordKind=content&partnerAccountRef=${ACC_IG2}`);
  });

  test("Published Content: platform pills, Account, dates, source-reported metrics with a dash announced as Unavailable, provenance", async ({ page }) => {
    await page.goto(url(P_MAIN));
    const table = panel(page, "Published Content").locator("table");
    expect(await table.locator("thead th").allInnerTexts()).toEqual(["Platform", "Published", "Account", "Campaign", "Views", "Engagement", "Likes", "Comments", "Match", "Source"]);
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(5);
    const text = await table.innerText();
    for (const value of [...IG_VIEWS, ...YT_VIEWS]) expect(text, `value ${value}`).toContain(value);
    // Newest first across platforms: yt-1 (2098-06-02) before ig-1 (2098-06-01) before yt-2 (2098-05-02) ...
    const order = await rows.evaluateAll((trs) => trs.map((tr) => tr.textContent ?? ""));
    const idx = (needle: string) => order.findIndex((t) => t.includes(needle));
    expect(idx("7,272,101")).toBeLessThan(idx("6,161,101"));
    expect(idx("6,161,101")).toBeLessThan(idx("7,272,102"));
    expect(idx("7,272,102")).toBeLessThan(idx("6,161,102"));
    // ig-2: Engagement + Comments not reported -> dashes that announce themselves as Unavailable, never 0.
    const ig2 = rows.filter({ hasText: "6,161,102" });
    await expect(ig2.locator("[role='img'][aria-label='Unavailable']")).toHaveCount(2);
    for (const cell of await ig2.locator("td").allInnerTexts()) expect(cell.trim()).not.toBe("0");
    await expect(rows.first()).toContainText("YouTube");
    await expect(rows.first()).toContainText(`${BATCH_FILENAME} · sheet Posts · row 2`);
    await expect(rows.first()).toContainText("Matched");
    await expect(panel(page, "Published Content").getByRole("link", { name: "View all in Data Explorer" })).toHaveAttribute("href", `/analytics/explorer?recordKind=content&partnerRef=${P_MAIN}`);
    // Another Partner's records in the SAME region never appear.
    const main = await page.locator("#main").innerText();
    for (const leak of ["5,353,535", "4,646,464", "535,353", "5,454,545", "3,131,311", "2,424,242", NAME[P_OTHER], NAME[P_HIDDEN]]) expect(main, `leaks ${leak}`).not.toContain(leak);
  });

  test("Top Content: ONE explicit basis named in the note - Views (within each platform on All), Engagement fallback labelled, never blended", async ({ page }) => {
    await page.goto(url(P_MAIN));
    const top = panel(page, "Top Content");
    await expect(top.locator(".ov-panel-note")).toContainText("Ranked by Views, within each platform");
    await expect(top).toContainText("Instagram · top 5 by Views");
    await expect(top).toContainText("YouTube · top 5 by Views");
    const tables = top.locator("table");
    await expect(tables).toHaveCount(2);
    // Instagram group: 6,161,103 > 6,161,102 > 6,161,101; YouTube: 7,272,102 > 7,272,101.
    const igRanks = await tables.nth(0).locator("tbody tr").evaluateAll((trs) => trs.map((tr) => tr.textContent ?? ""));
    expect(igRanks.map((t) => (["6,161,103", "6,161,102", "6,161,101"].find((v) => t.includes(v)) ?? "?"))).toEqual(["6,161,103", "6,161,102", "6,161,101"]);
    const ytRanks = await tables.nth(1).locator("tbody tr").evaluateAll((trs) => trs.map((tr) => tr.textContent ?? ""));
    expect(ytRanks.map((t) => (["7,272,102", "7,272,101"].find((v) => t.includes(v)) ?? "?"))).toEqual(["7,272,102", "7,272,101"]);
    expect(await tables.nth(0).locator("thead th").first().innerText()).toBe("Rank");

    // Engagement-only Partner: the fallback is explicit.
    await page.goto(url(P_ENG));
    const engTop = panel(page, "Top Content");
    await expect(engTop.locator(".ov-panel-note")).toContainText("Ranked by Engagement (no Views reported)");
    const engRows = await engTop.locator("table").first().locator("tbody tr").evaluateAll((trs) => trs.map((tr) => tr.textContent ?? ""));
    expect(engRows[0]).toContain("8,181,822");
    expect(engRows[1]).toContain("8,181,811");
  });

  test("Data Quality & Freshness: linkage, coverage per metric, freshness and account coverage - absence is 'No source data', never zero", async ({ page }) => {
    await page.goto(url(P_MAIN));
    const quality = panel(page, "Data Quality & Freshness");
    for (const label of ["Content linkage", "Channel linkage", "Content account linkage", "Channel account linkage", "Views coverage", "Engagement coverage", "Likes coverage", "Comments coverage", "Profile followers coverage", "Content freshness", "Channel freshness", "Account coverage"]) await expect(quality).toContainText(label);
    await expect(quality).toContainText(/5 linked · 0 unlinked · 0 ambiguous, of 5 records/);
    await expect(quality).toContainText("Engagement missing on 2 of 5 content records");
    await expect(quality).toContainText("3 Partner Accounts with snapshots · 0 platform records not linked to an account");
    await expect(quality).toContainText("Latest record");
  });

  // ---- Platform switch -------------------------------------------------------------------------------

  test("the platform switch changes the URL AND the server-rendered rows (the other platform disappears); All is the bare path", async ({ page }) => {
    await page.goto(url(P_MAIN));
    const group = page.getByRole("group", { name: "Platform view" });
    await expect(group.getByRole("link")).toHaveText(["All", "Instagram", "YouTube"]);
    await expect(group.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
    await expect(group.getByRole("link", { name: "All" })).toHaveAttribute("href", `/analytics/partner/${P_MAIN}`);
    await expect(group.getByRole("link", { name: "Instagram" })).toHaveAttribute("href", `/analytics/partner/${P_MAIN}?platform=instagram`);
    await expect(group.getByRole("link", { name: "YouTube" })).toHaveAttribute("href", `/analytics/partner/${P_MAIN}?platform=youtube`);
    await expect(page.locator("#main")).toContainText("7,272,101");

    await group.getByRole("link", { name: "Instagram" }).click();
    await expect(page).toHaveURL(new RegExp(`/analytics/partner/${P_MAIN}\\?platform=instagram$`));
    await expect(page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "Instagram" })).toHaveAttribute("aria-current", "page");
    let text = await page.locator("#main").innerText();
    for (const value of IG_VIEWS) expect(text).toContain(value);
    for (const value of [...YT_VIEWS, "9,191,919"]) expect(text, `YouTube ${value} must disappear`).not.toContain(value);
    await expect(page.locator(".ov-panel-head h2").filter({ hasText: "YouTube performance" })).toHaveCount(0);
    await expect(panel(page, "Partner Accounts").locator("tbody tr")).toHaveCount(2);

    await page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "YouTube" }).click();
    await expect(page).toHaveURL(new RegExp(`/analytics/partner/${P_MAIN}\\?platform=youtube$`));
    text = await page.locator("#main").innerText();
    for (const value of YT_VIEWS) expect(text).toContain(value);
    for (const value of [...IG_VIEWS, "8,181,001", "1,818,181"]) expect(text, `Instagram ${value} must disappear`).not.toContain(value);
    await expect(panel(page, "Partner Accounts").locator("tbody tr")).toHaveCount(1);

    await page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "All" }).click();
    await expect(page).toHaveURL(new RegExp(`/analytics/partner/${P_MAIN}$`));
    await expect(page.locator("#main")).toContainText("6,161,101");
    await expect(page.locator("#main")).toContainText("7,272,101");
  });

  test("the platform param is normalized server-side: Instagram / ' YOUTUBE ' honored, garbage and repeated params show All", async ({ page }) => {
    await page.goto(`/analytics/partner/${P_MAIN}?platform=Instagram`);
    await expect(page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "Instagram" })).toHaveAttribute("aria-current", "page");
    await page.goto(`/analytics/partner/${P_MAIN}?platform=%20YOUTUBE%20`);
    await expect(page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "YouTube" })).toHaveAttribute("aria-current", "page");
    for (const q of ["platform=tiktok", "platform=", "platform=instagram&platform=youtube", "platform=%3Cscript%3E"]) {
      await page.goto(`/analytics/partner/${P_MAIN}?${q}`);
      await expect(page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "All" }), q).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#main")).toContainText("7,272,101");
    }
  });

  test("the switch is keyboard operable with visible focus", async ({ page }) => {
    await page.goto(url(P_MAIN));
    const group = page.getByRole("group", { name: "Platform view" });
    const instagram = group.getByRole("link", { name: "Instagram" });
    await group.getByRole("link", { name: "All" }).focus();
    await page.keyboard.press("Tab");
    await expect(instagram).toBeFocused();
    // Reached by keyboard -> :focus-visible with a real outline.
    const outline = await instagram.evaluate((el) => ({ visible: el.matches(":focus-visible"), style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
    expect(outline.visible).toBe(true);
    expect(outline.style).not.toBe("none");
    expect(parseFloat(outline.width)).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`\\?platform=instagram$`));
    await expect(page.locator("#main")).not.toContainText("7,272,101");
  });

  // ---- Access ------------------------------------------------------------------------------------------

  test("an unknown Partner shows the neutral Access denied page (no Partner, no data), tab bar kept", async ({ page }) => {
    await page.goto(url(`${tag}-does-not-exist`));
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.getByText("This Partner doesn't exist, or you don't have permission to view its analytics.")).toBeVisible();
    await expect(page.locator(".ov-kpi")).toHaveCount(0);
    await expect(page.locator(".tabs .tab")).toHaveCount(5);
    await expect(page.locator("h1")).toHaveText("Partner Analytics");
  });

  test("an out-of-scope Partner is INDISTINGUISHABLE from an unknown one for a scoped actor; Viewer is denied at the Analytics gate", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto(url(P_HIDDEN));
    await expect(page.getByText("Access denied")).toBeVisible();
    const hiddenPage = await page.locator("#main").innerText();
    await page.goto(url(`${tag}-does-not-exist`));
    const unknownPage = await page.locator("#main").innerText();
    expect(hiddenPage).toBe(unknownPage);
    expect(hiddenPage).not.toContain(NAME[P_HIDDEN]);
    expect(hiddenPage).not.toContain("2,424,242");
    // Even a Partner in the private region of admin's fixtures: no data, no name.
    await page.goto(url(P_MAIN));
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.locator(".ov-kpi")).toHaveCount(0);

    await signInAs(page, "viewer");
    await page.goto(url(P_MAIN));
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.getByText("You don't have permission to view Analytics data.")).toBeVisible();
    await expect(page.locator(".ov-kpi")).toHaveCount(0);
    await expect(page.locator(".tabs .tab")).toHaveCount(5);
  });

  test("Manager and Head are scoped too: neither can open a Partner outside its scope, and neither gets an error", async ({ page }) => {
    for (const who of ["manager", "head"]) {
      await signInAs(page, who);
      await page.goto(url(P_MAIN));
      await expect(page.getByText("Access denied"), who).toBeVisible();
      await expect(page.locator(".ov-kpi")).toHaveCount(0);
    }
  });

  // ---- Contextual links ---------------------------------------------------------------------------------------

  for (const platform of ["instagram", "youtube"] as const) {
    test(`${platform} page: the Partner cell links to the Partner page with the platform preselected`, async ({ page }) => {
      await page.goto(`/analytics/${platform}`);
      const cell = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Published Content", exact: true }) }).locator("tbody tr", { hasText: platform === "instagram" ? "6,161,101" : "7,272,101" });
      const link = cell.getByRole("link", { name: NAME[P_MAIN] });
      await expect(link).toHaveAttribute("href", `/analytics/partner/${P_MAIN}?platform=${platform}`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/analytics/partner/${P_MAIN}\\?platform=${platform}$`));
      await expect(page.locator("h1")).toHaveText(`${NAME[P_MAIN]} · Analytics`);
      await expect(page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: platform === "instagram" ? "Instagram" : "YouTube" })).toHaveAttribute("aria-current", "page");
    });

    test(`${platform} page: a Partner Accounts row's Partner label links the same way`, async ({ page }) => {
      await page.goto(`/analytics/${platform}`);
      const row = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Partner Accounts", exact: true }) }).locator("tbody tr", { hasText: platform === "instagram" ? "8,181,001" : "9,191,919" });
      await expect(row.getByRole("link", { name: NAME[P_MAIN] })).toHaveAttribute("href", `/analytics/partner/${P_MAIN}?platform=${platform}`);
    });
  }

  test("Data Explorer: the Partner / Partner Account deep links filter server-side and a channel row's Partner label opens Partner Analytics", async ({ page }) => {
    await page.goto(`/analytics/explorer?recordKind=channel&partnerRef=${P_MAIN}`);
    const rows = page.locator(".tablewrap tbody tr");
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(4); // ig1 old + new, ig2, yt1 - never the other same-region Partner's snapshot
    const text = await page.locator(".tablewrap").innerText();
    expect(text).not.toContain(NAME[P_OTHER]);
    // The active filter is reflected in the existing advanced-filter inputs.
    await expect(page.getByLabel("Partner ref")).toHaveValue(P_MAIN);
    const link = rows.first().getByRole("link", { name: NAME[P_MAIN] });
    await expect(link).toHaveAttribute("href", `/analytics/partner/${P_MAIN}`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/analytics/partner/${P_MAIN}$`));
    await expect(page.locator("h1")).toHaveText(`${NAME[P_MAIN]} · Analytics`);
  });

  test("Data Explorer: partnerAccountRef narrows to one account; an unknown / invalid ref yields no rows and no leak", async ({ page }) => {
    await page.goto(`/analytics/explorer?recordKind=channel&partnerAccountRef=${ACC_IG2}`);
    await expect(page.locator(".tablewrap tbody tr")).toHaveCount(1);
    await expect(page.getByLabel("Partner Account ref")).toHaveValue(ACC_IG2);
    await page.goto(`/analytics/explorer?recordKind=content&partnerAccountRef=${tag}-nope`);
    await expect(page.getByText("No matching records")).toBeVisible();
    // Repeated / blank params are ignored (no filter applied), never passed through.
    await page.goto(`/analytics/explorer?recordKind=channel&partnerRef=&partnerRef=x`);
    await expect(page.locator(".tablewrap tbody tr").first()).toBeVisible();
    // The per-account link on the Partner page lands on that account's records.
    await page.goto(url(P_MAIN));
    await panel(page, "Partner Accounts").locator("tbody tr", { hasText: ACC_LABEL[ACC_IG2] }).getByRole("link", { name: /records in Data Explorer/ }).click();
    await expect(page).toHaveURL(new RegExp(`partnerAccountRef=${ACC_IG2}`));
    await expect(page.locator(".tablewrap tbody tr")).toHaveCount(1);
  });

  // ---- Responsive ---------------------------------------------------------------------------------------------

  const VIEWPORTS = [
    { name: "1440", width: 1440, height: 900 },
    { name: "1200", width: 1200, height: 900 },
    { name: "1050", width: 1050, height: 900 },
    { name: "760", width: 760, height: 900 },
    { name: "390", width: 390, height: 844 },
    { name: "375", width: 375, height: 812 },
  ];
  for (const viewport of VIEWPORTS) {
    for (const platform of [undefined, "instagram"]) {
      test(`no horizontal page overflow at ${viewport.name}: ${platform ?? "all"}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(url(P_MAIN, platform));
        await expect(page.locator("h1")).toBeVisible();
        await expect(page.locator(".ov-panel table tbody tr").first()).toBeVisible();
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        expect(scrollWidth, `${platform ?? "all"} at ${viewport.name} overflows the page horizontally`).toBeLessThanOrEqual(innerWidth);
        const wraps = await page.evaluate(() => [...document.querySelectorAll(".ov-panel .tablewrap")].map((wrap) => getComputedStyle(wrap).overflowX));
        expect(wraps.length).toBeGreaterThan(0);
        for (const overflowX of wraps) expect(["auto", "scroll"]).toContain(overflowX);
        // The platform switch stays usable (visible, on-screen, tappable) at every width.
        for (const label of ["All", "Instagram", "YouTube"]) {
          const link = page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: label });
          await expect(link).toBeVisible();
          const box = (await link.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        }
      });
    }
  }

  test("at mobile width the switch works by touch-sized link and the 5-tab bar stays reachable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(url(P_MAIN));
    await page.getByRole("group", { name: "Platform view" }).getByRole("link", { name: "YouTube" }).click();
    await expect(page).toHaveURL(/\?platform=youtube$/);
    await expect(page.locator(".tabs .tab")).toHaveCount(5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
