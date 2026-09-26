import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EXPORTS_COLLECTIONS } from "./firestore";

// Export Center's own STATIC ARCHITECTURE GUARDS - pure source scans (no Firestore), mirroring
// src/server/reports/reports-static.test.ts's own discipline exactly.

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/exports");
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
    for (const expected of ["types.ts", "catalog.ts", "exports-gate.ts", "exports-permissions.ts", "client-dto.ts", "http.ts", "index.ts", "firestore.ts", "filters.ts", "column-validation.ts", "export-service.ts", "artifact-store.ts", "generate.ts", "csv.ts", "xlsx.ts", "pdf.ts"]) {
      expect([...code.keys()]).toContain(expected);
    }
    expect(routeFiles.length).toBeGreaterThanOrEqual(4);
  });
});

describe("no direct browser Firestore access, no reporting/export warehouse collection", () => {
  it("the ONLY collection named anywhere in the module is exportJobs, and only firestore.ts names it", () => {
    const allowed = new Set<string>(Object.values(EXPORTS_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowed.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
      if (name === "firestore.ts") continue;
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\bgetAdminFirestore\(\)\s*\.collection/);
    }
  });

  it("no source fetcher performs a Firestore write, and none names a Firestore collection at all - every source is a pure composition of another module's own public service", () => {
    for (const [name, source] of code) {
      if (!name.startsWith("sources" + path.sep) && !name.startsWith("sources/")) continue;
      expect(source, `${name} performs a Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
      expect(source, `${name} calls getAdminFirestore`).not.toMatch(/getAdminFirestore\(\)/);
      expect(source, `${name} names a Firestore collection`).not.toMatch(/\.collection\(/);
    }
  });

  it("no source fetcher imports another module's Firestore/gate internals directly - only that module's own service surface", () => {
    const forbidden = /partners\/firestore|campaigns\/firestore|assignments\/firestore|-gate["']/;
    for (const [name, source] of raw) {
      if (!name.startsWith("sources/")) continue;
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(forbidden);
    }
  });

  it("no delete of any kind anywhere in the module or its routes (export jobs are append/update only, never deleted)", () => {
    for (const [name, source] of code) expect(source, name).not.toMatch(/\.delete\s*\(|deleteDoc|recursiveDelete|bulkWriter/);
    for (const file of routeFiles) expect(codeOnly(readFileSync(file, "utf8")), path.basename(file)).not.toMatch(/\.delete\s*\(|deleteDoc|recursiveDelete/);
  });
});

describe("no browser fetch-all/unrestricted client generation path", () => {
  it("no source fetcher reads more than one bounded page (no cursor-following loop, no unbounded scan)", () => {
    for (const [name, source] of code) {
      if (!name.startsWith("sources/")) continue;
      expect(source, `${name} loops over pages`).not.toMatch(/while\s*\(|for\s*\(.*nextCursor/);
    }
  });

  it("no file writer/PDF/XLSX generation library is imported from any UI (.tsx) file - generation only ever happens server-side", () => {
    const featuresDir = path.resolve(moduleDir, "../../features/exports");
    let tsxFiles: string[] = [];
    try {
      tsxFiles = walk(featuresDir, (name) => name.endsWith(".tsx"));
    } catch {
      tsxFiles = [];
    }
    const FORBIDDEN_IMPORT = /from\s+["'](exceljs|pdfkit|xlsx|puppeteer|jspdf|pdf-lib)["']/i;
    for (const file of tsxFiles) expect(readFileSync(file, "utf8"), path.relative(srcDir, file)).not.toMatch(FORBIDDEN_IMPORT);
  });
});

describe("server-authoritative column validation - the client can never widen the allowed column set", () => {
  it("validateRequestedColumns only accepts ids present in the target's own declared columns, and rejects unknowns/duplicates outright", () => {
    const validation = code.get("column-validation.ts")!;
    expect(validation).toMatch(/allowedIds\.has\(/);
    expect(validation).toMatch(/seen\.has\(/);
    expect(validation).not.toMatch(/getAdminFirestore|\.collection\(/);
  });

  it("export-service.ts calls validateRequestedColumns before ever calling a source fetcher", () => {
    const service = raw.get("export-service.ts")!;
    const validateIdx = service.indexOf("validateRequestedColumns(definition, input.columns)");
    const fetchIdx = service.indexOf("await fetcher(");
    expect(validateIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(validateIdx);
  });
});

describe("filters can never grant access - only a target's own declared allowlist is honored", () => {
  it("parseAppliedExportFilters only ever reads keys present in the definition's own supportedFilters", () => {
    const filters = code.get("filters.ts")!;
    expect(filters).toMatch(/allowedIds\.has\(key\)/);
    expect(filters).not.toMatch(/getAdminFirestore|\.collection\(/);
  });
});

describe("no sensitive-data leakage in an Export Center DTO or catalog column", () => {
  it("no property with an identity-value, raw-bank-data, or Drive/credential name is declared anywhere in the module", () => {
    const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber|kyc|driveFileId|webViewLink|signedUrl|driveUrl|password|apiKey|token|credential)\s*\??\s*:/i;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });

  it("no catalog column id/label names a restricted field (case-insensitive substring check against the same forbidden vocabulary)", () => {
    const catalog = raw.get("catalog.ts")!;
    const FORBIDDEN = /pan|aadhaar|bank|ifsc|gstin|kyc|drive|credential|password|token|legalname|sourcediscovery|originlead/i;
    for (const match of catalog.matchAll(/id:\s*"([^"]+)"/g)) expect(match[1], `column id "${match[1]}"`).not.toMatch(FORBIDDEN);
  });

  it("client-dto.ts never imports Firestore or a business module's internals", () => {
    for (const spec of importsOf(raw.get("client-dto.ts")!)) {
      expect(spec, `client-dto imports ${spec}`).not.toMatch(/firebase\/admin|partners\/|campaigns\/|assignments\/|-gate$/);
    }
    expect(code.get("http.ts")).not.toMatch(/firestore/);
  });
});

describe("the raw Storage locator never becomes an ordinary client DTO field", () => {
  it("client-dto.ts and export-service.ts's ExportJobDto/ExportArtifactPayload never carry a `locator` field", () => {
    expect(code.get("client-dto.ts")).not.toMatch(/\blocator\b/i);
  });

  it("artifact-store.ts is the ONLY file that constructs an export-artifacts/ object key", () => {
    for (const [name, source] of code) {
      if (name === "artifact-store.ts") continue;
      expect(source, `${name} constructs a Storage object key directly`).not.toMatch(/export-artifacts\//);
    }
  });

  it("no route returns a signed URL, bucket name, or raw locator - the artifact route streams bytes directly", () => {
    const artifactRoute = readFileSync(path.join(routesDir, "jobs", "[jobRef]", "artifact", "route.ts"), "utf8");
    expect(artifactRoute).not.toMatch(/signedUrl|getSignedUrl|publicUrl|bucket\(/i);
  });
});

describe("private artifact delivery re-authorizes at delivery time", () => {
  it("getExportArtifactForActor re-checks exports access AND actor ownership AND COMPLETED status before ever calling the store", () => {
    const service = raw.get("export-service.ts")!;
    const fn = service.slice(service.indexOf("export async function getExportArtifactForActor"));
    expect(fn).toMatch(/requireExportsAccess\(actor\)/);
    expect(fn).toMatch(/doc\.createdByUserRef !== actor\.userRef/);
    expect(fn).toMatch(/doc\.status !== "COMPLETED"/);
  });
});

describe("format generation uses the same governed decision, never independent per-format authorization", () => {
  it("generate.ts imports no authz/gate/Firestore module of its own", () => {
    for (const spec of importsOf(raw.get("generate.ts")!)) {
      expect(spec, `generate.ts imports ${spec}`).not.toMatch(/authz|-gate|firebase\/admin/);
    }
  });
});

describe("CSV/XLSX formula-injection mitigation is applied", () => {
  it("csv.ts neutralizes a leading =, +, -, @, tab or CR before quoting", () => {
    const csv = code.get("csv.ts")!;
    expect(csv).toMatch(/FORMULA_TRIGGER_CHARS/);
  });
  it("xlsx.ts reuses the SAME neutralization function as csv.ts (not a re-implemented, possibly-divergent copy)", () => {
    expect(raw.get("xlsx.ts")).toMatch(/import\s*\{\s*neutralizeFormulaInjection\s*\}\s*from\s*["']\.\/csv["']/);
  });
});

describe("no production artifact provider / no real Google Drive / no real payment or banking provider call in this module", () => {
  it("no Export Center file or route references Google Drive, OCR, or a bank/payment-gateway SDK", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/googleapis|drive\.files|DriveClient/i);
      expect(source, name).not.toMatch(/\bocr\b/i);
      expect(source, name).not.toMatch(/stripe|razorpay|paypal|plaid|payment-gateway|bank-gateway/i);
    }
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, path.basename(file)).not.toMatch(/googleapis|drive\.files|DriveClient/i);
    }
  });
});

describe("no wildcard permissions, explicit grants only: no role names, no role reads, no rank", () => {
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

describe("no approved Overview page is touched or referenced (UI freeze)", () => {
  const OVERVIEW_SURFACES = [/@\/ui\/Overview/, /@\/ui\/overview\.css/, /OverviewPage/, /OverviewTab/, /overview-model/, /overview-aggregate/, /overview-metrics/, /overview-service/];

  it("no Export Center server file or route imports or names an Overview surface", () => {
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

describe("Reports and Export Center remain separate modules", () => {
  it("no Export Center server file imports from src/server/reports", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(/server\/reports/);
    }
  });

  it("src/app/exports contains exactly the real-UI route (no stray/orphaned page)", () => {
    const exportsAppDir = path.join(appDir, "exports");
    const files = walk(exportsAppDir, (name) => name.endsWith(".tsx"))
      .map((f) => path.relative(srcDir, f).split(path.sep).join("/"))
      .sort();
    expect(files).toEqual(["app/exports/page.tsx"]);
  });
});
