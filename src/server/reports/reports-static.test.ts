import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { REPORTS_COLLECTIONS } from "./firestore";

// Step 19A section 24: the STATIC ARCHITECTURE GUARDS of the Reports module. Pure source scans (no
// Firestore) - mirrors src/server/operations/operations-static.test.ts's own discipline exactly.

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/reports");
const appDir = path.resolve(moduleDir, "../../app");
const srcDir = path.resolve(moduleDir, "../..");

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

function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) found.push(match[1]!);
  for (const match of source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) found.push(match[1]!);
  return found;
}

const moduleFiles = walk(moduleDir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
const routeFiles = walk(routesDir, (name) => name.endsWith(".ts")).sort();

const code = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), codeOnly(readFileSync(file, "utf8"))] as const));
const raw = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), readFileSync(file, "utf8")] as const));

describe("the scan itself is sound", () => {
  it("finds the module's own foundation files and the routes", () => {
    for (const expected of ["types.ts", "catalog.ts", "reports-gate.ts", "reports-permissions.ts", "client-dto.ts", "http.ts", "index.ts", "firestore.ts", "filters.ts", "report-service.ts", "snapshot-service.ts"]) {
      expect([...code.keys()]).toContain(expected);
    }
    expect(routeFiles.length).toBeGreaterThan(4);
  });
});

