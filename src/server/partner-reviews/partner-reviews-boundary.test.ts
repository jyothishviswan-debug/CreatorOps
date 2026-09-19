import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Step 13A.1: static architecture boundaries of the Partner Reviews module.
// Pure source scans (no Firestore) - they fail loudly if a future change
// wires the wrong thing across a boundary.

const moduleDir = import.meta.dirname;

function readModule(name: string): string {
  return readFileSync(path.join(moduleDir, name), "utf8");
}

// Executable code only (comments are allowed to explain the boundary by name).
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// Every module specifier imported/re-exported/dynamically imported by a source file.
function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) found.push(match[1]!);
  for (const match of source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)) found.push(match[1]!);
  for (const match of source.matchAll(/^import\s+"([^"]+)"/gm)) found.push(match[1]!);
  return found;
}

// Transitive closure over this module's own files (relative "./x" and the
// "@/server/partner-reviews/x" alias).
function reachableModuleFiles(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(readModule(file))) {
      const local = spec.startsWith("./") ? spec.slice(2) : spec.startsWith("@/server/partner-reviews/") ? spec.slice("@/server/partner-reviews/".length) : null;
      if (local) queue.push(`${local}.ts`);
    }
  }
  return seen;
}

function externalImportsOf(files: Iterable<string>): string[] {
  const all: string[] = [];
  for (const file of files) for (const spec of importsOf(readModule(file))) if (!spec.startsWith("./") && !spec.startsWith("@/server/partner-reviews/")) all.push(spec);
  return all;
}

