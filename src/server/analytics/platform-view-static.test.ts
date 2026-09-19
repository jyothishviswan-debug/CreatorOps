import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 12D: the platform views expose NO import surface. A static guard over
// the sources that make up the Instagram / YouTube views: none may import the
// Analytics import service / pipeline / the Imports module, and none may
// render an upload/execute control or an Import CTA. Import execution
// remains only under /imports (Import Center).
const root = path.resolve(import.meta.dirname, "../../..");
const FILES = [
  "src/app/analytics/instagram/page.tsx",
  "src/app/analytics/youtube/page.tsx",
  "src/features/analytics/PlatformAnalyticsPage.tsx",
  "src/features/analytics/AnalyticsPlatformView.tsx",
  "src/features/analytics/platform-view-helpers.ts",
  "src/server/analytics/platform-view-service.ts",
  "src/server/analytics/platform-view-dto.ts",
  "src/server/analytics/platform-view-metrics.ts",
];

describe("platform views have no import surface", () => {
  for (const file of FILES) {
    const source = readFileSync(path.join(root, file), "utf8");
    // strip comments so prose in header comments cannot trip / mask a real reference
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    it(`${file}: imports nothing from the import service/pipeline or the imports module`, () => {
      const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/import-service|import-pipeline|analytics-gate-imports|\/imports(\/|$)|features\/imports|xlsx/);
      }
      expect(code).not.toMatch(/executeAnalyticsImport|dryRunAnalyticsImport|requireImportsModuleAccess|requireAnalyticsManageAccess/);
    });

    it(`${file}: renders no upload / execute / Import CTA control`, () => {
      expect(code).not.toMatch(/type=["']file["']/);
      expect(code).not.toMatch(/Import data|Upload|Execute import|module=analytics|href=["']\/imports/);
    });
  }
});
