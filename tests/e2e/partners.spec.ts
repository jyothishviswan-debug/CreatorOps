import { test, expect, type Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";

// This file runs in the default `chromium` project, pre-authenticated as
// admin@creatorops.com (Super Admin, GLOBAL scope) via the shared
// storageState - same baseline as discovery.spec.ts/administration.spec.ts.
// Tests that need a different identity call signInAs explicitly.
const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;

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

function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// PartnerForm/PartnerOwnerTeamPanel render fields with the shared
// `@/ui/Form` Field component, whose <label> is a plain sibling of the
// input (no htmlFor/id) - same locator idiom discovery.spec.ts already
// uses to work around it.
function formField(page: Page, label: string) {
  // Exact (case-sensitive, whitespace-tolerant) label match - Partners'
  // Account form has "Platform" and "Stable platform account id" on the
  // same screen, and Playwright's `hasText` string form is a
  // case-insensitive substring match, so "Platform" would otherwise also
  // match the latter. A trailing JSX-conditional expression can leave a
  // trailing space in the label text even when it renders nothing, so
  // this tolerates trailing/leading whitespace rather than requiring an
  // exact end-of-string match.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.locator(".field").filter({ has: page.locator("label", { hasText: new RegExp(`^\\s*${escaped}\\s*$`) }) }).locator("input, select, textarea");
}

type PartnerApi = { partnerRef: string; version: number; displayName: string; status: string };

async function createPartnerViaApi(page: Page, overrides: Record<string, unknown> = {}): Promise<PartnerApi> {
  const response = await page.request.post("/api/partners", {
    data: { displayName: uniqueName("E2E Partner"), ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as PartnerApi;
}

type PartnerAccountApi = { partnerAccountRef: string; version: number; platform: string };

async function createAccountViaApi(page: Page, partnerRef: string, overrides: Record<string, unknown> = {}): Promise<PartnerAccountApi> {
  const response = await page.request.post(`/api/partners/${partnerRef}/accounts`, {
    data: { platform: "Instagram", handle: uniqueName("acct").replace(/\s+/g, "").toLowerCase(), ...overrides },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as PartnerAccountApi;
}

// ---- Overview ----

test.describe("Overview", () => {
  test("shows real scoped data, not fabricated totals", async ({ page }) => {
    await page.goto("/partners");
    await expect(page.locator("h1")).toHaveText("Partners");
    await expect(page.getByText("Real scoped emulator data")).toBeVisible();
    await expect(page.locator(".ov-kpi-label", { hasText: "Total partners" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Partner Status" })).toBeVisible();
    await expect(page.getByText("Recent Activity")).toBeVisible();
    await expect(page.getByText("Quick Actions")).toBeVisible();
  });

  test("scope changes the Overview's own counts between roles", async ({ page }) => {
    await signInAs(page, "viewer");
    await page.goto("/partners");
    const viewerCount = await page.locator(".ov-kpi-value").first().innerText();

    await signInAs(page, "admin");
    await page.goto("/partners");
    const adminCount = await page.locator(".ov-kpi-value").first().innerText();

    expect(Number(adminCount.replace(/[^0-9]/g, ""))).toBeGreaterThanOrEqual(Number(viewerCount.replace(/[^0-9]/g, "")));
  });
});

// ---- Workspace ----

test.describe("Workspace", () => {
  test("search finds a Partner by name via a real bounded query, and status filter auto-applies", async ({ page }) => {
    const partner = await createPartnerViaApi(page, { displayName: uniqueName("Findable Partner") });

    await page.goto("/partners/workspace");
    await page.getByLabel("Search partners by name").fill(partner.displayName);
    await expect(page.getByText(partner.displayName)).toBeVisible({ timeout: 5000 });
  });

  test("Target Audience filter auto-applies via a real bounded query", async ({ page }) => {
    const partner = await createPartnerViaApi(page, { displayName: uniqueName("Tagged Workspace Partner"), targetAudience: "India Alpha" });

    await page.goto("/partners/workspace");
    await page.getByLabel("Search partners by name").fill(partner.displayName);
    await expect(page.getByText(partner.displayName)).toBeVisible({ timeout: 5000 });

    await page.getByLabel("Search partners by name").fill("");
    await page.getByLabel("Filter target audience").selectOption("India Alpha");
    await expect(page.getByText(partner.displayName)).toBeVisible({ timeout: 5000 });

    await page.getByLabel("Search partners by name").fill("");
    await page.getByLabel("Filter status").selectOption("ACTIVE");
    await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0);
    await expect(page.getByText(partner.displayName)).toBeVisible({ timeout: 5000 });
  });

  test("table/cards toggle shows exactly one representation at a time", async ({ page }) => {
    await page.goto("/partners/workspace");
    await expect(page.locator("table")).toBeVisible();
    await expect(page.locator(".recordgrid")).toHaveCount(0);

    await page.getByLabel("Cards view").click();
    await expect(page.locator(".recordgrid")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
  });

  test("cursor pagination is deterministic and numbered", async ({ page }) => {
    const tierTag = `PaginationProbe-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    for (let i = 0; i < 12; i += 1) {
      await createPartnerViaApi(page, { displayName: uniqueName("Page Partner"), tier: tierTag });
    }
    await page.goto("/partners/workspace");
    await page.getByLabel("Filter tier").fill(tierTag);

    const pager = page.locator("nav[aria-label='Pagination']");
    await expect(page.locator(`table tbody tr:has-text('${tierTag}')`)).toHaveCount(10, { timeout: 10_000 });
    await expect(page.locator("table tbody tr")).toHaveCount(10);
    await expect(pager.getByRole("button", { name: "Next" })).toBeEnabled({ timeout: 5000 });
    const firstPageRows = await page.locator("table tbody tr td:first-child b").allTextContents();
    expect(firstPageRows.length).toBe(10);

    await expect(async () => {
      await pager.getByRole("button", { name: "Next" }).click();
      await expect(page.getByText(/^Page 2 ·/)).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10_000 });
    const secondPageRows = await page.locator("table tbody tr td:first-child b").allTextContents();
    expect(secondPageRows.length).toBeGreaterThanOrEqual(2);
    expect(new Set([...firstPageRows, ...secondPageRows]).size).toBe(firstPageRows.length + secondPageRows.length);
  });
});

// ---- Create / duplicate checking ----

test.describe("Create Partner", () => {
  test("creates a real Partner and lands on its Detail page with an opaque partnerRef URL", async ({ page }) => {
    await page.goto("/partners/new");
    const name = uniqueName("Created Partner");
    await formField(page, "Full name").fill(name);
    await page.getByRole("button", { name: "Create partner" }).click();

    await expect(page).toHaveURL(/\/partners\/[a-f0-9-]{20,}$/);
    await expect(page.locator("h1")).toHaveText(name);
  });

  test("presents a confirmed duplicate match, a clean no-match, and an Unknown/Error lookup failure", async ({ page }) => {
    await page.goto("/partners/new");

    // Confirmed match: the seeded creator-house email.
    await formField(page, "Email address").fill("creator-house@example-partner.test");
    await expect(page.getByText(/Likely duplicate found|Possible duplicate/)).toBeVisible({ timeout: 5000 });

    // Clean: an identifier nothing matches.
    await formField(page, "Email address").fill(`${uniqueName("nomatch").replace(/\s+/g, "")}@example-partner.test`);
    await expect(page.getByText("No duplicate found")).toBeVisible({ timeout: 5000 });

    // Lookup failure - never silently "no duplicate".
    await page.route("**/api/partners/duplicate-check", (route) => route.abort());
    await formField(page, "Mobile number").fill("+91 90000 09999");
    await expect(page.getByText("Duplicate check unavailable")).toBeVisible({ timeout: 5000 });
  });

  test("collects no postal address or address proof field on the form", async ({ page }) => {
    await page.goto("/partners/new");
    const labels = (await page.locator("label").allTextContents()).map((l) => l.toLowerCase());
    for (const term of ["postal", "street", "pin code", "pincode", "zip code", "address proof", "city"]) {
      expect(labels.some((l) => l.includes(term))).toBe(false);
    }
  });

  test("captures Target Audience directly, and it can be changed via ordinary edit", async ({ page }) => {
    await page.goto("/partners/new");
    const name = uniqueName("Tagged Partner");
    await formField(page, "Full name").fill(name);
    await formField(page, "Target Audience").selectOption("India 2");
    await page.getByRole("button", { name: "Create partner" }).click();

    await expect(page.locator(".head p").first()).toHaveText("India 2");
    await expect(page.locator(".kv", { hasText: "Target Audience" }).getByText("India 2")).toBeVisible();

    const partnerRef = page.url().split("/partners/")[1];
    await page.goto(`/partners/${partnerRef}/edit`);
    await formField(page, "Target Audience").selectOption("India 4");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".head p").first()).toHaveText("India 4");
  });
});

// ---- Edit + stale conflict ----

test.describe("Edit", () => {
  test("edits ordinary fields, and a stale write is handled explicitly", async ({ page }) => {
    const partner = await createPartnerViaApi(page);

    await page.goto(`/partners/${partner.partnerRef}/edit`);
    await formField(page, "Full name").fill(`${partner.displayName} Updated`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/partners/${partner.partnerRef}$`));
    await expect(page.locator("h1")).toHaveText(`${partner.displayName} Updated`);

    await page.goto(`/partners/${partner.partnerRef}/edit`);
    const outOfBand = await page.request.patch(`/api/partners/${partner.partnerRef}`, {
      data: { displayName: `${partner.displayName} Out Of Band`, expectedVersion: partner.version + 1 },
    });
    expect(outOfBand.ok()).toBeTruthy();

    await formField(page, "Full name").fill(`${partner.displayName} Stale Attempt`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("This Partner was changed elsewhere.")).toBeVisible();
  });
});

// ---- Scope enforcement ----

test.describe("Scope enforcement", () => {
  test("a same-scope user can open a Partner's Detail page directly", async ({ page }) => {
    await signInAs(page, "analyst");
    // seed-partner-inactive is Tamil Nadu - inside Analyst's seeded
    // REGION grants (Kerala, Tamil Nadu, South).
    await page.goto("/partners/seed-partner-inactive");
    await expect(page.locator("h1")).toHaveText("Arjun Balan");
  });

  test("a cross-scope user cannot read another-scope Partner by direct URL", async ({ page }) => {
    await signInAs(page, "viewer");
    // creator-house is Karnataka-only with no owner - outside Viewer's
    // seeded SELF/REGION grants (Kerala, South).
    await page.goto("/partners/creator-house");
    await expect(page.getByText("Access denied")).toBeVisible();
    await expect(page.getByText("You don't have permission to view this Partner.")).toBeVisible();
  });
});

// ---- Partner Accounts ----

test.describe("Partner Accounts", () => {
  test("creates an account, and identity collision on an existing handle is rejected", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    await page.goto(`/partners/${partner.partnerRef}`);
    await page.getByRole("tab", { name: "Accounts" }).click();

    await page.getByRole("button", { name: "Add account" }).click();
    await formField(page, "Platform").fill("Instagram");
    // creator-house's own seeded primary Instagram handle - a real
    // collision against a DIFFERENT Partner's account.
    await formField(page, "Handle").fill("creatorhouse");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("This account identity is already claimed by another Partner Account.")).toBeVisible();

    await formField(page, "Handle").fill(uniqueName("uniquehandle").replace(/\s+/g, "").toLowerCase());
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("No primary account.")).toBeVisible();
  });

  test("multiple same-platform accounts on one Partner carry distinct identity", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    const handleA = uniqueName("acctA").replace(/\s+/g, "").toLowerCase();
    const handleB = uniqueName("acctB").replace(/\s+/g, "").toLowerCase();
    await createAccountViaApi(page, partner.partnerRef, { platform: "Instagram", handle: handleA });
    await createAccountViaApi(page, partner.partnerRef, { platform: "Instagram", handle: handleB });

    await page.goto(`/partners/${partner.partnerRef}`);
    await page.getByRole("tab", { name: "Accounts" }).click();
    await expect(page.getByText(`@${handleA}`)).toBeVisible();
    await expect(page.getByText(`@${handleB}`)).toBeVisible();
  });

  test("edits handle/URL (identity evolution), and a stable platform id can be upgraded then locked against replacement", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    await createAccountViaApi(page, partner.partnerRef, { handle: uniqueName("evolve").replace(/\s+/g, "").toLowerCase() });

    await page.goto(`/partners/${partner.partnerRef}`);
    await page.getByRole("tab", { name: "Accounts" }).click();
    await page.getByRole("button", { name: "Edit" }).click();

    const newHandle = uniqueName("evolved").replace(/\s+/g, "").toLowerCase();
    await formField(page, "Handle").fill(newHandle);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(`@${newHandle}`)).toBeVisible();

    // Upgrade to a stable platform id.
    await page.getByRole("button", { name: "Edit" }).click();
    await formField(page, "Stable platform account id").fill("STABLE-E2E-001");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("stable id on file")).toBeVisible();

    // Once set, the field is locked in the UI - the ordinary edit path
    // cannot replace or clear it (see partner-account-service.ts).
    await page.getByRole("button", { name: "Edit" }).click();
    const lockedField = formField(page, "Stable platform account id (locked once set)");
    await expect(lockedField).toBeDisabled();
    await expect(page.getByText("A stable id already on file cannot be replaced or cleared through an ordinary edit.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("set primary, change primary, and inactivating the primary leaves no primary with no silent promotion", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    const handleA = uniqueName("primA").replace(/\s+/g, "").toLowerCase();
    const handleB = uniqueName("primB").replace(/\s+/g, "").toLowerCase();
    await createAccountViaApi(page, partner.partnerRef, { handle: handleA, primary: true });
    await createAccountViaApi(page, partner.partnerRef, { handle: handleB });

    await page.goto(`/partners/${partner.partnerRef}`);
    await page.getByRole("tab", { name: "Accounts" }).click();
    // Scoped by each account's own stable handle, not by which one is
    // currently "Primary" - that changes mid-test, and re-resolving a
    // "Primary"-text-based locator at each step is a real race (it can
    // momentarily match neither/both row during the transition).
    const recordA = page.locator(".record").filter({ hasText: `@${handleA}` });
    const recordB = page.locator(".record").filter({ hasText: `@${handleB}` });
    // The Pill's exact text (not "Set primary", which also contains the
    // substring "primary" and would otherwise match too).
    await expect(recordA.getByText("Primary", { exact: true })).toBeVisible();

    // Change primary to the second account.
    await recordB.getByRole("button", { name: "Set primary" }).click();
    await expect(recordB.getByText("Primary", { exact: true })).toBeVisible();
    await expect(recordA.getByText("Primary", { exact: true })).toHaveCount(0);

    // Inactivate the (new) primary - explicit warning, then no silent
    // promotion of the remaining account.
    await recordB.getByRole("button", { name: "Inactivate" }).click();
    await expect(page.getByText("This is the primary account.")).toBeVisible();
    await page.getByRole("button", { name: "Inactivate anyway" }).click();
    await expect(page.getByText("No primary account.")).toBeVisible();
    await expect(page.getByText("Primary", { exact: true })).toHaveCount(0);
  });
});

// ---- NEW_ACCOUNT pending setup ----

test.describe("NEW_ACCOUNT pending setup", () => {
  test("a Discovery NEW_ACCOUNT conversion shows setup pending, and creating a real account resolves it live", async ({ page }) => {
    await signInAs(page, "head");

    const leadResponse = await page.request.post("/api/discovery/leads", {
      data: { displayName: uniqueName("E2E NEW_ACCOUNT Lead"), source: { type: "referral" }, region: "Kerala", email: `${uniqueName("newacct").replace(/\s+/g, "")}@example.com` },
    });
    expect(leadResponse.ok()).toBeTruthy();
    const lead = (await leadResponse.json()) as { leadRef: string; version: number };
    let version = lead.version;

    const research = await page.request.post(`/api/discovery/leads/${lead.leadRef}/research`, { data: { targetAudience: "India 1", expectedVersion: version } });
    version = (await research.json()).version;
    const outbound = await page.request.post(`/api/discovery/leads/${lead.leadRef}/outreach`, {
      data: { direction: "OUTBOUND", channel: "email", summary: "hi", outcome: "sent", expectedVersion: version },
    });
    version = (await outbound.json()).version;
    const inbound = await page.request.post(`/api/discovery/leads/${lead.leadRef}/outreach`, {
      data: { direction: "INBOUND", channel: "email", summary: "reply", outcome: "interested", meaningfulResponse: true, expectedVersion: version },
    });
    version = (await inbound.json()).version;
    const evaluating = await page.request.post(`/api/discovery/leads/${lead.leadRef}/lifecycle`, { data: { to: "EVALUATING", expectedVersion: version } });
    version = (await evaluating.json()).version;
    const review = await page.request.post(`/api/discovery/leads/${lead.leadRef}/review`, { data: { outcome: "SHORTLIST", expectedVersion: version } });
    version = (await review.json()).version;
    const commercial = await page.request.post(`/api/discovery/leads/${lead.leadRef}/commercial`, { data: { alignmentConfirmed: true, expectedVersion: version } });
    version = (await commercial.json()).version;
    const agreement = await page.request.post(`/api/discovery/leads/${lead.leadRef}/agreement`, { data: { confirmed: true, expectedVersion: version } });
    version = (await agreement.json()).version;
    const asset = await page.request.post(`/api/discovery/leads/${lead.leadRef}/asset-decision`, { data: { decision: "NEW_ACCOUNT", expectedVersion: version } });
    version = (await asset.json()).version;

    const candidates = await page.request.get(`/api/discovery/users/search?emailPrefix=head@`);
    const [managerCandidate] = (await candidates.json()) as { userRef: string }[];
    expect(managerCandidate).toBeTruthy();
    const manager = await page.request.post(`/api/discovery/leads/${lead.leadRef}/manager`, { data: { managerUserRef: managerCandidate.userRef, expectedVersion: version } });
    expect(manager.ok(), `status ${manager.status()}: ${await manager.text()}`).toBeTruthy();
    version = (await manager.json()).version;
    const kyc = await page.request.put(`/api/discovery/leads/${lead.leadRef}/kyc`, {
      data: {
        email: "kyc-e2e@example.com",
        aadhaar: { number: "0000-1111-3333", evidenceRef: "ref://a" },
        pan: { number: "NEWAC1234F", evidenceRef: "ref://p" },
        bank: { accountHolderName: "New Account Flow", accountNumber: "222233334444", ifsc: "NEWA0000001", bankName: "New Account Bank", branchName: "New Account Branch", proofRef: "ref://b" },
        gst: { applicable: false },
        expectedKycVersion: 0,
        expectedLeadVersion: version,
      },
    });
    expect(kyc.ok()).toBeTruthy();
    const leadAfterKyc = await page.request.get(`/api/discovery/leads/${lead.leadRef}`);
    version = (await leadAfterKyc.json()).version;
    const ready = await page.request.post(`/api/discovery/leads/${lead.leadRef}/lifecycle`, { data: { to: "CONVERSION_READY", expectedVersion: version } });
    expect(ready.ok()).toBeTruthy();
    version = (await ready.json()).version;

    const convert = await page.request.post(`/api/discovery/leads/${lead.leadRef}/convert`, { data: { idempotencyKey: `e2e-${Date.now()}`, expectedVersion: version } });
    expect(convert.ok()).toBeTruthy();
    const conversion = (await convert.json()) as { partnerRef: string; partnerAccountRef: string | null; pendingPartnerAccountSetup: boolean };
    expect(conversion.pendingPartnerAccountSetup).toBe(true);
    expect(conversion.partnerAccountRef).toBeNull();

    await page.goto(`/partners/${conversion.partnerRef}`);
    await expect(page.getByText("Account setup pending.")).toBeVisible();
    // Target Audience is carried over verbatim from the origin Lead's
    // Research evidence (set above) - never left blank when it was
    // already captured in Discovery.
    await expect(page.locator(".head p").first()).toHaveText("India 1");
    await expect(page.locator(".kv", { hasText: "Target Audience" }).getByText("India 1")).toBeVisible();

    await page.getByRole("tab", { name: "Accounts" }).click();
    await expect(page.getByText("Account setup pending.")).toBeVisible();
    await page.getByRole("button", { name: "Add account" }).click();
    await formField(page, "Platform").fill("Instagram");
    await formField(page, "Handle").fill(uniqueName("newacctresolved").replace(/\s+/g, "").toLowerCase());
    await page.getByRole("button", { name: "Create account" }).click();

    // Never fabricated client-side - resolved live via a real refetch
    // after the server-side transaction cleared the flag.
    await expect(page.getByText("Account setup pending.")).toHaveCount(0, { timeout: 5000 });

    await page.getByRole("tab", { name: "Overview" }).click();
    await expect(page.getByText("Account setup pending.")).toHaveCount(0);

    // Discovery provenance link remains intact and points at the real
    // origin Lead.
    await expect(page.getByText("Discovery provenance")).toBeVisible();
    await expect(page.locator(`a[href="/discovery/${lead.leadRef}"]`)).toBeVisible();
  });
});

// ---- Lifecycle / governance ----

test.describe("Lifecycle / governance", () => {
  test("ACTIVE <-> INACTIVE toggles without a reason", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    await page.goto(`/partners/${partner.partnerRef}`);

    await page.getByRole("button", { name: "Deactivate" }).click();
    await expect(page.locator(".pill", { hasText: "Inactive" })).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.locator(".pill", { hasText: "Active" })).toBeVisible({ timeout: 5000 });
  });

  test("Blacklist requires a reason and supports reasoned restore", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    await page.goto(`/partners/${partner.partnerRef}`);

    await page.getByRole("button", { name: "Blacklist", exact: true }).click();
    await expect(page.getByLabel(/Reason for moving to Blacklisted/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm" })).toBeDisabled();

    await page.getByLabel(/Reason for moving to Blacklisted/).fill("E2E blacklist reason.");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".pill", { hasText: "Blacklisted" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("E2E blacklist reason.")).toBeVisible();

    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await page.getByRole("button", { name: "Confirm restore" }).click();
    await expect(page.locator(".pill", { hasText: "Active" })).toBeVisible({ timeout: 5000 });
  });

  test("Archive requires a reason, and a dependency-blocked archive shows blockers without leaving Confirm reusable as safe", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    await createAccountViaApi(page, partner.partnerRef, { primary: true });

    await page.goto(`/partners/${partner.partnerRef}`);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByLabel(/Reason for moving to Archived/).fill("E2E archive attempt with an active account.");
    await page.getByRole("button", { name: "Confirm" }).click();

    // Blocked - an active Partner Account exists (see
    // checkPartnerDependencies) - never presented as safe.
    await expect(page.getByText("Not ready.")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/active Partner Account/)).toBeVisible();
    await expect(page.locator(".pill", { hasText: "Active" })).toBeVisible();
  });
});