describe("list/head service boundary (Step 13A.1 section 5)", () => {
  const listGraph = reachableModuleFiles("partner-review-list-service.ts");

  it("the list service never reaches the evidence collector, builder, fingerprint/freshness evaluator, source-access resolver or the per-review services", () => {
    for (const forbidden of ["evidence-collector.ts", "evidence-builder.ts", "fingerprint.ts", "source-access.ts", "partner-review-service.ts", "partner-review-lifecycle-service.ts"]) {
      expect(listGraph.has(forbidden)).toBe(false);
    }
    // Sanity: the walker really walks (a broken walker must not pass silently).
    expect(listGraph.has("firestore.ts")).toBe(true);
    expect(listGraph.has("client-dto.ts")).toBe(true);
    expect(listGraph.has("partner-reviews-gate.ts")).toBe(true);
  });

  it("nothing reachable from the list service imports an upstream Assignment/Content/Analytics/Campaign reader", () => {
    const external = externalImportsOf(listGraph);
    expect(external.length).toBeGreaterThan(3);
    expect(external.filter((spec) => /^@\/server\/(analytics|assignments|content|campaigns)\//.test(spec))).toEqual([]);
  });

  it("the per-review service is the ONLY place freshness is evaluated, and it does not re-implement list logic", () => {
    const service = readModule("partner-review-service.ts");
    expect(service).toMatch(/evaluateFreshness/);
    expect(service).toMatch(/from "\.\/partner-review-list-service"/);
    expect(service).not.toMatch(/listPartnerReviewHeadDocs/);
    expect(codeOnly(readModule("partner-review-list-service.ts"))).not.toMatch(/evaluateFreshness|collectPartnerEvidence|freshnessFor|includeFreshness/);
  });
});

describe("canonical evidence stays actor-independent (Step 13A.1 section 2)", () => {
  it("the collector, builder, fingerprint and period modules import no authz/actor/scope module and mention no actor", () => {
    for (const file of ["evidence-collector.ts", "evidence-builder.ts", "fingerprint.ts", "period.ts"]) {
      const source = readModule(file);
      expect({ file, authz: importsOf(source).filter((spec) => /authz|partners-gate|-gate/.test(spec)) }).toEqual({ file, authz: [] });
      const code = codeOnly(source);
      expect({ file, actorTypeUsed: /ActorContext|actorUid|getActorScopeGrants|hasGlobalScope/.test(code) }).toEqual({ file, actorTypeUsed: false });
    }
  });

  it("collectPartnerEvidence's parameters are (partnerRef, period, options) - no actor parameter", () => {
    const source = readModule("evidence-collector.ts");
    expect(source).toMatch(/export async function collectPartnerEvidence\(partnerRef: string, period: ReviewPeriod, options: \{ now\?: \(\) => Date \} = \{\}\)/);
  });

  it("redaction is applied only when building the actor-facing DTO: the collector/builder/fingerprint never import the redaction module", () => {
    for (const file of ["evidence-collector.ts", "evidence-builder.ts", "fingerprint.ts", "partner-review-events.ts"]) {
      expect({ file, redaction: importsOf(readModule(file)).filter((spec) => /source-context-redaction|source-access/.test(spec)) }).toEqual({ file, redaction: [] });
    }
  });
});

describe("every snapshot-carrying response is built through the redaction (Step 13A.1 section B)", () => {
  const nonTestFiles = readdirSync(moduleDir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));

  it("toPartnerReviewVersionDto is called in exactly one place (buildActorVersionDto), which redacts first", () => {
    const callers = nonTestFiles.filter((file) => file !== "client-dto.ts" && /toPartnerReviewVersionDto\(/.test(readModule(file)));
    expect(callers).toEqual(["partner-review-service.ts"]);
    const service = readModule("partner-review-service.ts");
    expect(service.match(/toPartnerReviewVersionDto\(/g)).toHaveLength(1);
    expect(service).toMatch(/resolveActorSourceAccess\(actor, version\.snapshot\)[\s\S]{0,120}toPartnerReviewVersionDto\(version, redactVersionForActor\(version, access\)\)/);
  });

  it("buildReviewDetail requires an actor, and every caller passes one", () => {
    expect(readModule("partner-review-service.ts")).toMatch(/export async function buildReviewDetail\(args: \{\s*actor: ActorContext;/);
    for (const file of nonTestFiles) {
      const source = readModule(file);
      for (const call of source.matchAll(/buildReviewDetail\(\{([^}]*)\}\)/g)) expect({ file, call: call[1] }).toEqual({ file, call: expect.stringContaining("actor:") });
    }
  });

  it("no route returns the stored version doc's snapshot/sourceRefs directly", () => {
    const routesDir = path.resolve(moduleDir, "../../app/api/partner-reviews");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(routesDir);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect({ file: path.relative(routesDir, file), rawDoc: /\.snapshot\b|sourceRefs|getPartnerReviewVersionDoc|partnerReviewVersionsCollection/.test(source) }).toEqual({ file: path.relative(routesDir, file), rawDoc: false });
    }
  });
});

describe("finalize freshness guard is wired before the transaction (Step 13A.1 section C)", () => {
  it("finalizePartnerReview checks preconditions, then recomputes the fingerprint, then opens the transaction, and never refreshes", () => {
    const source = readModule("partner-review-lifecycle-service.ts");
    const body = source.slice(source.indexOf("export async function finalizePartnerReview("), source.indexOf("// ---- Create revision"));
    const stale = body.indexOf("partnerReviewsStaleResult()");
    const invalid = body.indexOf("Only an In Review version can be finalized");
    const collect = body.indexOf("collectPartnerEvidence(");
    const tx = body.indexOf("db.runTransaction");
    expect(stale).toBeGreaterThan(-1);
    expect(stale).toBeLessThan(collect);
    expect(invalid).toBeLessThan(collect);
    expect(collect).toBeLessThan(tx);
    expect(body).toMatch(/REFRESH_REQUIRED/);
    expect(body).not.toMatch(/refreshPartnerReviewEvidence/);
    expect(body.slice(0, tx)).toMatch(/partnerReviewsNotReadyResult\(/);
  });
});

describe("commercial policy seam boundary (Step 13A.1 revised)", () => {
  const nonTestFiles = readdirSync(moduleDir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));

  it("the governing policy is fetched in exactly one place - the trusted evidence collector - never by a service, route or client payload", () => {
    const callers = nonTestFiles.filter((file) => file !== "commercial-policy.ts" && /getGoverningCommercialPolicy\(/.test(codeOnly(readModule(file))));
    expect(callers).toEqual(["evidence-collector.ts"]);

    const routesDir = path.resolve(moduleDir, "../../app/api/partner-reviews");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []));
    for (const file of walk(routesDir)) {
      expect({ file: path.relative(routesDir, file), policy: /commercial-policy|CommercialPolicy|commercialPolicy/.test(readFileSync(file, "utf8")) }).toEqual({ file: path.relative(routesDir, file), policy: false });
    }
  });

  it("no service input schema accepts a policy, requirement, rule or target (nothing Agreement-governed is ever client-supplied or manually editable)", () => {
    for (const file of ["partner-review-service.ts", "partner-review-lifecycle-service.ts", "finalized-review-handoff-service.ts"]) {
      const code = codeOnly(readModule(file));
      expect({ file, hit: /requiredCount|lfcSfc|targetValue|monthlyDeliverableRequirement|commercialPolicy|byFormat/.test(code) }).toEqual({ file, hit: false });
    }
  });

  it("the policy provider seam is never imported by the list service graph, and neither is the commercial builder or the handoff", () => {
    const listGraph = reachableModuleFiles("partner-review-list-service.ts");
    for (const forbidden of ["commercial-policy.ts", "commercial-builder.ts", "finalized-review-handoff.ts", "finalized-review-handoff-service.ts"]) expect(listGraph.has(forbidden)).toBe(false);
  });

  it("the builder, fingerprint and redaction stay actor-independent with the commercial modules (no authz/actor import or mention)", () => {
    for (const file of ["commercial-policy.ts", "commercial-builder.ts", "commercial-neutral.ts", "finalized-review-handoff.ts"]) {
      const source = readModule(file);
      expect({ file, authz: importsOf(source).filter((spec) => /authz|partners-gate|-gate/.test(spec)) }).toEqual({ file, authz: [] });
      expect({ file, actorTypeUsed: /ActorContext|actorUid|getActorScopeGrants|hasGlobalScope/.test(codeOnly(source)) }).toEqual({ file, actorTypeUsed: false });
    }
  });

  it("the handoff service uses the read-only feature + live Partner scope chain (no action) and never a write path", () => {
    const code = codeOnly(readModule("finalized-review-handoff-service.ts"));
    expect(code.match(/loadAuthorizedReview\(actor, reviewRef, null\)/g)).toHaveLength(2);
    expect(code).not.toMatch(/requirePartnerReviewsAccess|runTransaction|\.set\(|\.update\(|\.create\(|\.delete\(/);
    // Same visibility rule as every other read: the actor-scoped redaction is not needed
    // because the handoff carries no source-record identifiers (asserted on the DTO).
    expect(code).not.toMatch(/resolveActorSourceAccess|redactVersionForActor/);
  });
});
