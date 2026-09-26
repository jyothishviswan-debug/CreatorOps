import { expect as baseExpect, test, type Page } from "@playwright/test";

import { collectBrowserErrors, noDocumentOverflow, signInAs, VIEWPORTS, waitForHydration } from "./helpers/finance-agreements-fixtures";

// Export Center e2e: the full governed journey through a real browser against the real Firestore/
// Auth/Storage emulators (run via a private-port Playwright config - see the stage's own execution
// constraints; the tracked playwright.config.ts is never modified). Covers: open Export Center,
// choose an authorized target, choose a supported format, select allowed columns, create an export
// job, observe job history/lifecycle, complete generation, download the artifact, verify unauthorized
// target/column attempts fail server-side even when driven from the real browser, verify a totally
// unauthorized actor is denied both the page and the artifact route directly, and six-width
// responsive behavior for /exports and the synchronized /foundation section.
//
// Only Super Admin (admin@creatorops.com) genuinely holds real Export Center access among the five
// fixed seeded identities - Analyst's own per-user override explicitly denies it (see
// src/server/authz/seed-access-data.ts's own USER_OVERRIDES comment), and Viewer/Manager/Head never
// hold the "exports" feature at all. Cross-actor job/artifact scope denial (two DIFFERENT authorized
// actors, each seeing only their own jobs/artifacts) is proven at the emulator level instead - see
// src/server/exports/exports.emulator.test.ts - since no two of the five fixed identities can both
// hold real Export Center access at once.

const expect = baseExpect.configure({ timeout: 20_000 });

async function expectNoOverflow(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await noDocumentOverflow(page);
  expect(scrollWidth, `${label}: document scrolls horizontally (${scrollWidth} > ${innerWidth})`).toBeLessThanOrEqual(innerWidth);
}

test.describe.configure({ mode: "serial" });

