import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Reports Final-Master's own STATIC ARCHITECTURE GUARDS - pure source scans (no Firestore), mirroring
// src/server/reports/reports-static.test.ts's and src/server/exports/exports-static.test.ts's own
// discipline exactly (per the task's own recon item 15's explicit instruction to build this).

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/reports");

function walk(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, predicate) : predicate(entry.name) ? [full] : [];
  });
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\s)\/\/.*$/gm, "$1");
}

const NEW_FILES = [
  "metric-compatibility.ts",
  "report-templates.ts",
  "report-lifecycle-service.ts",
  "report-sections/types.ts",
  "report-sections/bands.ts",
  "report-sections/leaders.ts",
  "report-sections/top-n.ts",
  "report-sections/taxonomy.ts",
  "report-sections/data-quality.ts",
  "report-sections/filename.ts",
  "report-sections/helpers.ts",
  "report-sections/build-sections.ts",
  "report-sections/builders/monthly-partner-performance.ts",
  "report-sections/builders/campaign-event-performance.ts",
  "report-sections/builders/cross-platform-partner-programme.ts",
  "report-artifacts/artifact-store.ts",
  "report-artifacts/pdf-renderer.ts",
  "report-artifacts/xlsx-renderer.ts",
  "report-artifacts/csv-renderer.ts",
  "report-artifacts/generate-artifacts.ts",
  "report-artifacts/download-service.ts",
];

const code = new Map(NEW_FILES.map((rel) => [rel, codeOnly(readFileSync(path.join(moduleDir, rel), "utf8"))] as const));
const raw = new Map(NEW_FILES.map((rel) => [rel, readFileSync(path.join(moduleDir, rel), "utf8")] as const));

describe("the scan itself is sound", () => {
  it("finds every new Reports Final-Master file", () => {
    expect(code.size).toBe(NEW_FILES.length);
  });
});

describe("no restricted-identity/KYC/bank/credential vocabulary anywhere in the new publication modules (spec sections 5G/24)", () => {
  // Same combined vocabulary the task's own recon explicitly calls out: contract-bundle-import.ts's
  // RESTRICTED_HEADER_PATTERN plus exports-static.test.ts's FORBIDDEN_PROPERTY pattern.
  const RESTRICTED_WORD = /\b(pan|aadhaar|adhaar|gstin?|bank|ifsc|upi|swift|iban|acct\s*no|passport|voter\s*id|kyc)\b/i;
  const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber|kyc|driveFileId|webViewLink|signedUrl|driveUrl|password|apiKey|token|credential)\s*\??\s*:/i;

  it("no source file names a restricted identity/KYC/bank word", () => {
    for (const [name, source] of code) expect(source, name).not.toMatch(RESTRICTED_WORD);
  });

  it("no source file declares a restricted-identity/credential-shaped property", () => {
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });
});

describe("no raw internal ids / storage locators / auth uid leak into a report artifact or DTO", () => {
  it("only artifact-store.ts constructs a report-artifacts/ object key (import specifiers like \"./report-artifacts/x\" are not a key construction and are excluded)", () => {
    const stripImports = (source: string) => source.replace(/(?:import|export)\s[^;]*?from\s+["'][^"']*["'];?/g, "");
    for (const [name, source] of code) {
      if (name === "report-artifacts/artifact-store.ts") continue;
      expect(stripImports(source), `${name} constructs a Storage object key directly`).not.toMatch(/report-artifacts\//);
    }
  });

  it("no renderer or lifecycle file references a raw Firebase uid or a Storage locator by name", () => {
    for (const [name, source] of code) {
      if (name === "report-artifacts/artifact-store.ts") continue;
      expect(source, `${name} names a raw locator`).not.toMatch(/\blocator\b\s*:/);
    }
  });

  it("download-service.ts never returns a signed URL or bucket name - it streams bytes", () => {
    const source = raw.get("report-artifacts/download-service.ts")!;
    expect(source).not.toMatch(/signedUrl|getSignedUrl|publicUrl|\.bucket\(/i);
  });
});

describe("no external AI/OCR/Drive/payment provider call anywhere in this stage's new code", () => {
  it("no new file references Google Drive, OCR, or a payment-gateway SDK, or an LLM provider call", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/googleapis|drive\.files|DriveClient/i);
      expect(source, name).not.toMatch(/\bocr\b/i);
      expect(source, name).not.toMatch(/stripe|razorpay|paypal|plaid|payment-gateway/i);
      expect(source, name).not.toMatch(/openai|anthropic\.com|api\.anthropic|chat\.completions/i);
    }
  });
});

describe("no wildcard permissions in the new lifecycle service - explicit action grants only", () => {
  it("report-lifecycle-service.ts never reads actor.role or a role name/rank helper", () => {
    const source = code.get("report-lifecycle-service.ts")!;
    expect(source).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
    expect(source).not.toMatch(/["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
    expect(source).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b/i);
  });

  it("every lifecycle mutation calls requireReportsAccess with an explicit action id", () => {
    const source = code.get("report-lifecycle-service.ts")!;
    for (const action of ["run_reports", "edit_narrative", "submit_for_review", "finalize_report", "create_superseding_version"]) {
      expect(source, `missing gate for ${action}`).toContain(`"${action}"`);
    }
  });
});

describe("finalized version immutability is mechanically enforced, not merely documented", () => {
  it("firestore.ts's txSetReportVersion refuses to write a FINALIZED/SUPERSEDED version without the explicit override flag", () => {
    const source = codeOnly(readFileSync(path.join(moduleDir, "firestore.ts"), "utf8"));
    expect(source).toMatch(/txSetReportVersion[\s\S]{0,400}FINALIZED[\s\S]{0,200}throw/);
  });
});

describe("CSV/XLSX formula-injection mitigation is reused, never re-implemented", () => {
  it("xlsx-renderer.ts imports the SAME neutralizeFormulaInjection function exports/csv.ts already defines", () => {
    expect(raw.get("report-artifacts/xlsx-renderer.ts")).toMatch(/import\s*\{\s*neutralizeFormulaInjection\s*\}\s*from\s*["']\.\.\/\.\.\/exports\/csv["']/);
  });
  it("csv-renderer.ts reuses exports/csv.ts's own generateCsv rather than re-implementing CSV quoting", () => {
    expect(raw.get("report-artifacts/csv-renderer.ts")).toMatch(/import\s*\{\s*generateCsv\s*\}\s*from\s*["']\.\.\/\.\.\/exports\/csv["']/);
  });
});

describe("no route re-implements authorization: each one resolves the actor and calls a service", () => {
  const routeFiles = walk(routesDir, (name) => name.endsWith(".ts"));
  it("finds the new lifecycle routes", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(9);
  });
  it("every new route resolves the actor and never calls a gate/Firestore primitive directly", () => {
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.relative(routesDir, file)).toMatch(/resolveRequestActor\(\)/);
      expect(source, path.relative(routesDir, file)).not.toMatch(/canAccessFeature|canPerformAction|getAdminFirestore/);
    }
  });
});

describe("no approved Overview page is touched or referenced (UI freeze)", () => {
  const OVERVIEW_SURFACES = [/@\/ui\/Overview/, /@\/ui\/overview\.css/, /OverviewPage/, /OverviewTab/, /overview-model/, /overview-aggregate/, /overview-metrics/, /overview-service/];
  it("no new Reports Final-Master file references an Overview surface", () => {
    for (const [name, source] of raw) {
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${name} references ${pattern}`).toBe(false);
    }
  });
});