describe("section 3/24: Reports owns no canonical business truth, no reporting warehouse collection", () => {
  it("the ONLY collection named anywhere in the module is reportSnapshots, and only firestore.ts names it", () => {
    const allowed = new Set<string>(Object.values(REPORTS_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowed.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
      if (name === "firestore.ts") continue;
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\bgetAdminFirestore\(\)\s*\.collection/);
    }
  });

  it("no family projector performs a Firestore write, and none names a Firestore collection at all - every family is a pure composition of other modules' own public services", () => {
    for (const [name, source] of code) {
      if (!name.startsWith("families" + path.sep) && !name.startsWith("families/")) continue;
      expect(source, `${name} performs a Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
      expect(source, `${name} calls getAdminFirestore`).not.toMatch(/getAdminFirestore\(\)/);
      expect(source, `${name} names a Firestore collection`).not.toMatch(/\.collection\(/);
    }
  });

  it("no family projector imports another module's Firestore/gate internals directly - every family imports only that module's own service/index surface", () => {
    const forbidden = /partners\/firestore|vendors\/firestore|campaigns\/firestore|assignments\/firestore|content\/firestore|partner-reviews\/firestore|finance-agreements\/firestore|finance-payables\/firestore|finance-invoices\/firestore|finance-payments\/firestore|discovery\/firestore|administration\/firestore|analytics\/firestore|operations\/firestore|-gate["']/;
    for (const [name, source] of raw) {
      if (!name.startsWith("families/")) continue;
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(forbidden);
    }
  });

  it("the finalized snapshot is IMMUTABLE - firestore.ts offers only a create, never a set/update/delete for it", () => {
    const firestore = code.get("firestore.ts")!;
    expect(firestore).toMatch(/export async function createReportSnapshotDoc/);
    expect(firestore).not.toMatch(/\.doc\([^)]*\)\s*\.(set|update|delete)\s*\(/);
  });

  it("no delete of any kind anywhere in the module or its routes", () => {
    for (const [name, source] of code) expect(source, name).not.toMatch(/\.delete\s*\(|deleteDoc|recursiveDelete|bulkWriter/);
    for (const file of routeFiles) expect(codeOnly(readFileSync(file, "utf8")), path.basename(file)).not.toMatch(/\.delete\s*\(|deleteDoc|recursiveDelete/);
  });
});

describe("section 7/24: filters can never grant access - only a report's own declared allowlist is honored", () => {
  it("parseAppliedFilters only ever reads keys present in the definition's own supportedFilters, never trusts an arbitrary field name", () => {
    const filters = code.get("filters.ts")!;
    expect(filters).toMatch(/allowedIds\.has\(key\)/);
    expect(filters).not.toMatch(/getAdminFirestore|\.collection\(/);
  });
});

describe("section 9/24: no sensitive-data leakage in a Reports DTO", () => {
  it("no property with an identity-value, raw-bank-data, or Drive/credential name is declared anywhere in the module", () => {
    const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber|kyc|driveFileId|webViewLink|signedUrl|driveUrl|password|apiKey|token|credential)\s*\??\s*:/i;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });

  it("no property named blendedScore/compositeScore/overallScore is ever declared (section 6/12: no blended Partner Review score)", () => {
    const FORBIDDEN_SCORE = /\b(blendedScore|compositeScore|overallScore|combinedScore)\s*\??\s*:/i;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_SCORE);
  });

  it("client-dto.ts never imports Firestore or a business module's internals", () => {
    for (const spec of importsOf(raw.get("client-dto.ts")!)) {
      expect(spec, `client-dto imports ${spec}`).not.toMatch(/firebase\/admin|partners\/|vendors\/|-gate$/);
    }
    expect(code.get("http.ts")).not.toMatch(/firestore/);
  });
});

describe("section 16/24 (superseded by Reports Final-Master's own spec section 17/18/19/22): Reports now owns REAL PDF/XLSX/CSV artifact generation", () => {
  // Step 19A's original guard here asserted the OPPOSITE ("artifactFormats is descriptive metadata
  // only, no generation library is ever imported") - that was correct for 19A's own scope, which
  // explicitly deferred all real file generation. The Reports Final-Master stage's own mission
  // statement makes the opposite an explicit CLOSURE CRITERION ("Report-owned PDF/XLSX/CSV artifacts
  // work" - "do not move this work into Export Center"), so this guard is deliberately updated rather
  // than left contradicting the shipped architecture. What is still enforced: generation libraries are
  // confined to report-artifacts/ (never scattered into families/, the lifecycle service, or a UI
  // file), and this module still creates no route under /api/exports.
  const GENERATION_IMPORT = /from\s+["'](exceljs|pdfkit|xlsx|puppeteer|jspdf|pdf-lib)["']/i;

  it("a PDF/XLSX generation library is imported ONLY from report-artifacts/ files", () => {
    for (const [name, source] of raw) {
      if (name.startsWith("report-artifacts" + path.sep) || name.startsWith("report-artifacts/")) continue;
      expect(source, `${name} imports a generation library outside report-artifacts/`).not.toMatch(GENERATION_IMPORT);
    }
  });

  it("no UI (.tsx) file anywhere in the app imports a PDF/XLSX generation library - generation only ever happens server-side", () => {
    const featuresDir = path.resolve(moduleDir, "../../features/reports");
    let tsxFiles: string[] = [];
    try {
      tsxFiles = walk(featuresDir, (name) => name.endsWith(".tsx"));
    } catch {
      tsxFiles = [];
    }
    for (const file of tsxFiles) expect(readFileSync(file, "utf8"), path.relative(srcDir, file)).not.toMatch(GENERATION_IMPORT);
  });

  it("no route under /api/exports is created or modified by this module", () => {
    for (const [name] of code) expect(name).not.toMatch(/exports/);
    expect(routeFiles.every((f) => !f.includes(`${path.sep}exports${path.sep}`))).toBe(true);
  });
});

describe("section 24: no real Google Drive/OCR/bank calls", () => {
  it("no Reports file or route references Google Drive, OCR, or a bank/payment-gateway SDK", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/googleapis|drive\.files|DriveClient/i);
      expect(source, name).not.toMatch(/\bocr\b/i);
      expect(source, name).not.toMatch(/stripe|razorpay|paypal|plaid|payment-gateway|bank-gateway/i);
    }
  });
});

describe("section 17: the Viewer-safe path never becomes a generic authorization bypass", () => {
  it("the Viewer-safe run explicitly blocks Finance/Administration-sensitive families, regardless of role", () => {
    const service = code.get("report-service.ts")!;
    expect(service).toMatch(/VIEWER_SAFE_BLOCKED_REPORT_IDS/);
    expect(service).toMatch(/"finance_status"/);
    expect(service).toMatch(/"administration_security"/);
  });

  it("the viewer-run route passes viewerSafe:true through to runReport - it is never the same call as the regular run route", () => {
    const viewerRunRoute = readFileSync(path.join(routesDir, "[reportId]", "viewer-run", "route.ts"), "utf8");
    expect(viewerRunRoute).toMatch(/viewerSafe:\s*true/);
    const runRoute = readFileSync(path.join(routesDir, "[reportId]", "run", "route.ts"), "utf8");
    expect(runRoute).not.toMatch(/viewerSafe:\s*true/);
  });
});

describe("section 25: Reports UI build (Step 19B closes the 19A placeholder boundary)", () => {
  // Step 19A deliberately left the two placeholder pages (fixture-fed, no real backend call) as the
  // ONLY .tsx files under src/app/reports, and this test's own original assertion pinned that as a
  // temporal boundary ("no final Reports UI build in 19A"). Step 19B's whole mission is to build the
  // real governed UI over the now-closed backend, so that boundary is expected to move - this
  // assertion is updated to the real route set the spec calls for (catalog, one report's own
  // configure+run+result view, and finalized-snapshot browsing) rather than removed, so a future
  // stray page can't be added under src/app/reports without this test being deliberately updated too.
  //
  // Reports Final-Master adds exactly ONE more real route on top of Step 19B's set:
  // app/reports/publish/page.tsx - the new publication lifecycle workspace (spec section 12). Same
  // "deliberately updated, never silently removed" discipline applies.
  it("src/app/reports contains exactly the Step 19B + Reports Final-Master real-UI route set (no stray/orphaned page)", () => {
    const reportsAppDir = path.join(appDir, "reports");
    const files = walk(reportsAppDir, (name) => name.endsWith(".tsx"))
      .map((f) => path.relative(srcDir, f).split(path.sep).join("/"))
      .sort();
    expect(files).toEqual(["app/reports/[reportId]/page.tsx", "app/reports/page.tsx", "app/reports/publish/page.tsx", "app/reports/snapshots/[snapshotRef]/page.tsx", "app/reports/snapshots/page.tsx"].sort());
  });

  it("no server/reports file imports a React/.tsx component or Next.js page convention", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/from ["']react["']|"use client"/);
    }
  });
});

describe("no approved Overview page is touched or referenced (UI freeze)", () => {
  const OVERVIEW_SURFACES = [/@\/ui\/Overview/, /@\/ui\/overview\.css/, /OverviewPage/, /OverviewTab/, /overview-model/, /overview-aggregate/, /overview-metrics/, /overview-service/];

  it("no Reports server file or route imports or names an Overview surface", () => {
    for (const [name, source] of raw) {
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${name} references ${pattern}`).toBe(false);
    }
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${path.basename(file)} references ${pattern}`).toBe(false);
    }
  });

  it("the three Overview freeze files are untouched by this module (no reference anywhere)", () => {
    const FROZEN = ["src/app/dashboard/page.tsx", "src/ui/Overview.tsx", "src/ui/overview.css"];
    for (const [name, source] of raw) {
      for (const frozen of FROZEN) expect(source, `${name} references ${frozen}`).not.toContain(frozen);
    }
  });
});

describe("explicit grants only: no role names, no role reads, no rank", () => {
  it("never reads actor.role, compares a role name, imports the role catalog, or uses a rank/minimumRole helper", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
      expect(source, name).not.toMatch(/["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
      expect(source, name).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b|\bisAtLeast\w*Role\b/i);
      for (const spec of importsOf(raw.get(name)!)) expect(spec, `${name} imports ${spec}`).not.toMatch(/authz\/roles$/);
    }
  });

  it("no route re-implements authorization: each one resolves the actor and calls a service", () => {
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.basename(file)).toMatch(/resolveRequestActor\(\)/);
      expect(source, path.basename(file)).not.toMatch(/canAccessFeature|canPerformAction|getActorScopeGrants|getAdminFirestore/);
    }
  });
});
