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

  it("a Payments API route tree now exists (Step 17A, backend-only) as its own sibling - it consumes Finance Invoices only through its public barrel, never Invoices' Firestore/gate internals", () => {
    const paymentsRoutesDir = path.join(path.dirname(routesDir), "payments");
    if (!existsSync(paymentsRoutesDir)) return;
    for (const file of walk(paymentsRoutesDir, (name) => name.endsWith(".ts"))) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (/finance-invoices/.test(spec)) expect(spec, `${path.basename(file)} imports ${spec}`).toBe("@/server/finance-invoices");
      }
    }
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
  // one of those two trees, OR under the Payments UI - Step 17B's own Record Payment flow reads
  // Invoices' published detail/workspace contract for its Source Invoice step (SourceInvoiceStep.tsx),
  // the exact same cross-module HTTP-only pattern Invoices' own SourcePayableStep.tsx already uses
  // to read Payables (never that module's Firestore/gate internals - the "public barrel only" guard
  // above already proves that at the source level for every Payments file, backend included). None
  // of these trees references an Overview surface (the file-content check above already proves this
  // at the source level; this one proves it structurally, so a future component can never sneak
  // Overview wiring in through a path the first check doesn't scan).
  it("every component wired to the Invoices backend lives under the Invoices UI or the Payments UI, and none of it touches an approved Overview surface", () => {
    const componentFiles = [...walk(appDir, (name) => name.endsWith(".tsx")), ...walk(path.join(srcDir, "features"), (name) => name.endsWith(".tsx")).filter(() => existsSync(path.join(srcDir, "features"))), ...walk(path.join(srcDir, "ui"), (name) => name.endsWith(".tsx"))];
    const wired = componentFiles.filter((file) => importsOf(readFileSync(file, "utf8")).some((spec) => spec.startsWith("@/server/finance-invoices")));
    expect(wired.length).toBeGreaterThan(0);

    const invoicesAppDir = path.join(appDir, "finance", "invoices");
    const invoicesFeatureDir = path.join(srcDir, "features", "finance-invoices");
    const paymentsAppDir = path.join(appDir, "finance", "payments");
    const paymentsFeatureDir = path.join(srcDir, "features", "finance-payments");
    for (const file of wired) {
      const contained = [invoicesAppDir, invoicesFeatureDir, paymentsAppDir, paymentsFeatureDir].some((dir) => file.startsWith(dir + path.sep));
      expect(contained, `${file} is wired to the Invoices backend but lives outside the Invoices/Payments UI`).toBe(true);
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

describe("Step 16C section 22: payee identity matching boundaries", () => {
  const payeeIdentityFiles = new Map([...code].filter(([name]) => name.startsWith(`payee-identity${path.sep}`)));

  it("the payee-identity module exists and was actually scanned", () => {
    expect(payeeIdentityFiles.size).toBeGreaterThan(0);
    for (const expected of ["payee-identity/types.ts", "payee-identity/normalization.ts", "payee-identity/matcher.ts", "payee-identity/resolve-identity.ts"]) {
      expect([...code.keys()], expected).toContain(expected);
    }
  });

  it("the matching target is read from the Payable-pinned counterparty ONLY - resolve-identity.ts takes counterpartyType/counterpartyRef as its input, never a free-text name or a client-supplied entity id to search for", () => {
    const source = code.get("payee-identity/resolve-identity.ts")!;
    expect(source).toMatch(/counterpartyType/);
    expect(source).toMatch(/counterpartyRef/);
  });

  it("no cross-entity fuzzy search: the payee-identity module never queries a Partner/Vendor collection - only a single by-ref document lookup (getPartnerDocByRef / getVendorDocByRef, the SAME accessors the gate already uses for Record Scope), never .where/.orderBy/.limit over all Partners or Vendors", () => {
    for (const [name, source] of payeeIdentityFiles) {
      expect(source, `${name} queries a collection instead of a single by-ref lookup`).not.toMatch(/\.(where|orderBy)\s*\(/);
      expect(source, `${name} calls getAdminFirestore directly`).not.toMatch(/getAdminFirestore\(\)/);
    }
    const resolver = code.get("payee-identity/resolve-identity.ts")!;
    expect(resolver).toMatch(/getPartnerDocByRef/);
    expect(resolver).toMatch(/getVendorDocByRef/);
  });

  it("no auto-suggestion or auto-switch of the source Payable/counterparty anywhere in the module", () => {
    for (const [name, source] of payeeIdentityFiles) {
      expect(source, name).not.toMatch(/suggestCounterparty|switchPayable|reassignInvoice|autoSelectVendor|autoSelectPartner/i);
    }
  });

  it("Invoice payee-identity matching never mutates the Payable's counterparty or any Payable document - the module contains no Firestore write of any kind (only firestore.ts/invoice-events.ts may write, per the earlier guard) and never imports a Payable write function", () => {
    for (const [name, source] of payeeIdentityFiles) {
      expect(source, `${name} performs a Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
    }
    for (const [name, source] of raw) {
      if (!name.startsWith(`payee-identity${path.sep}`)) continue;
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(/finance-payables/);
    }
  });

  it("no canonical Partner/Vendor master-data mutation: the module never imports a Partner/Vendor SERVICE write function - only the same read-only firestore accessors finance-invoices-gate.ts already uses", () => {
    for (const [name, source] of raw) {
      if (!name.startsWith(`payee-identity${path.sep}`)) continue;
      for (const spec of importsOf(source)) {
        if (/\/(partners|vendors)\//.test(spec) || /\/(partners|vendors)$/.test(spec)) {
          expect(spec, `${name} imports ${spec}`).toMatch(/\/(partners|vendors)\/firestore$/);
        }
      }
      expect(source, name).not.toMatch(/savePartnerRestrictedIdentity|saveVendorRestrictedIdentity|updatePartner|updateVendor|editPartner|editVendor/);
    }
  });

  it("no PAN/Aadhaar is ever read or referenced by the payee-identity module - only .gst and .bank off the restricted document", () => {
    for (const [name, source] of payeeIdentityFiles) {
      expect(source, name).not.toMatch(/\.pan\b/);
      expect(source, name).not.toMatch(/\.aadhaar\b/);
    }
  });

  it("no raw restricted value is ever returned from the matcher - every field result is built through a safe-display helper, never a bare pass-through of expectedTaxId/expectedBankIdentifier/extractedTaxId/extractedBankIdentifier", () => {
    const matcher = code.get("payee-identity/matcher.ts")!;
    expect(matcher).not.toMatch(/safeExpectedDisplay:\s*evidence\.expectedTaxId\b/);
    expect(matcher).not.toMatch(/safeExtractedDisplay:\s*evidence\.extractedTaxId\b/);
    expect(matcher).not.toMatch(/safeExpectedDisplay:\s*evidence\.expectedBankIdentifier\b/);
    expect(matcher).not.toMatch(/safeExtractedDisplay:\s*evidence\.extractedBankIdentifier\b/);
  });

  it("client-dto.ts never contains a raw bank/tax value pattern - only status/masked projections reach the browser", () => {
    const dto = code.get("client-dto.ts")!;
    // A masked bank display is always the bullet-mask literal, never a bare digit run.
    expect(dto).not.toMatch(/safeExpectedDisplay:\s*\w*\.(gst|bank)\./);
  });

  it("resolveAndComparePayeeIdentity is never exported from the module's public barrel - only the trusted service layer (invoice-service.ts / invoice-lifecycle-service.ts) may call it, never a route directly", () => {
    const barrel = code.get("index.ts")!;
    expect(barrel).not.toMatch(/resolveAndComparePayeeIdentity/);
    for (const file of routeFiles) {
      expect(codeOnly(readFileSync(file, "utf8")), path.basename(file)).not.toMatch(/resolveAndComparePayeeIdentity/);
    }
  });

  it("the new resolve_invoice_payee_mismatch action needs its OWN exact grant, never override_invoice_mismatch reused for a different decision", () => {
    const source = [...code.values()].join("\n");
    expect(source).toMatch(/resolve_invoice_payee_mismatch/);
  });

  it("still no Payments, no OCR, no real Google Drive integration introduced by this module", () => {
    for (const [name, source] of payeeIdentityFiles) {
      expect(source, name).not.toMatch(/\b(paidAt|paymentStatus|paymentRef|paymentAmount)\b/);
      expect(source, name).not.toMatch(/\bocr\b/i);
      expect(source, name).not.toMatch(/googleapis|drive\.files|DriveClient/i);
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

// =====================================================================================================================
// Step 16E: the original Invoice document (Google Drive). These guards keep a test - or any stray import - from ever
// reaching real Google Drive, keep the folder id and any raw Drive locator out of source / DTO shapes, keep Drive
// disabled by default, and keep the storage seam the only way in. Mirrors Agreements' own Drive-boundary guards.
describe("Invoice document storage (Drive) boundaries", () => {
  const repoRoot = path.resolve(moduleDir, "../../..");
  const testFiles = walk(moduleDir, (name) => name.endsWith(".test.ts"));
  const OWN_DRIVE_TEST = path.join(moduleDir, "document-storage", "document-storage.test.ts");

  it("the real Drive adapter is reachable only through the storage resolver, and 'googleapis' is loaded only by it (lazily)", () => {
    const importers = [...raw.entries()].filter(([, source]) => importsOf(source).some((spec) => /(^|\/)document-storage\/google-drive$|^\.\/google-drive$/.test(spec))).map(([name]) => name);
    expect(importers).toEqual(["document-storage/index.ts"]);
    const googleapisUsers = [...raw.entries()].filter(([, source]) => importsOf(source).includes("googleapis")).map(([name]) => name);
    expect(googleapisUsers).toEqual(["document-storage/google-drive.ts"]);
    // dynamic import only (a top-level import would load the Google client for every route that imports the barrel)
    expect(code.get("document-storage/google-drive.ts")).not.toMatch(/^import[^;]*from\s+"googleapis"/m);
  });

  it("no TEST file (in this module) can reach real Drive: only the adapter's own mocked-googleapis unit test imports the real adapter, mocks or names 'googleapis'", () => {
    const offenders = testFiles
      .filter((file) => file !== OWN_DRIVE_TEST)
      .filter((file) => /createGoogleDriveInvoiceStorage|document-storage\/google-drive|from\s+"googleapis"|import\(\s*"googleapis"\s*\)|vi\.mock\(\s*"googleapis"/.test(readFileSync(file, "utf8")))
      // this scan file, and the finance-invoices-static.test.ts file, legitimately name these identifiers in string/regex literals
      .filter((file) => !file.endsWith("finance-invoices-static.test.ts"));
    expect(offenders).toEqual([]);
    expect(readFileSync(OWN_DRIVE_TEST, "utf8")).toMatch(/vi\.mock\(\s*"googleapis"/);
  });

  it("the real adapter checks the automated-test-run guard FIRST on every call (store AND get), before configuration or the Drive client", () => {
    const adapter = code.get("document-storage/google-drive.ts")!;
    const storeBody = adapter.slice(adapter.indexOf("async store("), adapter.indexOf("async get("));
    expect(storeBody.indexOf("isAutomatedTestRun()")).toBeGreaterThan(-1);
    expect(storeBody.indexOf("isAutomatedTestRun()")).toBeLessThan(storeBody.indexOf("getClient()"));
    expect(storeBody.indexOf("isAutomatedTestRun()")).toBeLessThan(storeBody.indexOf("config."));
    const getBody = adapter.slice(adapter.indexOf("async get("));
    expect(getBody.indexOf("isAutomatedTestRun()")).toBeGreaterThan(-1);
    expect(getBody.indexOf("isAutomatedTestRun()")).toBeLessThan(getBody.indexOf("getClient()"));
    const guard = code.get("document-storage/guard.ts")!;
    expect(guard).toMatch(/NODE_ENV === "test"/);
    expect(guard).toMatch(/process\.env\.VITEST/);
  });

  it("no Drive folder id or credential is hard-coded in source; the folder id comes only from configuration, and documentation examples are placeholders only", () => {
    for (const [name, source] of raw) expect(source, name).not.toMatch(/^FINANCE_INVOICE_DRIVE_FOLDER_ID=.+$/m);
    const env = readFileSync(path.join(repoRoot, "src/lib/env/server.ts"), "utf8");
    expect(env).toMatch(/FINANCE_INVOICE_DRIVE_FOLDER_ID/);
    expect(env).toMatch(/FINANCE_INVOICE_DRIVE_PROVIDER/);
    const example = readFileSync(path.join(repoRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^FINANCE_INVOICE_DRIVE_FOLDER_ID=\s*$/m);
    expect(example).toMatch(/^# FINANCE_INVOICE_DRIVE_PROVIDER=google_drive/m);
  });

  it("provider selection is EXPLICIT: Drive is never selected just because credentials/folder happen to be configured, and the default local/test provider is the fake", () => {
    const resolver = code.get("document-storage/index.ts")!;
    expect(resolver).toMatch(/env\.provider === "google_drive"/);
    expect(resolver).not.toMatch(/credentialsPath[^;]*&&[^;]*folderId[^;]*\?\s*"GOOGLE_DRIVE"/);
  });

  it("the Drive file id / any raw provider locator never appear on a DTO shape: only the opaque documentId (already the port's existing contract) is representable", () => {
    const dto = code.get("client-dto.ts")!;
    expect(dto).not.toMatch(/driveFileId|webViewLink|driveLink|drive\.google\.com/i);
    const version = z.toJSONSchema(invoiceVersionDocSchema, { io: "input", unrepresentable: "any" }) as { properties: Record<string, unknown> };
    expect(Object.keys(version.properties)).toContain("document");
    expect(JSON.stringify(z.toJSONSchema(invoiceVersionDocSchema, { io: "input", unrepresentable: "any" }))).not.toMatch(/driveLink|driveFileId|webViewLink/);
  });

  it("only the document-storage seam calls into a real backend client; the service layer never imports googleapis or constructs a Drive client directly", () => {
    const service = code.get("invoice-service.ts")!;
    expect(service).toMatch(/getInvoiceDocumentStorage\(\)/);
    expect(service).not.toMatch(/googleapis|google\.drive\(/);
  });
});
