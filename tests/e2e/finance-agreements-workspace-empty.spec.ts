import { expect as baseExpect, test } from "@playwright/test";

import { collectBrowserErrors, signInAs } from "./helpers/finance-agreements-fixtures";

// Dev-mode route compilation makes the first call of a route slow: allow more than the 5 s default for a UI outcome.
const expect = baseExpect.configure({ timeout: 15_000 });

// Step 14B e2e: the workspace EMPTY state. No fixtures are created here on purpose: a scoped Manager holds no scope grant to any
// Finance fixture (every other Finance spec keeps its Partners in a private region and removes them again), so the list is genuinely
// empty for this identity - the honest "No Agreements yet" state with its call to action, never a fabricated row.
test("empty workspace: 'No Agreements yet' with the New Agreement call to action, an empty count and no pager", async ({ page }) => {
  const errors = collectBrowserErrors(page);
  await signInAs(page, "manager");
  await page.goto("/finance/agreements");
  await expect(page.getByRole("heading", { level: 1, name: "Agreements" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No Agreements yet" })).toBeVisible();
  await expect(page.getByText("Create the first Agreement for a Partner or Vendor to see it here.")).toBeVisible();
  await expect(page.getByRole("link", { name: "New Agreement" })).toHaveCount(2);
  await expect(page.getByTestId("agreement-row")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Pagination" })).toHaveCount(0);
  await expect(page.getByTestId("workspace-page-status")).toHaveText("Page 1 · 0 shown");
  expect(errors.errors).toEqual([]);
});
