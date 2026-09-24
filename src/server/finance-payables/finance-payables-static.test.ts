import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FINANCE_PAYABLE_COLLECTIONS } from "./firestore";
import { payableHeadDocSchema, payableSourceSnapshotSchema, payableVersionDocSchema } from "./types";

// Step 15A section 21: the STATIC ARCHITECTURE GUARDS of the Finance Payables module. Pure source
// scans (no Firestore) - they fail loudly if a future change wires the wrong thing across a
// boundary. Scope: every non-test .ts file in this module directory and its sub-folders, plus the
// Payables API routes.

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/finance/payables");
const appDir = path.resolve(moduleDir, "../../app");
const srcDir = path.resolve(moduleDir, "../..");

function walk(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, predicate) : predicate(entry.name) ? [full] : [];
  });
}

const moduleFiles = walk(moduleDir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
const routeFiles = walk(routesDir, (name) => name.endsWith(".ts")).sort();

// Executable code only (comments are allowed to explain a boundary by name).
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
  for (const match of source.matchAll(/^import\s+"([^"]+)"/gm)) found.push(match[1]!);
  return found;
}

const code = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), codeOnly(readFileSync(file, "utf8"))] as const));
const raw = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), readFileSync(file, "utf8")] as const));

describe("the scan itself is sound", () => {
  it("finds the module's own foundation files, the routes, and strips comments", () => {
    for (const expected of ["types.ts", "firestore.ts", "ids.ts", "payable-events.ts", "finance-payables-gate.ts", "amount-determination.ts", "source-evidence.ts", "client-dto.ts", "http.ts", "index.ts"]) {
      expect([...code.keys()]).toContain(expected);
    }
    expect(routeFiles.length).toBeGreaterThan(5);
    expect(codeOnly("const a = 1; // campaign\n// assignment\n/* creator */ const b = 2;")).not.toMatch(/campaign|assignment|creator/);
  });
});

describe("a Payable never depends on Campaign / Assignment / Content for commercial authority", () => {
  it("no Payables file imports one of those modules", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(/^@\/server\/(campaigns|assignments|content|analytics|discovery)\//);
    }
    for (const file of routeFiles) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) expect(spec, `${path.basename(file)} imports ${spec}`).not.toMatch(/^@\/server\/(campaigns|assignments|content|analytics|discovery)\//);
    }
  });

  it("no identifier in executable code names a Campaign, Assignment or Creator concept", () => {
    for (const [name, source] of code) expect(source, name).not.toMatch(/\b\w*(campaign|assignment|creator)\w*\b/i);
  });

  it("no upstream source-record identifier is declared as a property anywhere", () => {
    const FORBIDDEN_PROPERTY = /\b(campaignRef|assignmentRef|contentRef|sourceRecordRef|partnerAccountRef|postUrl|analyticsSourceRecordRef)\s*\??\s*:/;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });
});

describe("a Payable can never mutate a Partner Review or an Agreement", () => {
  it("the ONLY Partner Reviews imports are the read-only handoff contract and the pure period module", () => {
    const allowed = new Set(["@/server/partner-reviews/finalized-review-handoff", "@/server/partner-reviews/finalized-review-handoff-service", "@/server/partner-reviews/period"]);
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) {
        if (/partner-reviews/.test(spec)) expect(allowed.has(spec), `${name} imports ${spec}`).toBe(true);
      }
    }
  });

  it("the ONLY Finance Agreements import is its public service barrel - never its Firestore internals", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) {
        if (/finance-agreements/.test(spec)) expect(spec, `${name} imports ${spec}`).toBe("@/server/finance-agreements");
      }
    }
  });

  it("only the module's own Firestore helper performs a write, and it names only Payable collections", () => {
    const allowedCollections = new Set<string>(Object.values(FINANCE_PAYABLE_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowedCollections.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
      if (name === "firestore.ts" || name === "payable-events.ts") continue;
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\bgetAdminFirestore\(\)\s*\.collection/);
    }
  });

  it("every collection name is a Payable one (no partnerReviews / financeAgreements / partners / vendors collection is opened here)", () => {
    for (const value of Object.values(FINANCE_PAYABLE_COLLECTIONS)) expect(value).not.toMatch(/partnerReview|financeAgreement|invoice|payment|settlement/i);
    for (const [name, source] of code) expect(source, name).not.toMatch(/collection\(\s*["'`](partnerReviews|financeAgreements|partners|vendors)["'`]/);
  });
});

// Step 16A: Finance Invoices now exists as its own sibling module under /api/finance/invoices/**,
// with its own static guards (src/server/finance-invoices/finance-invoices-static.test.ts) proving
// it consumes a Payable only through Payables' own public, read-only contract and never mutates
// Payable history. The guards below stay in full force for what they always meant: Payables ITSELF
// never implements Invoice or Payment business logic, never imports an invoice/payment module, and
// Payments still have no implementation anywhere in the codebase.
describe("Payables itself never implements Invoice or Payment business logic", () => {
  it("no Payables file imports a payment module (or, other than the public Finance Invoices barrel, an invoice module) and no invoice/payment collection is opened here", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) {
        expect(spec, `${name} imports ${spec}`).not.toMatch(/(^|\/)payments?(\/|$)/i);
        if (/(^|\/)invoices?(\/|$)/i.test(spec)) expect(spec, `${name} imports ${spec}`).toBe("@/server/finance-invoices");
      }
    }
    for (const [name, source] of code) expect(source, name).not.toMatch(/collection\(\s*["'`](invoices?|payments?|invoiceLines?|settlements?)\b/i);
  });

  it("no Payables file itself imports Finance Invoices at all (the dependency runs the other way: Invoices reads Payables, never the reverse)", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(/finance-invoices/);
    }
  });

  it("Invoices and (Step 17A) Payments each have their own route tree - Finance Invoices'/Payments' own concern, not Payables'; no file under either imports Finance Payables directly", () => {
    for (const sibling of ["invoices", "payments"]) {
      const siblingRoutesDir = path.join(path.dirname(routesDir), sibling);
      if (!existsSync(siblingRoutesDir)) continue;
      for (const file of walk(siblingRoutesDir, (name) => name.endsWith(".ts"))) {
        for (const spec of importsOf(readFileSync(file, "utf8"))) {
          if (/finance-payables/.test(spec)) expect(spec, `${path.basename(file)} imports ${spec}`).toBe("@/server/finance-payables");
        }
      }
    }
  });

  it("READY_FOR_INVOICE is a payable state, never an approval - nothing here models an approval workflow", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\b(approvedAt|approvedByUserRef|approvalStatus|invoiceStatus|paymentStatus|paidAt)\b/);
    }
  });
});

