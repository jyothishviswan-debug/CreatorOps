import { test, expect } from "@playwright/test";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
];

// A representative page per pattern: rich Overview, Workspace list, Detail,
// and Create/Edit form.
const REPRESENTATIVE_ROUTES = ["/dashboard", "/discovery/leads", "/finance", "/partners/new"];

for (const viewport of VIEWPORTS) {
  for (const route of REPRESENTATIVE_ROUTES) {
    test(`no horizontal overflow at ${viewport.name}: ${route}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(route);
      await expect(page.locator("h1").first()).toBeVisible();

      // body.scrollWidth reflects actual visible/scrollable content; a
      // fixed-position off-canvas sidebar (mobile nav, translateX(-100%))
      // can inflate documentElement.scrollWidth without any real overflow.
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.body.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${route} at ${viewport.name} overflows horizontally`).toBeLessThanOrEqual(clientWidth + 1);
    });
  }
}
