import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 13B: static boundaries of the Partner Reviews UI (pure source scans - no Firestore). They fail loudly if
// a later change wires the wrong thing across a boundary: fixtures, Finance vocabulary/imports, the evidence
// collector from a list path, forbidden terminology, blended scores, or a write API on a read route.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const moduleDir = import.meta.dirname;

function walk(dir: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, accept));
    else if (accept(entry.name)) files.push(full);
  }
  return files;
}

const isSource = (name: string) => /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name);

const featureFiles = walk(path.join(repoRoot, "src/features/partner-reviews"), isSource);
const pageFiles = walk(path.join(repoRoot, "src/app/partner-reviews"), isSource);
const routeFiles = walk(path.join(repoRoot, "src/app/api/partner-reviews"), isSource);
const uiFiles = [...featureFiles, ...pageFiles];

function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) found.push(match[1]!);
  for (const match of source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) found.push(match[1]!);
  return found;
}

// The visible strings of a UI source: quoted literals, template literals and JSX text.
function visibleText(file: string): string[] {
  const source = code(file);
  const texts: string[] = [];
  for (const match of source.matchAll(/"([^"\n]*)"/g)) texts.push(match[1]!);
  for (const match of source.matchAll(/`([^`]*)`/g)) texts.push(match[1]!.replace(/\$\{[^}]*\}/g, ""));
  for (const match of source.matchAll(/>([^<>{};=]+)</g)) if (!/\breturn\b|=>|\bconst\b/.test(match[1]!)) texts.push(match[1]!);
  return texts;
}

describe("no fixture / demo data remains in the Partner Reviews module", () => {
  it("the fixture module is gone and nothing references it", () => {
    expect(existsSync(path.join(repoRoot, "src/features/partner-reviews/fixtures"))).toBe(false);
    for (const file of [...uiFiles, ...routeFiles]) expect({ file: path.relative(repoRoot, file), imports: importsOf(code(file)).filter((spec) => /fixtures/.test(spec)) }).toEqual({ file: path.relative(repoRoot, file), imports: [] });
  });

  it("no UI file renders sample / illustrative wording", () => {
    expect(uiFiles.length).toBeGreaterThan(10);
    for (const file of uiFiles) {
      for (const text of visibleText(file)) expect({ file: path.basename(file), text: /sample data|illustrative|lorem|demo data|preview only/i.test(text) ? text : null }).toEqual({ file: path.basename(file), text: null });
    }
  });
});

describe("Finance boundary (UI, routes and pages)", () => {
  // The ONLY payment vocabulary permitted: the accepted markers. Everything else that says
  // finance / payable / invoice / payment is a violation.
  const ALLOWED = /affectsPayment|payment-affecting|Payment-affecting|does not affect payment/g;

  it("no Partner Reviews UI, page or route source mentions Finance, Payables, Invoices or Payments beyond the accepted markers", () => {
    for (const file of [...uiFiles, ...routeFiles]) {
      const stripped = code(file).replace(ALLOWED, "");
      expect({ file: path.relative(repoRoot, file), hit: /finance|payable|invoice|payment|payee/i.exec(stripped)?.[0] ?? null }).toEqual({ file: path.relative(repoRoot, file), hit: null });
    }
  });

  it("nothing imports a Finance / Imports module", () => {
    for (const file of [...uiFiles, ...routeFiles]) {
      const bad = importsOf(code(file)).filter((spec) => /finance|features\/imports|server\/imports|payable|invoice/i.test(spec));
      expect({ file: path.relative(repoRoot, file), bad }).toEqual({ file: path.relative(repoRoot, file), bad: [] });
    }
  });

  it("no rendered text offers a Payable / Invoice / Payment control or amount", () => {
    for (const file of uiFiles.filter((f) => f.endsWith(".tsx"))) {
      for (const text of visibleText(file)) {
        const cleaned = text.replace(/Target monitoring only · does not affect payment/g, "").replace(/[Pp]ayment-affecting/g, "");
        expect({ file: path.basename(file), text: /payable|invoice|payment|₹|\$\d|INR|USD/i.test(cleaned) ? text : null }).toEqual({ file: path.basename(file), text: null });
      }
    }
  });
});

describe("terminology", () => {
  it("no rendered Partner Reviews text says Creator or Deliverable, and 'Productivity' appears only in the required 'Monthly productivity history' header", () => {
    for (const file of uiFiles.filter((f) => f.endsWith(".tsx") || f.endsWith("format.ts") || f.endsWith("overview-model.ts"))) {
      for (const text of visibleText(file)) {
        expect({ file: path.basename(file), text: /\bcreators?\b|\bdeliverables?\b/i.test(text) ? text : null }).toEqual({ file: path.basename(file), text: null });
        const withoutAllowed = text.replace(/Monthly productivity history/g, "");
        expect({ file: path.basename(file), text: /productivity/i.test(withoutAllowed) ? text : null }).toEqual({ file: path.basename(file), text: null });
      }
    }
  });

  it("no blended score / rating / tier / ranking wording is ever rendered", () => {
    for (const file of uiFiles.filter((f) => f.endsWith(".tsx") || f.endsWith("format.ts") || f.endsWith("overview-model.ts"))) {
      for (const text of visibleText(file)) {
        // "no composite score" style DISCLAIMERS are allowed; an actual score/rating/tier/rank label is not.
        const cleaned = text.replace(/no (?:composite |blended |overall )?(?:performance |productivity |compliance )?score|never a composite score|no (?:overall )?productivity (?:line or )?score|no overall score|no compliance score|no performance score|no productivity score|no blended ranking|no overall|never blended|never combined/gi, "");
        expect({ file: path.basename(file), text: /\b(score|rating|tier|ranking|rank)\b/i.test(cleaned) ? text : null }).toEqual({ file: path.basename(file), text: null });
      }
    }
  });
});

describe("the UI read services never reach the evidence collector, the freshness evaluator or a mutation service", () => {
  const UI_SERVICES = ["partner-review-workspace-service.ts", "partner-review-overview-service.ts", "partner-review-history-service.ts", "review-scan.ts", "review-view-context.ts", "review-rows.ts", "overview-aggregate.ts", "partner-history-model.ts", "needs-review-candidates.ts", "ui-params.ts", "ui-dto.ts"];

  function reachable(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(readFileSync(path.join(moduleDir, file), "utf8"))) {
        const local = spec.startsWith("./") ? spec.slice(2) : spec.startsWith("@/server/partner-reviews/") ? spec.slice("@/server/partner-reviews/".length) : null;
        if (local && existsSync(path.join(moduleDir, `${local}.ts`))) queue.push(`${local}.ts`);
      }
    }
    return seen;
  }

  it("the transitive imports of every UI service exclude collector, builder, fingerprint/freshness evaluator, source-access, the per-review service, lifecycle service and the hint writer", () => {
    for (const entry of UI_SERVICES) {
      const graph = reachable(entry);
      for (const forbidden of ["evidence-collector.ts", "evidence-builder.ts", "fingerprint.ts", "source-access.ts", "partner-review-service.ts", "partner-review-lifecycle-service.ts", "freshness-hint.ts"]) {
        expect({ entry, forbidden, reached: graph.has(forbidden) }).toEqual({ entry, forbidden, reached: false });
      }
    }
    // Sanity: the walker really walks.
    expect(reachable("partner-review-workspace-service.ts").has("review-scan.ts")).toBe(true);
  });

  it("their executable code names no collector / freshness / mutation function", () => {
    for (const entry of UI_SERVICES) {
      expect({ entry, hit: /collectPartnerEvidence|evaluateFreshness|freshnessFor|recordFreshnessHint|generatePartnerReviewDraft|refreshPartnerReviewEvidence|finalizePartnerReview|submitPartnerReviewForReview|createPartnerReviewRevision/.exec(code(path.join(moduleDir, entry)))?.[0] ?? null }).toEqual({ entry, hit: null });
    }
  });

  it("only the single-review services write the freshness hint, and only the accepted mutation services write a head/version", () => {
    const writers = readdirSync(moduleDir)
      .filter((name) => isSource(name))
      .filter((name) => /\btx\.(set|create|update|delete)\(|runTransaction|\.update\(\{|\.delete\(\)/.test(code(path.join(moduleDir, name))))
      .sort();
    // freshness-hint.ts (single-field update), the two mutation services, the event appender and dev/test seeding-free helpers.
    expect(writers).toEqual(["freshness-hint.ts", "partner-review-events.ts", "partner-review-lifecycle-service.ts", "partner-review-service.ts"]);
  });
});

describe("Workspace / search API routes are read-only", () => {
  it("expose GET only and no write API of any kind", () => {
    for (const rel of ["workspace/route.ts", "partners/search/route.ts"]) {
      const source = code(path.join(repoRoot, "src/app/api/partner-reviews", rel));
      expect({ rel, exports: [...source.matchAll(/export async function (\w+)/g)].map((match) => match[1]) }).toEqual({ rel, exports: ["GET"] });
      expect({ rel, write: /\.(set|create|update|delete|add)\(|runTransaction|batch\(/.test(source) }).toEqual({ rel, write: false });
    }
  });
});

describe("no blended score anywhere in the new stored or DTO shapes", () => {
  it("summary / display / row / DTO sources carry no score-like key", () => {
    for (const name of ["review-list-summary.ts", "ui-dto.ts", "overview-aggregate.ts", "partner-history-model.ts", "partner-review-workspace-service.ts", "partner-review-overview-service.ts", "partner-review-history-service.ts"]) {
      const keys = [...code(path.join(moduleDir, name)).matchAll(/\b([A-Za-z_]\w*)\s*[?]?:/g)].map((match) => match[1]!);
      expect({ name, keys: keys.filter((key) => /(score|rating|overall|blended|composite|weighted|rank)/i.test(key)) }).toEqual({ name, keys: [] });
    }
  });
});