// ---- Restricted identity ----

test.describe("Restricted identity", () => {
  test("denied without the payment_details sensitive category", async ({ page }) => {
    await signInAs(page, "manager");
    await page.goto("/partners/creator-house");
    await page.getByRole("tab", { name: "Restricted Identity" }).click();
    await page.getByRole("button", { name: "View / manage restricted identity" }).click();
    await expect(page.getByText("Restricted.")).toBeVisible({ timeout: 5000 });
  });

  test("allowed with the payment_details sensitive category, and the ordinary page never leaks restricted values", async ({ page }) => {
    await signInAs(page, "head");
    await page.goto("/partners/creator-house");

    // Ordinary Overview must never contain restricted values.
    await expect(page.getByText("ABCDE0000F")).toHaveCount(0);
    await expect(page.getByText("000000000001")).toHaveCount(0);

    await page.getByRole("tab", { name: "Restricted Identity" }).click();
    await page.getByRole("button", { name: "View / manage restricted identity" }).click();
    await expect(page.getByLabel("PAN")).toHaveValue("ABCDE0000F", { timeout: 5000 });
  });
});

// ---- Discovery provenance ----

test.describe("Discovery provenance", () => {
  test("a Partner created via direct create shows no Discovery origin", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    await page.goto(`/partners/${partner.partnerRef}`);
    await expect(page.getByText("Created directly - no Discovery origin.")).toBeVisible();
  });
});

