import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 14C.3: there is ONE canonical Agreement creation route (/finance/agreements/new). The rejected /new-v2 preview
// route was removed in the hard reset and must never come back.
const APP_ROOT = path.resolve(import.meta.dirname, "..");

describe("Agreement creation route (14C.3 hard reset)", () => {
  it("the canonical route exists", () => {
    expect(existsSync(path.join(APP_ROOT, "new", "page.tsx"))).toBe(true);
  });

  it("the rejected /finance/agreements/new-v2 route does not exist", () => {
    expect(existsSync(path.join(APP_ROOT, "new-v2"))).toBe(false);
  });
});
