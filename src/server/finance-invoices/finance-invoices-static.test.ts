import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FINANCE_INVOICE_COLLECTIONS } from "./firestore";
import { invoiceHeadDocSchema, invoiceVersionDocSchema } from "./types";

// Step 16A section 23: the STATIC ARCHITECTURE GUARDS of the Finance Invoices module. Pure source
// scans (no Firestore) - they fail loudly if a future change wires the wrong thing across a
// boundary. Scope: every non-test .ts file in this module directory and its sub-folders, plus the
// Invoices API routes. Mirrors Payables' own finance-payables-static.test.ts.

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/finance/invoices");
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
  for (const match of source.matchAll(/^import\s+"([^"]+)"/gm)) found.push(match[1]!);
  return found;
}

const moduleFiles = walk(moduleDir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
const routeFiles = walk(routesDir, (name) => name.endsWith(".ts")).sort();

const code = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), codeOnly(readFileSync(file, "utf8"))] as const));
const raw = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), readFileSync(file, "utf8")] as const));

describe("the scan itself is sound", () => {
  it("finds the module's own foundation files, the routes, and strips comments", () => {
    for (const expected of ["types.ts", "firestore.ts", "ids.ts", "invoice-events.ts", "finance-invoices-gate.ts", "reconciliation.ts", "payable-source.ts", "client-dto.ts", "http.ts", "index.ts"]) {
      expect([...code.keys()]).toContain(expected);
    }
    expect(routeFiles.length).toBeGreaterThan(8);
    expect(codeOnly("const a = 1; // campaign\n// assignment\n/* creator */ const b = 2;")).not.toMatch(/campaign|assignment|creator/);
  });
});