describe("no deletes on Payable data", () => {
  it("there is no delete of any kind (doc, batch, transaction, recursive) anywhere in the module or its routes", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\.delete\s*\(/);
      expect(source, name).not.toMatch(/\b(deleteDoc|recursiveDelete|bulkWriter|deleteCollection)\b/);
    }
    for (const file of routeFiles) {
      // The adjustments route exports a DELETE http method; that is an HTTP verb, not a data delete.
      expect(codeOnly(readFileSync(file, "utf8")), path.basename(file)).not.toMatch(/\.delete\s*\(|recursiveDelete|deleteDoc/);
    }
  });
});

describe("a payable version is immutable once written", () => {
  it("the Firestore helper offers only a CREATE for a version - there is no set/update for one", () => {
    const firestore = code.get("firestore.ts")!;
    expect(firestore).toMatch(/export function txCreatePayableVersion\(/);
    expect(firestore).not.toMatch(/txSetPayableVersion|txUpdatePayableVersion/);
    expect(firestore.match(/financePayableVersionsCollection\(version\.payableRef\)/g)).toHaveLength(1);
  });

  it("every writer creates the NEXT version rather than rewriting one", () => {
    for (const [name, source] of code) {
      if (!/txCreatePayableVersion|txSetPayableHead/.test(source)) continue;
      expect(source, name).not.toMatch(/versionsCollection\([^)]*\)\.doc\([^)]*\)\.(set|update)\(/);
    }
  });
});

describe("explicit grants only: no role names, no role reads, no rank", () => {
  it("never reads actor.role, compares a role name, imports the role catalog, or uses a rank / minimumRole helper", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
      expect(source, name).not.toMatch(/["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
      expect(source, name).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b|\bisAtLeast\w*Role\b/i);
      for (const spec of importsOf(raw.get(name)!)) expect(spec, `${name} imports ${spec}`).not.toMatch(/authz\/roles$/);
    }
  });

  it("the gate authorizes only through canAccessFeature / canPerformAction / canAccessSensitive plus the live Partner/Vendor scope", () => {
    const gate = code.get("finance-payables-gate.ts")!;
    expect(gate).toMatch(/canAccessFeature\(actor, "finance"\)/);
    expect(gate).toMatch(/canPerformAction\(actor, "finance", action\)/);
    expect(gate).toMatch(/canAccessSensitive\(actor, FINANCE_AMOUNTS_CATEGORY\)/);
    expect(gate).toMatch(/isPartnerDocInScope/);
    expect(gate).toMatch(/isVendorDocInScope/);
  });

  it("no route re-implements authorization: each one resolves the actor and calls a service", () => {
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.basename(file)).toMatch(/resolveRequestActor\(\)/);
      expect(source, path.basename(file)).not.toMatch(/canAccessFeature|canPerformAction|canAccessSensitive|getActorScopeGrants|getAdminFirestore/);
    }
  });
});

