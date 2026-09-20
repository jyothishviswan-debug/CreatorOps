import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 12F: static guards over the sources that make up the Partners Analytics
// workspace and the shared Analytics tab / page-shell contract. Like 12E's
// Partner drill-down it is a read-only Analytics composition:
//   - it imports nothing from Partner Reviews, Finance or the Analytics import
//     service / pipeline / module;
//   - it renders no upload / execute / Import CTA;
//   - it has no Agreement / commercial-policy vocabulary;
//   - its server files perform no Firestore write;
//   - Tier is NEVER used as targeting: no `tier` appears in any new file's code
//     (Target Audience is the only audience filter, canonical values only);
//   - the interactive client component imports no server runtime module beyond
//     the import-free URL writer.
const root = path.resolve(import.meta.dirname, "../../..");
const CLIENT_AND_SERVER_FILES = [
  "src/app/analytics/partners/page.tsx",
  "src/app/api/analytics/partners/search/route.ts",
  "src/features/analytics/PartnersAnalyticsPage.tsx",
  "src/features/analytics/AnalyticsPartnersWorkspace.tsx",
  "src/features/analytics/PartnersWorkspaceControls.tsx",
  "src/features/analytics/AnalyticsPageShell.tsx",
  "src/features/analytics/AnalyticsTabs.tsx",
  "src/features/analytics/analytics-tabs.ts",
  "src/server/analytics/partners-workspace-service.ts",
  "src/server/analytics/partners-workspace-dto.ts",
  "src/server/analytics/partners-workspace-metrics.ts",
  "src/server/analytics/partners-workspace-params.ts",
  "src/server/analytics/partners-workspace-links.ts",
  "src/server/analytics/reporting-month.ts",
];
const SERVER_FILES = CLIENT_AND_SERVER_FILES.filter((file) => file.startsWith("src/server/") || file.startsWith("src/app/api/"));

function codeOf(file: string): string {
  const source = readFileSync(path.join(root, file), "utf8");
  // strip comments so prose in header comments cannot trip / mask a real reference
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Partners Analytics workspace is read-only Analytics - no Partner Reviews / Finance / import coupling", () => {
  for (const file of CLIENT_AND_SERVER_FILES) {
    it(`${file} exists`, () => {
      expect(existsSync(path.join(root, file))).toBe(true);
    });

    const code = codeOf(file);

    it(`${file}: imports nothing from partner-reviews, finance, or the import service/pipeline/module`, () => {
      const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/partner-reviews|finance|import-service|import-pipeline|import-history|\/imports(\/|$)|features\/imports|xlsx/i);
      }
      expect(code).not.toMatch(/executeAnalyticsImport|dryRunAnalyticsImport|requireImportsModuleAccess|requireAnalyticsManageAccess/);
    });

    it(`${file}: renders no upload / execute / Import CTA control`, () => {
      expect(code).not.toMatch(/type=["']file["']/);
      expect(code).not.toMatch(/Import data|Upload|Execute import|module=analytics|href=["']\/imports/);
    });

    it(`${file}: has no Agreement / commercial-policy vocabulary`, () => {
      expect(code).not.toMatch(/agreement|target context|commercial|affectsPayment|payout|invoice/i);
    });

    it(`${file}: never uses Tier as targeting (no tier anywhere in its code)`, () => {
      expect(code).not.toMatch(/\btier\b/i);
    });
  }

  for (const file of SERVER_FILES) {
    it(`${file}: performs no Firestore write`, () => {
      const code = codeOf(file);
      expect(code).not.toMatch(/\)\s*\.(set|update|add|delete|create)\s*\(|runTransaction|\.batch\s*\(|FieldValue/);
    });
  }

  it("the interactive client component imports no server runtime module other than the import-free URL writer", () => {
    const source = readFileSync(path.join(root, "src/features/analytics/PartnersWorkspaceControls.tsx"), "utf8");
    expect(source.startsWith('"use client"')).toBe(true);
    const serverImports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["'](@\/server\/[^"']+)["']/gm)].map((m) => ({ typeOnly: Boolean(m[1]), spec: m[2]! }));
    for (const { typeOnly, spec } of serverImports) {
      if (typeOnly) continue;
      // the shared multi-selects (their own client files) and the URL writer are the only runtime server-path imports
      expect(["@/server/analytics/partners-workspace-links"], `runtime import of ${spec}`).toContain(spec);
    }
  });

  it("the URL writer is import-free at runtime (safe in a client bundle)", () => {
    const code = codeOf("src/server/analytics/partners-workspace-links.ts");
    const runtimeImports = [...code.matchAll(/^import\s+(?!type\b)[^;]*from\s+["']([^"']+)["']/gm)];
    expect(runtimeImports).toEqual([]);
  });
});

describe("the Analytics tab row is ONE shared component + constant, used by every Analytics page", () => {
  const PAGES = [
    "src/app/analytics/page.tsx",
    "src/features/analytics/PlatformAnalyticsPage.tsx",
    "src/features/analytics/PartnerAnalyticsPage.tsx",
    "src/features/analytics/PartnersAnalyticsPage.tsx",
    "src/app/analytics/explorer/page.tsx",
    "src/app/analytics/import-history/page.tsx",
  ];
  for (const file of PAGES) {
    it(`${file} renders its tab row and frame ONLY through AnalyticsPageShell (no own ModuleTabs / AppShell)`, () => {
      const code = codeOf(file);
      expect(code).toMatch(/AnalyticsPageShell|AnalyticsAccessDenied/);
      expect(code).not.toMatch(/<ModuleTabs|<AppShell|ANALYTICS_TABS/);
    });
  }
  it("the shell puts the head AND the tab row inside the same `ov-page` frame", () => {
    const code = codeOf("src/features/analytics/AnalyticsPageShell.tsx");
    const frame = code.indexOf('className="ov-page"');
    expect(frame).toBeGreaterThan(-1);
    expect(code.indexOf('className="head"')).toBeGreaterThan(frame);
    expect(code.indexOf("<AnalyticsTabs />")).toBeGreaterThan(code.indexOf('className="head"'));
    expect(code.indexOf("</div>", code.indexOf("<AnalyticsTabs />"))).toBeGreaterThan(code.indexOf("<AnalyticsTabs />"));
  });
  it("AnalyticsTabs renders the shared ModuleTabs with the one ANALYTICS_TABS constant", () => {
    const code = codeOf("src/features/analytics/AnalyticsTabs.tsx");
    expect(code).toMatch(/<ModuleTabs tabs=\{ANALYTICS_TABS\}/);
  });
});