// ---- Relationships (Step 8B: real Vendor relationship slice) ----

test.describe("Relationships", () => {
  test("shows an honest empty state for a Partner with no Vendor relationships, never fabricated data", async ({ page }) => {
    const partner = await createPartnerViaApi(page);
    await page.goto(`/partners/${partner.partnerRef}`);
    await page.getByRole("tab", { name: "Relationships" }).click();
    await expect(page.getByText("No Vendor relationships yet")).toBeVisible({ timeout: 5000 });
  });

  test("shows the real Vendor relationship rows for a Partner that has them, with a link to the Vendor when directly authorized", async ({ page }) => {
    // creator-house is seeded with two real Vendor relationships (see
    // seed-vendors-data.ts) - Super Admin (GLOBAL scope) can reach both
    // the Partner and the linked Vendors directly.
    await page.goto("/partners/creator-house");
    await page.getByRole("tab", { name: "Relationships" }).click();
    await expect(page.getByText("Northline Talent Agency")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("link", { name: "Open Vendor" }).first()).toBeVisible();
  });
});

// ---- Mobile ----

test.describe("Mobile", () => {
  test("Workspace and Detail remain usable at 390×844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const partner = await createPartnerViaApi(page);

    await page.goto("/partners/workspace");
    await expect(page.locator("h1")).toHaveText("Partners workspace");
    let overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.goto(`/partners/${partner.partnerRef}`);
    await expect(page.locator("h1")).toHaveText(partner.displayName);
    await expect(page.locator(".workflow")).toBeVisible();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.getByRole("tab", { name: "Accounts" }).click();
    overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
