// Step 12F.1: regression coverage for the shared visually-hidden (`.sr`)
// utility inside scrolling tables.
//
// Root cause (confirmed by measurement): every workspace table renders
// `<th><span class="sr">Action</span></th>` (and `<caption class="sr">`). `.sr`
// is position:absolute, and `.tablewrap` (the overflow:auto scroll container)
// was not a containing block, so an `.sr` inside a horizontally-scrolled `th`
// sat at its static position far right of the viewport - outside the
// container's clipping - and widened the DOCUMENT (documentElement) by
// 134-166px on desktop and ~880-910px at 390px, while body.scrollWidth stayed
// at the viewport width (which is why the older body-based overflow check never
// noticed). The fix is in foundation.css: `.tablewrap` is now position:relative
// (contains and clips its absolutely-positioned hidden text) and `.sr` carries
// the full conventional visually-hidden pattern. Nothing is display:none, so
// the text stays in the accessibility tree.
//
// These tests use the seeded Analytics data (the same data the existing
// Explorer / Import History specs rely on), signed in as the shared admin
// storage state.
import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [1360, 760, 390, 375] as const;
const ROUTES = [
  { path: "/analytics/explorer", tableName: "Analytics Explorer records" },
  { path: "/analytics/import-history", tableName: "Import history batches" },
] as const;

async function openWithTable(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(path);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator(".tablewrap table tbody tr").first()).toBeVisible();
}

test.describe("Analytics tables: no document-level horizontal overflow", () => {
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      test(`${route.path} at ${width}px does not widen the document`, async ({ page }) => {
        await openWithTable(page, route.path, width);

        // The DOCUMENT (documentElement) - not body, which never grew and hid the bug.
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
        expect(scrollWidth, `${route.path} at ${width}px overflows the page horizontally`).toBeLessThanOrEqual(innerWidth);
        const bodyOverflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
        expect(bodyOverflow).toBeLessThanOrEqual(0);
      });
    }
  }
});

test.describe("Analytics tables: hidden header text stays accessible and the table still scrolls in its own container", () => {
  for (const route of ROUTES) {
    test(`${route.path}: the sr-only caption and Action header remain in the accessibility tree`, async ({ page }) => {
      await openWithTable(page, route.path, 390);

      // Caption gives the table its accessible name; the "Action" header cell keeps its name.
      await expect(page.getByRole("table", { name: route.tableName })).toBeAttached();
      await expect(page.getByRole("columnheader", { name: "Action" })).toBeAttached();

      // Visually hidden, but by the conventional pattern - never display:none / visibility:hidden.
      const styles = await page.evaluate(() =>
        [...document.querySelectorAll(".tablewrap .sr")].map((el) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return { text: (el.textContent ?? "").trim(), display: s.display, visibility: s.visibility, position: s.position, clipPath: s.clipPath, overflow: s.overflow, width: r.width, height: r.height };
        }),
      );
      expect(styles.length).toBeGreaterThanOrEqual(2);
      for (const s of styles) {
        expect(s.text.length).toBeGreaterThan(0);
        expect(s.display).not.toBe("none");
        expect(s.visibility).toBe("visible");
        expect(s.position).toBe("absolute");
        expect(s.overflow).toBe("hidden");
        expect(s.clipPath).toContain("inset");
        expect(s.width).toBeLessThanOrEqual(1);
        expect(s.height).toBeLessThanOrEqual(1);
      }
    });

    test(`${route.path}: at 390px the table scrolls horizontally INSIDE its bounded container, not the page`, async ({ page }) => {
      await openWithTable(page, route.path, 390);
      const wrap = page.locator(".tablewrap").first();
      const dims = await wrap.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, position: getComputedStyle(el).position, overflowX: getComputedStyle(el).overflowX }));
      expect(dims.overflowX).toBe("auto");
      expect(dims.position).toBe("relative");
      // The wide table is genuinely scrollable inside the container...
      expect(dims.scrollWidth).toBeGreaterThan(dims.clientWidth);
      // ...and scrolling it moves the container, never the document.
      await wrap.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      expect(await wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(docOverflow).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("Analytics tabs are visually unchanged by the fix", () => {
  test("Explorer and Import History keep the six tabs at the same position and size as Overview", async ({ page }) => {
    const geometry = async (path: string) => {
      await page.setViewportSize({ width: 1360, height: 900 });
      await page.goto(path);
      await expect(page.locator(".tabsbar .tab")).toHaveCount(6);
      return page.evaluate(() => {
        const bar = document.querySelector(".tabsbar")!.getBoundingClientRect();
        const first = getComputedStyle(document.querySelector(".tabsbar .tab")!);
        return { top: Math.round(bar.top), height: Math.round(bar.height), fontSize: first.fontSize, paddingBottom: first.paddingBottom, labels: [...document.querySelectorAll(".tabsbar .tab")].map((t) => t.textContent) };
      });
    };
    const overview = await geometry("/analytics");
    expect(overview.labels).toEqual(["Overview", "Instagram", "YouTube", "Partners", "Data Explorer", "Import History"]);
    for (const route of ROUTES) {
      expect(await geometry(route.path), `${route.path} tab bar drifted from Overview`).toEqual(overview);
    }
  });
});