describe("an Invoice consumes a Payable only through its public, read-only contract", () => {
  it("the ONLY Payables import is its public service barrel - never its Firestore internals", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) {
        if (/finance-payables/.test(spec)) expect(spec, `${name} imports ${spec}`).toBe("@/server/finance-payables");
      }
    }
    for (const file of routeFiles) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (/finance-payables/.test(spec)) expect(spec, `${path.basename(file)} imports ${spec}`).toBe("@/server/finance-payables");
      }
    }
  });

  it("Invoices depend on NOTHING from Finance Agreements or Partner Reviews - only the Payable it pins", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) {
        expect(spec, `${name} imports ${spec}`).not.toMatch(/finance-agreements|partner-reviews/);
      }
    }
  });

  it("Invoice creation is gated on READY_FOR_INVOICE - the payable-source resolver checks the Payable's status explicitly", () => {
    const source = code.get("payable-source.ts")!;
    expect(source).toMatch(/READY_FOR_INVOICE/);
    expect(source).toMatch(/PAYABLE_NOT_READY/);
  });

  it("only the module's own Firestore helper performs a write, and it names only Invoice collections", () => {
    const allowedCollections = new Set<string>(Object.values(FINANCE_INVOICE_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowedCollections.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
      if (name === "firestore.ts" || name === "invoice-events.ts") continue;
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\bgetAdminFirestore\(\)\s*\.collection/);
    }
  });

  it("no collection name here is a Payable, Agreement, Partner Review, Partner or Vendor collection - an Invoice never writes upstream history", () => {
    for (const value of Object.values(FINANCE_INVOICE_COLLECTIONS)) expect(value).not.toMatch(/financePayable|financeAgreement|partnerReview|payment|settlement/i);
    for (const [name, source] of code) expect(source, name).not.toMatch(/collection\(\s*["'`](financePayables|financeAgreements|partnerReviews|partners|vendors)["'`]/);
  });
});

describe("no Payment implementation is introduced", () => {
  it("no Invoices file imports a payment module and no such collection is opened", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(/(^|\/)payments?(\/|$)/i);
    }
    for (const [name, source] of code) expect(source, name).not.toMatch(/collection\(\s*["'`](payments?|settlements?|paymentLines?)\b/i);
  });

  it("no Payment API route exists under this module's own routes tree", () => {
    expect(existsSync(path.join(path.dirname(routesDir), "payments"))).toBe(false);
  });

  it("nothing here models a Payment status or a paidAt/paymentStatus field", () => {
    for (const [name, source] of code) expect(source, name).not.toMatch(/\b(paidAt|paymentStatus|paymentRef|paymentAmount)\b/);
  });
});

describe("no deletes on Invoice data", () => {
  it("there is no delete of any kind (doc, batch, transaction, recursive) anywhere in the module or its routes", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\.delete\s*\(/);
      expect(source, name).not.toMatch(/\b(deleteDoc|recursiveDelete|bulkWriter|deleteCollection)\b/);
    }
    for (const file of routeFiles) {
      expect(codeOnly(readFileSync(file, "utf8")), path.basename(file)).not.toMatch(/\.delete\s*\(|recursiveDelete|deleteDoc/);
    }
  });
});

describe("an invoice version is immutable once written", () => {
  it("the Firestore helper offers only a CREATE for a version - there is no set/update for one", () => {
    const firestore = code.get("firestore.ts")!;
    expect(firestore).toMatch(/export function txCreateInvoiceVersion\(/);
    expect(firestore).not.toMatch(/txSetInvoiceVersion|txUpdateInvoiceVersion/);
    expect(firestore.match(/financeInvoiceVersionsCollection\(version\.invoiceRef\)/g)).toHaveLength(1);
  });

  it("every writer creates the NEXT version rather than rewriting one", () => {
    for (const [name, source] of code) {
      if (!/txCreateInvoiceVersion|txSetInvoiceHead/.test(source)) continue;
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
    const gate = code.get("finance-invoices-gate.ts")!;
    expect(gate).toMatch(/canAccessFeature\(actor, "finance"\)/);
    expect(gate).toMatch(/canPerformAction\(actor, "finance", action\)/);
    expect(gate).toMatch(/canAccessSensitive\(actor, FINANCE_AMOUNTS_CATEGORY\)/);
    expect(gate).toMatch(/isPartnerDocInScope/);
    expect(gate).toMatch(/isVendorDocInScope/);
  });

  it("the mismatch override needs its OWN exact action, never a role check", () => {
    const source = [...code.values()].join("\n");
    expect(source).toMatch(/override_invoice_mismatch/);
  });

  it("no route re-implements authorization: each one resolves the actor and calls a service", () => {
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.basename(file)).toMatch(/resolveRequestActor\(\)/);
      expect(source, path.basename(file)).not.toMatch(/canAccessFeature|canPerformAction|canAccessSensitive|getActorScopeGrants|getAdminFirestore/);
    }
  });
});

describe("data safety: no restricted identity value, no KYC, no signed Drive URL, no scope field in a DTO", () => {
  it("no property with an identity-value name is declared anywhere in the module", () => {
    const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber|kyc)\s*\??\s*:/i;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });

  it("the stored shapes contain no identity value and no signed-URL-shaped field", () => {
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
    for (const schema of [invoiceVersionDocSchema, invoiceHeadDocSchema]) walkSchema(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
    expect(names.size).toBeGreaterThan(15);
    expect([...names].filter((n) => /^(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|gstin|gstNumber|signedUrl|driveUrl|webViewLink)$/i.test(n))).toEqual([]);
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
    // Every object-literal field whose NAME ends in Minor/MinorSigned (declaredTotalMinor,
    // subtotalMinor, amountMinor, payableExpectedTotalMinorSigned, ...) - never just the literal
    // "amountMinor" key, since this module's own money field names vary.
    const copies = [...dto.matchAll(/\b(\w*Minor(?:Signed)?):\s*([^,\n;]+),/g)];
    expect(copies.length).toBeGreaterThan(4);
    for (const match of copies) expect(match[2]!.trim(), `client-dto copies a raw amount ${match[1]}: ${match[0]}`).toMatch(/^(amount|nullableAmount)\(/);
  });

  it("no reconciliation finding message embeds a literal digit (figures stay withheld without finance_amounts)", () => {
    const source = code.get("reconciliation.ts")!;
    for (const match of source.matchAll(/message:\s*(`[^`]*`|"[^"]*")/g)) {
      const literal = match[1]!;
      // Template-literal interpolations (${...}) are allowed to be dynamic non-amount text (a
      // currency CODE, for example) - only a literal digit typed directly into the string is
      // forbidden here.
      const withoutInterpolations = literal.replace(/\$\{[^}]*\}/g, "");
      expect(withoutInterpolations, `reconciliation.ts message embeds a digit: ${literal}`).not.toMatch(/\d/);
    }
  });
});

describe("no approved Overview page is touched or referenced (UI freeze)", () => {
  const OVERVIEW_SURFACES = [/@\/ui\/Overview/, /@\/ui\/overview\.css/, /OverviewPage/, /OverviewTab/, /overview-model/, /overview-aggregate/, /overview-metrics/, /overview-service/];

  it("no Invoices server file or route imports or names an Overview surface", () => {
    for (const [name, source] of raw) {
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${name} references ${pattern}`).toBe(false);
    }
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${path.basename(file)} references ${pattern}`).toBe(false);
    }
  });

  // Step 16B built the Invoices UI (src/features/finance-invoices/** plus the three
  // src/app/finance/invoices/** routes). This guard keeps the wiring CONTAINED, exactly like
  // Payables' own equivalent guard: every component that imports the Invoices backend lives under
  // one of those two trees - and none of them references an Overview surface (the file-content
  // check above already proves this at the source level; this one proves it structurally, so a
  // future Invoices component can never sneak Overview wiring in through a path the first check
  // doesn't scan).
  it("every component wired to the Invoices backend lives under the Invoices UI, and none of it touches an approved Overview surface", () => {
    const componentFiles = [...walk(appDir, (name) => name.endsWith(".tsx")), ...walk(path.join(srcDir, "features"), (name) => name.endsWith(".tsx")).filter(() => existsSync(path.join(srcDir, "features"))), ...walk(path.join(srcDir, "ui"), (name) => name.endsWith(".tsx"))];
    const wired = componentFiles.filter((file) => importsOf(readFileSync(file, "utf8")).some((spec) => spec.startsWith("@/server/finance-invoices")));
    expect(wired.length).toBeGreaterThan(0);

    const invoicesAppDir = path.join(appDir, "finance", "invoices");
    const invoicesFeatureDir = path.join(srcDir, "features", "finance-invoices");
    for (const file of wired) {
      const contained = file.startsWith(invoicesAppDir + path.sep) || file.startsWith(invoicesFeatureDir + path.sep);
      expect(contained, `${file} is wired to the Invoices backend but lives outside the Invoices UI`).toBe(true);
      const source = readFileSync(file, "utf8");
      for (const pattern of OVERVIEW_SURFACES) expect(pattern.test(source), `${path.basename(file)} references ${pattern}`).toBe(false);
    }

    expect(existsSync(invoicesFeatureDir)).toBe(true);
  });

  it("the three Overview freeze files are untouched by this module (no reference anywhere)", () => {
    const FROZEN = ["src/app/dashboard/page.tsx", "src/ui/Overview.tsx", "src/ui/overview.css"];
    for (const [name, source] of raw) {
      for (const frozen of FROZEN) expect(source, `${name} references ${frozen}`).not.toContain(frozen);
    }
  });
});

describe("Agreement/Payable/Partner-Review UI is untouched by the Invoices UI (Step 16B)", () => {
  it("no Payables or Agreements UI file imports anything from this module", () => {
    const payablesFeatureDir = path.join(srcDir, "features", "finance-payables");
    const payablesAppDir = path.join(appDir, "finance", "payables");
    const agreementsAppDir = path.join(appDir, "finance", "agreements");
    const candidates = [
      ...(existsSync(payablesFeatureDir) ? walk(payablesFeatureDir, (name) => name.endsWith(".tsx") || name.endsWith(".ts")) : []),
      ...(existsSync(payablesAppDir) ? walk(payablesAppDir, (name) => name.endsWith(".tsx") || name.endsWith(".ts")) : []),
      ...(existsSync(agreementsAppDir) ? walk(agreementsAppDir, (name) => name.endsWith(".tsx") || name.endsWith(".ts")) : []),
    ];
    for (const file of candidates) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) expect(spec, `${file} imports ${spec}`).not.toMatch(/^@\/server\/finance-invoices/);
    }
  });
});