describe("data safety: no restricted identity value, no raw Agreement text, no scope field in a DTO", () => {
  it("no property with an identity-value name is declared anywhere in the module", () => {
    const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber)\s*\??\s*:/;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });

  it("the stored shapes contain no identity value, no raw Agreement clause text and no upstream record id", () => {
    const names = new Set<string>();
    const walkSchema = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walkSchema);
      else if (node && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (key === "properties" && child && typeof child === "object") Object.keys(child).forEach((property) => names.add(property));
          walkSchema(child);
        }
      }
    };
    for (const schema of [payableSourceSnapshotSchema, payableVersionDocSchema, payableHeadDocSchema]) walkSchema(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
    expect(names.size).toBeGreaterThan(30);
    expect([...names].filter((n) => /^(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|gstin|gstNumber|servicesMandated|monetisationTerms|renewalTerms|noticeTerms|terminationTerms|contactSnapshot|identityStatusSnapshot|assignmentRef|campaignRef|contentRef)$/i.test(n))).toEqual([]);
  });

  it("the DTO builder never imports Firestore, the gate or an owning module, and never exposes a scope field", () => {
    for (const spec of importsOf(raw.get("client-dto.ts")!)) {
      expect(spec, `client-dto imports ${spec}`).not.toMatch(/\.\/firestore$|firebase\/admin|partners\/|vendors\/|-gate$|authz\//);
    }
    const dto = code.get("client-dto.ts")!;
    for (const scopeField of ["ownerUid", "regionIds", "teamIds", "partnerUid", "vendorUid"]) expect(dto, `client-dto exposes ${scopeField}`).not.toMatch(new RegExp(`\\b${scopeField}\\b`));
    expect(code.get("http.ts")).not.toMatch(/firestore/);
  });

  it("every money figure in a DTO passes through the amounts gate (no raw doc figure is copied)", () => {
    const dto = code.get("client-dto.ts")!;
    // Object-literal properties only (a trailing comma); a `field: Type;` declaration is not a copy.
    const copies = [...dto.matchAll(/amountMinor(?:Signed)?:\s*([^,\n;]+),/g)];
    expect(copies.length).toBeGreaterThan(4);
    for (const match of copies) expect(match[1]!.trim(), `client-dto copies a raw amount: ${match[0]}`).toMatch(/^(amount|nullableAmount)\(/);
  });
});

describe("no approved Overview page is touched or referenced (section 21 UI freeze)", () => {
  // Nothing in the Payables module, its routes, or (as of Step 15B) its UI may import, render or
  // otherwise reach an approved Overview surface. This guard makes that a permanent property rather
  // than a one-off review note.
  const OVERVIEW_SURFACES = [/@\/ui\/Overview/, /@\/ui\/overview\.css/, /OverviewPage/, /OverviewTab/, /overview-model/, /overview-aggregate/, /overview-metrics/, /overview-service/];

  it("no Payables server file or route imports or names an Overview surface", () => {
    for (const [name, source] of raw) {
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${name} references ${pattern}`).toBe(false);
    }
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${path.basename(file)} references ${pattern}`).toBe(false);
    }
  });

  // Step 15B built the Payables UI (src/features/finance-payables/** plus the three
  // src/app/finance/payables/** routes). This guard keeps the wiring CONTAINED: every component that
  // imports the Payables backend lives under one of those two trees - and none of them references an
  // Overview surface (the file-content check above already proves this at the source level; this one
  // proves it structurally, so a future Payables component can never sneak Overview wiring in through
  // a path the first check doesn't scan).
  it("every component wired to the Payables backend lives under the Payables UI, and none of it touches an approved Overview surface", () => {
    const componentFiles = [...walk(appDir, (name) => name.endsWith(".tsx")), ...walk(path.join(srcDir, "features"), (name) => name.endsWith(".tsx")), ...walk(path.join(srcDir, "ui"), (name) => name.endsWith(".tsx"))];
    expect(componentFiles.length).toBeGreaterThan(20);
    const wired = componentFiles.filter((file) => importsOf(readFileSync(file, "utf8")).some((spec) => spec.startsWith("@/server/finance-payables")));
    expect(wired.length).toBeGreaterThan(0);

    const payablesAppDir = path.join(appDir, "finance", "payables");
    const payablesFeatureDir = path.join(srcDir, "features", "finance-payables");
    for (const file of wired) {
      const contained = file.startsWith(payablesAppDir + path.sep) || file.startsWith(payablesFeatureDir + path.sep);
      expect(contained, `${file} is wired to the Payables backend but lives outside the Payables UI`).toBe(true);
      const source = readFileSync(file, "utf8");
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${path.basename(file)} references ${pattern}`).toBe(false);
    }

    expect(existsSync(payablesFeatureDir)).toBe(true);
  });
});
