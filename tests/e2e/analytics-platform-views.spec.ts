import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// Step 12D - the separate Instagram / YouTube Analytics views, exercised
// through the real UI on real emulator data (no fixtures injected into the
// page). Data arrives the way production data does: through the Import Center
// API, as the pre-authed Super Admin (GLOBAL scope). Every imported value is
// deliberately distinctive (7-digit numbers no seeded record uses), every
// content row carries a far-future (2098/2099) posted date / reporting period so
// it sorts first / is the latest, and every workbook has a deterministic
// filename + content, so a re-run against the same emulator is an idempotent
// replay rather than a duplicate. Values are asserted through the
// rendered rows/cells - never through totals that other specs' data could move.
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;
const STORAGE_STATE = "tests/e2e/.auth/user.json";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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

function workbookBase64(rows: unknown[][]): string {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Export");
  return (XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64");
}

const JAN = { start: "2098-01-01", end: "2098-01-31" };
const FEB = { start: "2098-02-01", end: "2098-02-28" };

// Distinctive values. IG: 4,24x,xxx ; YT: 5,15x,xxx ; followers IG 8,765,432 / 1,111,111 ; YT 7,654,321.
const IG_VALUES = ["4,242,001", "424,201", "42,421", "4,242,101", "424,211"];
const YT_VALUES = ["5,151,001", "515,101", "51,513", "5,151,101", "515,111"];

async function importWorkbook(request: APIRequestContext, body: Record<string, unknown>) {
  const response = await request.post("/api/imports/execute", { data: { module: "analytics", mimeType: XLSX_MIME, ...body } });
  expect(response.ok(), `import ${String(body.filename)} failed: ${response.status()}`).toBeTruthy();
}

test.describe.configure({ mode: "serial" });

test.describe("Instagram and YouTube Analytics views", () => {
  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL, storageState: STORAGE_STATE });
    // ---- Instagram content: two reporting periods (so a real trend exists), one row missing Engagement ----
    await importWorkbook(request, {
      targetKind: "campaign_content",
      filename: "p12d-e2e-ig-jan.xlsx",
      reportingPeriod: JAN,
      fileBase64: workbookBase64([
        ["Post URL", "Post Date", "Views", "Likes", "Comments", "Engagement"],
        ["https://instagram.com/p/p12d-e2e-ig-1", "2099-03-01T10:00:00.000Z", 4242001, 424201, 4242, 42421],
        ["https://instagram.com/p/p12d-e2e-ig-2", "2099-02-01T10:00:00.000Z", 4242101, 424211, 4243, null], // Engagement NOT reported
      ]),
    });
    await importWorkbook(request, {
      targetKind: "campaign_content",
      filename: "p12d-e2e-ig-feb.xlsx",
      reportingPeriod: FEB,
      fileBase64: workbookBase64([
        ["Post URL", "Post Date", "Views", "Likes", "Comments", "Engagement"],
        ["https://instagram.com/p/p12d-e2e-ig-3", "2099-01-15T10:00:00.000Z", 4242301, 424231, 4244, 42423],
      ]),
    });
    // ---- YouTube content (Video URL headers -> the YouTube adapter) ----
    await importWorkbook(request, {
      targetKind: "campaign_content",
      filename: "p12d-e2e-yt-jan.xlsx",
      reportingPeriod: JAN,
      fileBase64: workbookBase64([
        ["Video URL", "Publish Date", "Views", "Likes", "Comments", "Engagement"],
        ["https://youtube.com/watch?v=p12d-e2e-yt-1", "2099-03-02T10:00:00.000Z", 5151001, 515101, 5152, 51513],
        ["https://youtube.com/watch?v=p12d-e2e-yt-2", "2099-02-02T10:00:00.000Z", 5151101, 515111, 5153, null],
      ]),
    });
    await importWorkbook(request, {
      targetKind: "campaign_content",
      filename: "p12d-e2e-yt-feb.xlsx",
      reportingPeriod: FEB,
      fileBase64: workbookBase64([
        ["Video URL", "Publish Date", "Views", "Likes", "Comments", "Engagement"],
        ["https://youtube.com/watch?v=p12d-e2e-yt-3", "2099-01-16T10:00:00.000Z", 5151301, 515131, 5154, 51515],
      ]),
    });
    // ---- Channel snapshots matched to the SEEDED Creator House Partner Accounts ----
    await importWorkbook(request, {
      targetKind: "channel_account",
      channelPlatform: "instagram",
      filename: "p12d-e2e-ig-channels.xlsx",
      reportingPeriod: JAN,
      fileBase64: workbookBase64([
        ["Handle", "Followers"],
        ["creatorhouse", 8765432],
        ["creatorhouse.reels", 1111111],
      ]),
    });
    await importWorkbook(request, {
      targetKind: "channel_account",
      channelPlatform: "youtube",
      filename: "p12d-e2e-yt-channels.xlsx",
      reportingPeriod: JAN,
      fileBase64: workbookBase64([
        ["Channel ID", "Followers"],
        ["UCCreatorHouseSeedChannel", 7654321],
      ]),
    });
    await request.dispose();
  });

  // ---- Navigation --------------------------------------------------------------------------------

  test("the shared 6-item Analytics tab bar appears on all six pages with the current tab marked", async ({ page }) => {
    const pages = [
      { href: "/analytics", label: "Overview" },
      { href: "/analytics/instagram", label: "Instagram" },
      { href: "/analytics/youtube", label: "YouTube" },
      { href: "/analytics/partners", label: "Partners" },
      { href: "/analytics/explorer", label: "Data Explorer" },
      { href: "/analytics/import-history", label: "Import History" },
    ];
    for (const current of pages) {
      await page.goto(current.href);
      const tabs = page.locator(".tabs .tab");
      await expect(tabs).toHaveText(pages.map((p) => p.label));
      await expect(tabs).toHaveCount(6);
      for (const [index, p] of pages.entries()) {
        await expect(tabs.nth(index)).toHaveAttribute("href", p.href);
        if (p.href === current.href) await expect(tabs.nth(index)).toHaveAttribute("aria-current", "page");
        else await expect(tabs.nth(index)).not.toHaveAttribute("aria-current", "page");
      }
      await expect(page.locator(".tabs .tab.active")).toHaveText(current.label);
    }
    // No second Analytics sidebar item.
    await expect(page.locator("nav[aria-label='Global navigation'] a[href^='/analytics']")).toHaveCount(1);
  });

  // ---- Structure ---------------------------------------------------------------------------------

  for (const platform of [
    { id: "instagram", title: "Instagram Analytics", label: "Instagram" },
    { id: "youtube", title: "YouTube Analytics", label: "YouTube" },
  ] as const) {
    test(`${platform.title}: header, 5 KPI slots in order, sections in order, no Reach KPI`, async ({ page }) => {
      await page.goto(`/analytics/${platform.id}`);
      await expect(page.locator("h1")).toHaveText(platform.title);
      await expect(page.locator(".ov-page")).toBeVisible();

      // Header links: platform-filtered Data Explorer + Import History; no Import CTA.
      await expect(page.getByRole("link", { name: "Open in Data Explorer" })).toHaveAttribute("href", `/analytics/explorer?platform=${platform.id}&recordKind=content`);
      await expect(page.locator(".head .actions").getByRole("link", { name: "Import History" })).toHaveAttribute("href", "/analytics/import-history");

      const kpiLabels = await page.locator(".ov-kpi-label").allTextContents();
      expect(kpiLabels).toEqual(["Published content", "Views", "Engagement", "Likes", "Comments"]);
      expect(kpiLabels.join(" ")).not.toMatch(/reach/i);
      // Each KPI slot shows either a real number or the neutral Unavailable state - never a fabricated 0 for missing.
      for (const value of await page.locator(".ov-kpi-value").allTextContents()) expect(value).toMatch(/^(Unavailable|\d[\d.]*[KM]?)$/);

      const sections = await page.locator(".ov-panel-head h2").allTextContents();
      expect(sections).toEqual(["Native Metric Trend", "Published Content", "Partner Accounts", "Source Quality"]);

      // No Reach / Shares / Saves / Watch Time / Impressions / subscriber figure anywhere on the page.
      const text = await page.locator("#main").innerText();
      expect(text).not.toMatch(/\bshares\b\s*[:\d]|\bsaves\b\s*[:\d]|watch time\s*[:\d]|impressions\s*[:\d]|subscribers? (gained|growth)|follower growth/i);
    });
  }

  // ---- Data isolation ----------------------------------------------------------------------------

  test("Instagram view shows only Instagram records (mixed-platform data never leaks); a missing metric reads as a dash, never 0", async ({ page }) => {
    await page.goto("/analytics/instagram");
    const table = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Published Content" }) }).locator("table");
    await expect(table).toBeVisible();
    const rows = table.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    const tableText = await table.innerText();
    for (const value of IG_VALUES) expect(tableText, `Instagram value ${value}`).toContain(value);
    for (const value of ["5,151,001", "515,101", "51,513", "5,151,101"]) expect(await page.locator("#main").innerText(), `YouTube value ${value} leaked`).not.toContain(value);

    // ig-2 (Post Date 2099-02-01, reported Engagement missing) : Engagement cell is a dash, Views/Likes real.
    const row = rows.filter({ hasText: "4,242,101" });
    await expect(row).toHaveCount(1);
    const cells = await row.locator("td").allInnerTexts();
    const header = await table.locator("thead th").allInnerTexts();
    const engagement = cells[header.indexOf("Engagement")]!;
    expect(engagement.trim()).toBe("—");
    expect(cells[header.indexOf("Views")]).toBe("4,242,101");
    for (const cell of cells) expect(cell.trim()).not.toBe("0");
    // Newest posted first: ig-1 (2099-03-01) before ig-2 (2099-02-01) before ig-3 (2099-01-15).
    const order = await rows.evaluateAll((trs) => trs.map((tr) => tr.textContent ?? ""));
    const idx = (needle: string) => order.findIndex((t) => t.includes(needle));
    expect(idx("4,242,001")).toBeGreaterThanOrEqual(0);
    expect(idx("4,242,001")).toBeLessThan(idx("4,242,101"));
    expect(idx("4,242,101")).toBeLessThan(idx("4,242,301"));
  });

  test("YouTube view shows only YouTube records", async ({ page }) => {
    await page.goto("/analytics/youtube");
    const table = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Published Content" }) }).locator("table");
    await expect(table.locator("tbody tr").first()).toBeVisible();
    const tableText = await table.innerText();
    for (const value of YT_VALUES) expect(tableText, `YouTube value ${value}`).toContain(value);
    const mainText = await page.locator("#main").innerText();
    for (const value of ["4,242,001", "424,201", "42,421", "4,242,101", "8,765,432", "1,111,111"]) expect(mainText, `Instagram value ${value} leaked`).not.toContain(value);
  });

  test("Native Metric Trend plots real reporting periods per metric, without inventing a Reach series", async ({ page }) => {
    await page.goto("/analytics/instagram");
    const panel = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Native Metric Trend" }) });
    await expect(panel.locator(".ov-trend svg").first()).toBeVisible();
    const labels = await panel.locator(".ov-trend-label").allTextContents();
    expect(labels.map((l) => l.trim())).toEqual(expect.arrayContaining(["Views", "Likes", "Comments"]));
    expect(labels.join(" ")).not.toMatch(/reach/i);
    // Real period axis (the latest imported period is 2098-02), not TrendGrid's hard-coded demo months; every
    // period is also listed (screen-reader list) with a gap reading Unavailable, never 0.
    expect(await panel.locator(".ov-axis").first().innerText()).toContain("2098-02-01 – 2098-02-28");
    const listed = (await panel.textContent()) ?? "";
    expect(listed).toContain("2098-01-01 – 2098-01-31");
    expect(listed).toContain("2098-02-01 – 2098-02-28");
    await expect(panel).not.toContainText("vs Jul");
    await expect(panel.locator("svg[role='img']").first()).toHaveAttribute("aria-label", /by reporting period/);
  });

  test("Partner Accounts: one latest snapshot per account, profile followers - never a summed total or subscriber relabel", async ({ page }) => {
    await page.goto("/analytics/instagram");
    const table = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Partner Accounts" }) }).locator("table");
    await expect(table.locator("tbody tr").first()).toBeVisible();
    const headers = await table.locator("thead th").allInnerTexts();
    expect(headers).toEqual(["Partner", "Account", "Profile followers (snapshot)", "Reporting period", "Snapshot imported", "Source"]);
    const text = await table.innerText();
    expect(text).toContain("8,765,432");
    expect(text).toContain("1,111,111");
    expect(text).toContain("2098-01-01 – 2098-01-31");
    // 8,765,432 + 1,111,111 = 9,876,543 - no such platform total anywhere on the page.
    const main = await page.locator("#main").innerText();
    expect(main).not.toContain("9,876,543");
    expect(main).not.toContain("9.9M");
    expect(main).not.toMatch(/total followers|subscribers/i);
    // YouTube's channel snapshot never appears on the Instagram view.
    expect(main).not.toContain("7,654,321");

    await page.goto("/analytics/youtube");
    const ytTable = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Partner Accounts" }) }).locator("table");
    await expect(ytTable.locator("tbody tr").first()).toBeVisible();
    const ytText = await ytTable.innerText();
    expect(ytText).toContain("7,654,321");
    expect(await ytTable.locator("thead th").allInnerTexts()).toContain("Profile followers (snapshot)");
    const ytMain = await page.locator("#main").innerText();
    expect(ytMain).not.toContain("8,765,432");
    expect(ytMain).not.toMatch(/subscribers? (gained|growth)|total subscribers/i);
  });

  test("Source Quality lists linked / unlinked / ambiguous and per-metric coverage, with neutral wording", async ({ page }) => {
    await page.goto("/analytics/instagram");
    const panel = page.locator(".ov-panel", { has: page.getByRole("heading", { name: "Source Quality" }) });
    await expect(panel).toContainText("Content linkage");
    await expect(panel).toContainText("Channel linkage");
    await expect(panel).toContainText(/linked · \d+ unlinked · \d+ ambiguous/);
    await expect(panel).toContainText("Engagement missing on"); // ig-2 (and seeded records) lack Engagement
    await expect(panel).toContainText("Content freshness");
    await expect(panel).toContainText("Channel freshness");
  });

  // ---- Data Explorer integration --------------------------------------------------------------------

  for (const platform of [
    { id: "instagram", other: "Youtube", label: "Instagram" },
    { id: "youtube", other: "Instagram", label: "Youtube" },
  ] as const) {
    test(`${platform.id} view -> Data Explorer lands filtered, with the platform select preselected on first render`, async ({ page }) => {
      await page.goto(`/analytics/${platform.id}`);
      await page.getByRole("link", { name: "Open in Data Explorer" }).click();
      await expect(page).toHaveURL(new RegExp(`/analytics/explorer\\?platform=${platform.id}&recordKind=content$`));
      await expect(page.getByLabel("Filter platform")).toHaveValue(platform.id);
      const rows = page.locator(".tablewrap table tbody tr");
      await expect(rows.first()).toBeVisible();
      const texts = await rows.allInnerTexts();
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text).toContain(platform.label);
        expect(text).not.toContain(platform.other);
      }
    });
  }

  test("the Explorer normalizes ?platform= (case/whitespace) and neutralizes garbage", async ({ page }) => {
    await page.goto("/analytics/explorer?platform=YOUTUBE");
    await expect(page.getByLabel("Filter platform")).toHaveValue("youtube");
    const texts = await page.locator(".tablewrap table tbody tr").allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).not.toContain("Instagram");

    await page.goto("/analytics/explorer?platform=%20Instagram%20");
    await expect(page.getByLabel("Filter platform")).toHaveValue("instagram");

    await page.goto("/analytics/explorer?platform=definitely-not-a-platform");
    await expect(page.getByLabel("Filter platform")).toHaveValue("all");
  });

  test("the 'View all' and channel links carry the platform filter; Import History link works", async ({ page }) => {
    await page.goto("/analytics/instagram");
    await expect(page.getByRole("link", { name: "View all in Data Explorer" })).toHaveAttribute("href", "/analytics/explorer?platform=instagram&recordKind=content");
    await expect(page.getByRole("link", { name: "View channel records in Data Explorer" })).toHaveAttribute("href", "/analytics/explorer?platform=instagram&recordKind=channel");
    await page.locator(".head .actions").getByRole("link", { name: "Import History" }).click();
    await expect(page).toHaveURL(/\/analytics\/import-history$/);
  });

  // ---- No import surface ---------------------------------------------------------------------------

  test("no upload / execute / Import CTA on the platform pages - not even for an actor who can import", async ({ page }) => {
    for (const who of ["admin", "analyst"]) {
      await signInAs(page, who);
      for (const path of ["/analytics/instagram", "/analytics/youtube"]) {
        await page.goto(path);
        await expect(page.locator("h1")).toBeVisible();
        // Scoped to the page content: the global sidebar legitimately has its own Import Center entry.
        const content = page.locator("#main");
        await expect(content.locator("input[type='file']")).toHaveCount(0);
        await expect(content.locator("a[href^='/imports']")).toHaveCount(0);
        await expect(content.getByRole("link", { name: /import data/i })).toHaveCount(0);
        await expect(content.getByRole("button", { name: /import|upload|execute/i })).toHaveCount(0);
      }
    }
  });

  // ---- Access --------------------------------------------------------------------------------------

  test("Viewer sees the inline Access denied state on both platform pages (tab bar kept, no data)", async ({ page }) => {
    await signInAs(page, "viewer");
    for (const path of ["/analytics/instagram", "/analytics/youtube"]) {
      await page.goto(path);
      await expect(page.getByText("Access denied")).toBeVisible();
      await expect(page.locator(".ov-kpi")).toHaveCount(0);
      await expect(page.locator(".tabs .tab")).toHaveCount(6);
    }
  });

  test("Analyst, Manager and Head can read the platform views (same Analytics read access as the Overview/Explorer)", async ({ page }) => {
    for (const who of ["analyst", "manager", "head"]) {
      await signInAs(page, who);
      for (const path of ["/analytics/instagram", "/analytics/youtube"]) {
        await page.goto(path);
        await expect(page.locator(".ov-kpi")).toHaveCount(5);
        await expect(page.getByText("Access denied")).toHaveCount(0);
      }
    }
  });

  // ---- Responsive ----------------------------------------------------------------------------------

  const VIEWPORTS = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "1200", width: 1200, height: 900 },
    { name: "1050", width: 1050, height: 900 },
    { name: "760", width: 760, height: 900 },
    { name: "390", width: 390, height: 844 },
    { name: "375", width: 375, height: 812 },
  ];
  for (const viewport of VIEWPORTS) {
    for (const path of ["/analytics/instagram", "/analytics/youtube"]) {
      test(`no horizontal page overflow at ${viewport.name}: ${path}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(path);
        await expect(page.locator("h1")).toBeVisible();
        await expect(page.locator(".ov-panel table tbody tr").first()).toBeVisible();
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        expect(scrollWidth, `${path} at ${viewport.name} overflows the page horizontally`).toBeLessThanOrEqual(innerWidth);
        // Tables scroll inside their own container, never the page.
        const tableOverflow = await page.evaluate(() =>
          [...document.querySelectorAll(".ov-panel .tablewrap")].map((wrap) => {
            const style = getComputedStyle(wrap);
            return { overflowX: style.overflowX, wrapWidth: wrap.clientWidth };
          }),
        );
        for (const t of tableOverflow) expect(["auto", "scroll"]).toContain(t.overflowX);
      });
    }
  }

  for (const width of [390, 375]) {
    test(`the six-tab bar stays usable at ${width}px: every tab focusable and reachable, the active tab visible`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      const hrefs = ["/analytics", "/analytics/instagram", "/analytics/youtube", "/analytics/partners", "/analytics/explorer", "/analytics/import-history"];
      for (const current of hrefs) {
        await page.goto(current);
        const tabs = page.locator(".tabs .tab");
        await expect(tabs).toHaveCount(6);
        // The tab bar scrolls inside its own container - the page itself never overflows. (Explorer / Import
        // History are pre-existing accepted pages whose own tables' visually-hidden header text widens
        // documentElement - not this step's scope - so for those two the existing body-width convention
        // from analytics.spec.ts is used instead.)
        const platformOrOverview = ["/analytics", "/analytics/instagram", "/analytics/youtube", "/analytics/partners"].includes(current);
        const pageOverflow = await page.evaluate((useDocument) => (useDocument ? document.documentElement.scrollWidth : document.body.scrollWidth) - window.innerWidth, platformOrOverview);
        expect(pageOverflow, `${current} at ${width}`).toBeLessThanOrEqual(0);
        for (let i = 0; i < 6; i++) {
          const tab = tabs.nth(i);
          await tab.scrollIntoViewIfNeeded();
          await tab.focus();
          await expect(tab).toBeFocused();
          const box = (await tab.boundingBox())!;
          expect(box.x, `tab ${i} left edge on-screen`).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, `tab ${i} right edge on-screen`).toBeLessThanOrEqual(width);
        }
        await tabs.filter({ hasText: /^Import History$/ }).scrollIntoViewIfNeeded();
        await expect(page.locator(".tabs .tab.active")).toBeVisible();
      }
      // ...and tapping the last tab from a platform page navigates.
      await page.goto("/analytics/youtube");
      await page.locator(".tabs .tab", { hasText: "Import History" }).click();
      await expect(page).toHaveURL(/\/analytics\/import-history$/);
      await page.locator(".tabs .tab", { hasText: "Instagram" }).click();
      await expect(page).toHaveURL(/\/analytics\/instagram$/);
    });
  }
});
