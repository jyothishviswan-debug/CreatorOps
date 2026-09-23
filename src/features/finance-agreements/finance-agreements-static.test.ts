import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as apiClient from "./api-client";

// Step 14B: static guards over the Finance Agreements feature folder (source text, no DOM):
//   1. vocabulary: no Campaign / Assignment / Deliverable / Creator / Payable / Invoice / Payment concepts (only the registry's own
//      field names and the "does not affect payment" disclaimer are allowed);
//   2. no Firestore / Admin SDK, and no runtime import of server code beyond the pure registry modules;
//   3. no delete anywhere.
const ROOT = path.resolve(import.meta.dirname);

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
const FILES = listSources(ROOT);
const rel = (file: string) => path.relative(ROOT, file);
const read = (file: string) => readFileSync(file, "utf8");

describe("the Finance Agreements feature folder (static)", () => {
  it("has source files to scan", () => {
    expect(FILES.length).toBeGreaterThan(15);
  });

  // Registry field names / labels and the disclaimer are the ONLY places these words may appear.
  const ALLOWED_PHRASES = [
    /invoiceRequired|invoiceDueTerms|paymentDueTerms|paymentCycle|PaymentCycle|PAYMENT_CYCLES?|PAYMENT_CYCLE_[A-Z_]+|advancePayment|AdvancePayment|affectsPayment|payment_details|vendor_payment_details/g,
    /Invoice required|Invoice due terms|Payment due terms|Payment cycle|payment cycle|Advance payment|advance payment|does not affect payment|payment-affecting|Payment-affecting|affect payment/g,
  ];
  const FORBIDDEN = /Campaign|Assignment|Deliverable|Creator(?!Ops)|Payables?|Invoices?|Payments?/gi;

  it("uses only Agreement vocabulary (no other module's concepts)", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      let text = read(file);
      for (const allowed of ALLOWED_PHRASES) text = text.replace(allowed, " ");
      const hits = text.match(FORBIDDEN);
      if (hits) offenders.push(`${rel(file)}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("never imports Firestore / the Admin SDK", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = read(file);
      if (/firebase-admin|firebase\/firestore|@\/lib\/firebase|getFirestore|server\/firestore|from\s+["']\.\.?\/firestore["']/.test(text)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  // Runtime (non type-only) imports from src/server are limited to the pure registry modules: zod schemas + pure functions.
  const PURE_RUNTIME_SERVER_MODULES = new Set(["@/server/finance-agreements/fields", "@/server/finance-agreements/terms", "@/server/finance-agreements/types", "@/server/shared/platform"]);
  const IMPORT = /^import\s+([^;]*?)\s+from\s+["']([^"']+)["'];?/gm;

  function isTypeOnly(clause: string): boolean {
    if (/^type\s/.test(clause)) return true;
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    if (!named) return false;
    const specifiers = named[1]!.split(",").map((part) => part.trim()).filter(Boolean);
    return specifiers.length > 0 && specifiers.every((part) => part.startsWith("type "));
  }

  it("imports server code type-only, except the pure registry modules", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = read(file);
      for (const match of text.matchAll(IMPORT)) {
        const [, clause, source] = match;
        if (!source!.startsWith("@/server/")) continue;
        if (isTypeOnly(clause!)) continue;
        if (!PURE_RUNTIME_SERVER_MODULES.has(source!)) offenders.push(`${rel(file)} -> ${source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pure registry modules really are Firestore-free (so the allowlist above is safe)", () => {
    for (const source of PURE_RUNTIME_SERVER_MODULES) {
      const file = path.resolve(ROOT, "../../..", "src", source.replace("@/", ""));
      const text = readFileSync(`${file}.ts`, "utf8");
      const runtimeImports = [...text.matchAll(IMPORT)].filter((m) => !isTypeOnly(m[1]!)).map((m) => m[2]!);
      for (const imported of runtimeImports) expect(imported).toMatch(/^(zod|\.\/(fields|terms|types)|@\/server\/shared\/platform)$/);
    }
  });

  it("has no delete anywhere: the API client exposes no delete / remove function", () => {
    const names = Object.keys(apiClient).filter((name) => typeof (apiClient as Record<string, unknown>)[name] === "function");
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => /delete|remove|discard/i.test(name))).toEqual([]);
    for (const file of FILES) expect(read(file), rel(file)).not.toMatch(/method:\s*["']DELETE["']/);
  });

  // Hard reset guard (Step 14C.3, then EXECUTE_HARD_RESET): the rejected v1 ("intake" as a presentation tree), v2
  // ("intake-v2") and the intermediate "agreement-form/" presentation were all deleted in turn. This guard fails
  // if any of them is ever reintroduced, or if the canonical Agreement presentation (create/) ever imports from
  // one - create/ may import only agreement-intake-logic/ (pure logic + hooks, no JSX) and the other neutral
  // finance-agreements modules.
  describe("hard reset: no rejected UI reference", () => {
    it("the rejected presentation directories do not exist", () => {
      expect(() => statSync(path.join(ROOT, "intake"))).toThrow();
      expect(() => statSync(path.join(ROOT, "intake-v2"))).toThrow();
      expect(() => statSync(path.join(ROOT, "agreement-form"))).toThrow();
    });

    it("no file in this feature folder imports an intake-v2 path, the old intake presentation tree, or the old agreement-form presentation", () => {
      const FORBIDDEN_IMPORT = /from\s+["'][^"']*\/intake-v2\/[^"']*["']|from\s+["'][^"']*\/intake\/(?!.*agreement-intake-logic)[A-Za-z]|from\s+["'][^"']*\/agreement-form\/[^"']*["']/;
      const offenders: string[] = [];
      for (const file of FILES) {
        const text = read(file);
        if (FORBIDDEN_IMPORT.test(text)) offenders.push(rel(file));
      }
      expect(offenders).toEqual([]);
    });

    it("the canonical create/ presentation never imports a JSX component from anywhere but create/ itself, @/ui, or a type/hook from agreement-intake-logic/", () => {
      const createDir = path.join(ROOT, "create");
      const createFiles = listSources(createDir);
      expect(createFiles.length).toBeGreaterThan(5);
      // A same-feature-folder relative import that reaches back INTO create/ from outside it would defeat the
      // point of this guard; every import here must be a relative path that never contains "/intake/", "intake-v2"
      // or "/agreement-form/".
      for (const file of createFiles) {
        const text = read(file);
        expect(text, rel(file)).not.toMatch(/\/intake-v2\//);
        expect(text, rel(file)).not.toMatch(/\/agreement-form\//);
        // A bare "/intake/" segment is only ever allowed as part of "agreement-intake-logic/".
        const matches = [...text.matchAll(/["'][^"']*\/intake\/[^"']*["']/g)].map((m) => m[0]);
        const bad = matches.filter((m) => !m.includes("agreement-intake-logic"));
        expect(bad, rel(file)).toEqual([]);
      }
    });
  });
});