test.describe("Governed journey", () => {
  test("1: open Export Center, see the 3-target catalog", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/exports");
    await expect(page.getByRole("heading", { level: 1, name: "Export Center" })).toBeVisible();
    await expect(page.getByTestId("export-target-grid")).toBeVisible();
    for (const targetId of ["partners", "campaigns", "assignments"]) {
      await expect(page.locator(`[data-testid="export-target-card"][data-target-id="${targetId}"]`)).toBeVisible();
    }
    expect(errors.errors).toEqual([]);
  });

  test("2: choose Partners, keep default columns, create a CSV export, see it COMPLETED in job history, and download real contents", async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await signInAs(page, "admin");
    await page.goto("/exports");
    await waitForHydration(page, '[data-testid="select-export-target"]');

    await page.locator('[data-testid="export-target-card"][data-target-id="partners"]').getByTestId("select-export-target").click();
    await expect(page.getByTestId("export-configure-panel")).toBeVisible();
    await expect(page.getByTestId("export-format-select")).toHaveValue("csv");

    const createResponse = page.waitForResponse((r) => r.url().includes("/api/exports/jobs") && r.request().method() === "POST");
    await page.getByTestId("create-export-button").click();
    const response = await createResponse;
    expect(response.status()).toBe(201);
    const jobDto = (await response.json()) as { jobRef: string; status: string; format: string };
    expect(jobDto.status).toBe("COMPLETED");

    await expect(page.getByTestId("export-create-success")).toBeVisible();
    const row = page.locator(`[data-testid="export-job-row"][data-job-ref="${jobDto.jobRef}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("COMPLETED");
    await expect(row).toContainText("CSV");

    const downloadLink = row.getByTestId("download-export-artifact");
    await expect(downloadLink).toBeVisible();
    const href = await downloadLink.getAttribute("href");
    expect(href).toBe(`/api/exports/jobs/${jobDto.jobRef}/artifact`);

    // Fetched via the SAME authenticated browser context's own cookies (page.request shares the
    // page's cookie jar) rather than clicking the anchor - clicking triggers a real browser download/
    // navigation that Playwright cannot read the body of afterward. This still proves the real,
    // cookie-authenticated HTTP round trip end to end.
    const downloadResponse = await page.request.get(href!);
    expect(downloadResponse.status()).toBe(200);
    expect(downloadResponse.headers()["content-type"]).toContain("text/csv");
    const body = await downloadResponse.text();
    expect(body).toContain("Partner ref");
    expect(errors.errors).toEqual([]);
  });

  test("3: choose Assignments, switch to XLSX, deselect a column, create, and see the requested column count reflected", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/exports");
    await waitForHydration(page, '[data-testid="select-export-target"]');

    await page.locator('[data-testid="export-target-card"][data-target-id="assignments"]').getByTestId("select-export-target").click();
    await expect(page.getByTestId("export-configure-panel")).toBeVisible();
    await page.getByTestId("export-format-select").selectOption("xlsx");
    await page.getByTestId("export-column-ownerDisplayName").uncheck();

    const createResponse = page.waitForResponse((r) => r.url().includes("/api/exports/jobs") && r.request().method() === "POST");
    await page.getByTestId("create-export-button").click();
    const response = await createResponse;
    const jobDto = (await response.json()) as { jobRef: string; status: string; requestedColumns: string[] };
    expect(jobDto.status).toBe("COMPLETED");
    expect(jobDto.requestedColumns).not.toContain("ownerDisplayName");

    const row = page.locator(`[data-testid="export-job-row"][data-job-ref="${jobDto.jobRef}"]`);
    await expect(row).toContainText("XLSX");
  });

  test("4: an unknown column id sent directly to the API is rejected server-side, even from a real authenticated browser session", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/exports");
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/exports/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: "partners", format: "csv", columns: ["displayName", "panNumber"] }),
      });
      return res.status;
    });
    expect(status).toBe(400);
  });

  test("5: an unauthorized target id is rejected server-side", async ({ page }) => {
    await signInAs(page, "admin");
    await page.goto("/exports");
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/exports/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: "vendors", format: "csv" }),
      });
      return res.status;
    });
    expect(status).toBe(400);
  });
});

test.describe("Denied actors", () => {
  // The proxy-level Feature Access gate (src/proxy.ts, keyed off features.ts's ROUTE_FEATURE_MAP
  // "/exports" -> "exports" entry) intercepts an unauthorized request to /exports BEFORE the page
  // component itself ever renders - the same shared generic "ACCESS DENIED" interstitial every other
  // feature-gated module uses (see tests/e2e/authorization.spec.ts's own identical assertion). The
  // page component's OWN "You do not have access to Export Center" branch is an intentional,
  // unreachable-in-practice defense-in-depth fallback (both layers call the exact same
  // canAccessFeature check) - mirroring src/app/reports/page.tsx's identical shape.
  test("6: Viewer is denied at the proxy Feature Access gate, never reaching the catalog or job history", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto("/exports");
    await expect(page.locator("h1")).toHaveText("You don’t have access to this area");
    await expect(page.getByText(/Your role doesn.t include access to Export Center\./)).toBeVisible();
    await expect(page.getByTestId("export-target-grid")).toHaveCount(0);
    await expect(page.getByTestId("export-job-history")).toHaveCount(0);
  });

  test("7: Manager and Head - neither holds the exports feature - are also denied the page", async ({ page }) => {
    for (const role of ["manager", "head"] as const) {
      await signInAs(page, role);
      await page.goto("/exports");
      await expect(page.locator("h1")).toHaveText("You don’t have access to this area");
    }
  });

  test("8: Analyst - role baseline grants exports, but this identity's own per-user override denies it - is denied too", async ({ page }) => {
    await signInAs(page, "analyst");
    await page.goto("/exports");
    await expect(page.locator("h1")).toHaveText("You don’t have access to this area");
  });

  test("9: a totally unauthorized actor hitting the artifact download route directly gets a closed response, never a file", async ({ page }) => {
    await signInAs(page, "viewer");
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/exports/jobs/exp_00000000000000000000/artifact");
      return res.status;
    });
    expect([401, 403, 404]).toContain(status);
  });
});

test.describe("Responsive", () => {
  for (const width of VIEWPORTS) {
    test(`10: /exports renders with no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, "admin");
      await page.goto("/exports");
      await expect(page.getByRole("heading", { level: 1, name: "Export Center" })).toBeVisible();
      await expectNoOverflow(page, `/exports @ ${width}`);
    });

    test(`11: /foundation (Export Center section) renders with no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(page, "admin");
      await page.goto("/foundation");
      await expect(page.getByRole("heading", { level: 1, name: "The design foundation" })).toBeVisible();
      await expect(page.getByText("Export Center execution pattern")).toBeVisible();
      await expectNoOverflow(page, `/foundation @ ${width}`);
    });
  }
});
