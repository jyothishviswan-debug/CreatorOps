import { test, expect } from "@playwright/test";

test("global sidebar navigates to every module", async ({ page }) => {
  await page.goto("/dashboard");

  const nav = page.locator('nav[aria-label="Global navigation"]');
  const links = nav.locator("a.navitem");
  const count = await links.count();
  expect(count).toBeGreaterThan(10);

  for (let i = 0; i < count; i++) {
    const link = nav.locator("a.navitem").nth(i);
    const href = await link.getAttribute("href");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.locator("h1").first()).toBeVisible();
  }
});

test("mobile navigation opens and closes via the menu button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");

  const sidebar = page.locator("#sidebar");
  await expect(sidebar).not.toHaveClass(/open/);

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(sidebar).toHaveClass(/open/);

  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(sidebar).not.toHaveClass(/open/);
});
