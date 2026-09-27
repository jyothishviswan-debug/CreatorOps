import type { Page } from "@playwright/test";

import { EMULATOR_TEST_USERS } from "@/server/auth/seed-users";
import { resolveActor } from "@/server/authz/actor";
import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";

// Notes/Meetings Completion e2e helpers - mirrors tests/e2e/helpers/partner-reviews-fixtures.ts's own
// signInAs/VIEWPORTS/noDocumentOverflow shape exactly (same idiom every stage's own e2e suite uses).

export const PASSWORD = process.env.EMULATOR_TEST_USER_PASSWORD!;
export const VIEWPORTS = [1440, 1200, 1050, 760, 390, 375] as const;

export function emailFor(name: string): string {
  return EMULATOR_TEST_USERS.find((user) => user.email.startsWith(`${name}@`))!.email;
}

export async function signInAs(page: Page, name: "admin" | "manager" | "head" | "viewer" | "analyst") {
  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("you@company.com").fill(emailFor(name));
  await page.getByPlaceholder("Enter your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/dashboard$/);
}

// Server-rendered controls exist (and can be clicked) BEFORE React hydrates them; a click in that
// window does nothing (see tests/e2e/helpers/finance-agreements-fixtures.ts's own comment - same
// established bug class in this codebase). Waits until BOTH the target selector and the app shell
// have been claimed by React before any interaction.
export async function waitForHydration(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sels) =>
      sels.every((sel) => {
        const element = document.querySelector(sel);
        return !!element && Object.keys(element).some((key) => key.startsWith("__reactProps$"));
      }),
    [selector, ".topbar button"],
  );
}

export async function noDocumentOverflow(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
}

export function collectBrowserErrors(page: Page): { errors: string[] } {
  const bag = { errors: [] as string[] };
  page.on("pageerror", (error) => bag.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      if (/Failed to load resource/i.test(text)) return;
      bag.errors.push(`console.error: ${text}`);
    }
  });
  return bag;
}

// A real Partner, created through the trusted service (never hand-rolled), as the owner record the
// flagship journey opens through the real browser.
export async function seedRealPartner(displayName: string): Promise<string> {
  const auth = getAdminAuth();
  const headUser = await auth.getUserByEmail(emailFor("head"));
  const head = await resolveActor(headUser.uid);
  if (!head) throw new Error("no resolved actor for head@creatorops.com");
  const result = await createPartner(head, { displayName, regionIds: ["Kerala"] }, `nm-e2e-${Date.now()}`);
  if (!result.ok) throw new Error(`seedRealPartner failed: ${result.code} - ${result.message}`);
  return (result.data as { partnerRef: string }).partnerRef;
}

export async function cleanupPartner(partnerRef: string): Promise<void> {
  const db = getAdminFirestore();
  const snap = await partnersCollection().where("partnerRef", "==", partnerRef).limit(1).get();
  if (!snap.empty) await db.recursiveDelete(snap.docs[0]!.ref);
}
