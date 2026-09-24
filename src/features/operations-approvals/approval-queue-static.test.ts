import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 18B: the UI-layer mirror of operations-static.test.ts's own backend guard ("Step 18A ships
// NO act_on_approval_queue action and NO generic setStatus/act function anywhere") - this file
// proves the SAME zero-mutation discipline holds in the Approval Queue's UI feature directory. A
// future change that quietly wires an approve/reject/resolve/confirm/finalize button into this
// directory fails this test loudly, not silently in review.

const dir = import.meta.dirname;
const files = readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".test.ts"))
  .map((entry) => path.join(dir, entry.name));

const sources = new Map(files.map((file) => [path.basename(file), readFileSync(file, "utf8")] as const));

describe("Approval Queue UI: no mutation action exists anywhere in this feature directory", () => {
  it("scanned at least the workspace component", () => {
    expect([...sources.keys()]).toContain("ApprovalQueueWorkspace.tsx");
  });

  it("no source-module mutation verb (approve/reject/resolve/confirm/finalize/setStatus/actOnApproval) is called anywhere in this directory", () => {
    const forbidden = /\b(approve|reject|resolve|confirm|finalize)[A-Za-z]*\s*\(|function\s+setStatus\s*\(|actOnApproval/i;
    for (const [name, source] of sources) {
      // "Requested by"/"requestedBy" and "Confirming will count it toward..." are plain display
      // copy, not calls - the regex only matches an actual function-call shape ( `word(` ) or the
      // two named forbidden helpers, so ordinary prose in a title/summary string never trips it.
      expect(source, name).not.toMatch(forbidden);
    }
  });

  it("imports from the Operations api-client only the read-only surface (list/get/refresh) - never a mutation call", () => {
    const allowedApiImports = new Set(["listApprovalQueue", "getApprovalItem", "refreshApprovalItem"]);
    for (const [name, source] of sources) {
      const fullMatch = source.match(/import\s*\{([^}]*)\}\s*from\s*"@\/features\/operations\/api-client"/);
      if (!fullMatch) continue;
      const names = fullMatch[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      for (const imported of names) {
        expect(allowedApiImports.has(imported), `${name} imports non-read-only api-client member: ${imported}`).toBe(true);
      }
    }
  });

  it("the only rendered action button text anywhere in the workspace is 'Open source' and 'Refresh' (plus filter/reset controls) - no Approve/Reject/Resolve/Confirm button label exists", () => {
    const workspace = sources.get("ApprovalQueueWorkspace.tsx")!;
    expect(workspace).not.toMatch(/>\s*(Approve|Reject|Resolve|Confirm|Finalize)\s*</i);
  });
});
