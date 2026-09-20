import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 12E: static guards over the sources that make up the Partner Analytics
// drill-down. It is a read-only Analytics composition:
//   - it imports nothing from Partner Reviews, Finance or the Analytics
//     import pipeline (no commercial-policy / payment coupling);
//   - it renders no upload / execute / Import CTA;
//   - it has NO Agreement / target section (there is no accepted safe read path
//     for Agreement targets at this baseline);
//   - its server files perform no Firestore writes at all.
const root = path.resolve(import.meta.dirname, "../../..");
const CLIENT_AND_SERVER_FILES = [
  "src/app/analytics/partner/[partnerId]/page.tsx",
  "src/features/analytics/PartnerAnalyticsPage.tsx",
  "src/features/analytics/AnalyticsPartnerView.tsx",
  "src/server/analytics/partner-view-service.ts",
  "src/server/analytics/partner-view-dto.ts",
  "src/server/analytics/partner-view-metrics.ts",
  "src/server/analytics/partner-view-links.ts",
];
const SERVER_FILES = CLIENT_AND_SERVER_FILES.filter((file) => file.startsWith("src/server/"));

function codeOf(file: string): string {
  const source = readFileSync(path.join(root, file), "utf8");
  // strip comments so prose in header comments cannot trip / mask a real reference
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Partner Analytics is read-only Analytics - no Partner Reviews / Finance / import coupling", () => {
  for (const file of CLIENT_AND_SERVER_FILES) {
    it(`${file} exists`, () => {
      expect(existsSync(path.join(root, file))).toBe(true);
    });

    const code = codeOf(file);

    it(`${file}: imports nothing from partner-reviews, finance, or the import service/pipeline/module`, () => {
      const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/partner-reviews|finance|import-service|import-pipeline|\/imports(\/|$)|features\/imports|xlsx/i);
      }
      expect(code).not.toMatch(/executeAnalyticsImport|dryRunAnalyticsImport|requireImportsModuleAccess|requireAnalyticsManageAccess/);
    });

    it(`${file}: renders no upload / execute / Import CTA control`, () => {
      expect(code).not.toMatch(/type=["']file["']/);
      expect(code).not.toMatch(/Import data|Upload|Execute import|module=analytics|href=["']\/imports/);
    });

    it(`${file}: has no Agreement / target section and no commercial-policy vocabulary`, () => {
      expect(code).not.toMatch(/agreement|target context|commercial|affectsPayment|payout|invoice/i);
    });
  }

  for (const file of SERVER_FILES) {
    it(`${file}: performs no Firestore write`, () => {
      const code = codeOf(file);
      expect(code).not.toMatch(/\)\s*\.(set|update|add|delete|create)\s*\(|runTransaction|\.batch\s*\(|FieldValue/);
    });
  }
});
