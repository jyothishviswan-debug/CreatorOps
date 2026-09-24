import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FINANCE_PAYMENT_COLLECTIONS } from "./firestore";
import { paymentHeadDocSchema, paymentVersionDocSchema } from "./types";

// Step 17A section 22: the STATIC ARCHITECTURE GUARDS of the Finance Payments module. Pure source
// scans (no Firestore) - they fail loudly if a future change wires the wrong thing across a
// boundary. Scope: every non-test .ts file in this module directory and its sub-folders, plus the
// Payments API routes. Mirrors src/server/finance-invoices/finance-invoices-static.test.ts and
// src/server/finance-payables/finance-payables-static.test.ts exactly.

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/finance/payments");
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
    for (const expected of ["types.ts", "firestore.ts", "ids.ts", "payment-events.ts", "finance-payments-gate.ts", "settlement-calculator.ts", "payment-source.ts", "client-dto.ts", "http.ts", "index.ts"]) {
      expect([...code.keys()]).toContain(expected);
    }
    expect(routeFiles.length).toBeGreaterThan(8);
    expect(codeOnly("const a = 1; // campaign\n// assignment\n/* creator */ const b = 2;")).not.toMatch(/campaign|assignment|creator/);
  });
});

describe("a Payment consumes an Invoice only through its public, read-only contract", () => {
  it("the ONLY Invoices import is its public service barrel - never its Firestore internals", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) {
        if (/finance-invoices/.test(spec)) expect(spec, `${name} imports ${spec}`).toBe("@/server/finance-invoices");
      }
    }
    for (const file of routeFiles) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (/finance-invoices/.test(spec)) expect(spec, `${path.basename(file)} imports ${spec}`).toBe("@/server/finance-invoices");
      }
    }
  });

  it("Payments depend on NOTHING from Finance Agreements, Partner Reviews, or Finance Payables directly - only the Invoice it pins (which itself pins the Payable)", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) {
        expect(spec, `${name} imports ${spec}`).not.toMatch(/finance-agreements|partner-reviews|finance-payables/);
      }
    }
  });

  it("Payment creation is gated on the Invoice being APPROVED - the payment-source resolver checks the Invoice's status explicitly", () => {
    const source = code.get("payment-source.ts")!;
    expect(source).toMatch(/APPROVED/);
    expect(source).toMatch(/INVOICE_NOT_APPROVED/);
  });

  // Step 17B section 13 legitimately pins service base/GST/gross/TDS onto PaymentInvoicePin too -
  // as clearly-named, READ-ONLY display context for the Source Invoice tab, never as a candidate
  // for the payment's own target amount. The real invariant this guards is narrower and more
  // precise than "never mention these identifiers at all": the TARGET assignment itself
  // (`expectedNetPaymentMinor:`) must always come from the Invoice's own already-computed net
  // figure, never from gross/service-base/declared-total/Agreement-amount.
  it("the payment target is expectedNetPaymentMinor - pinned from the Invoice's own net figure, never substituted with a gross total, service base or Agreement amount", () => {
    const source = code.get("payment-source.ts")!;
    expect(source).toMatch(/expectedNetPaymentMinor:\s*version\.payablePin\.payableExpectedNetPaymentMinor/);
    expect(source).not.toMatch(/expectedNetPaymentMinor:\s*version\.payablePin\.(?!payableExpectedNetPaymentMinor)\w+/);
    expect(source).not.toMatch(/declaredTotalMinor|payableTotalAmountMinorSigned|agreementMonthlyAmount/);
  });

  it("only the module's own Firestore helper performs a write, and it names only Payment collections", () => {
    const allowedCollections = new Set<string>(Object.values(FINANCE_PAYMENT_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowedCollections.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
      if (name === "firestore.ts" || name === "payment-events.ts") continue;
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\bgetAdminFirestore\(\)\s*\.collection/);
    }
  });

  it("no collection name here is an Invoice, Payable, Agreement, Partner Review, Partner or Vendor collection - a Payment never writes upstream history", () => {
    for (const value of Object.values(FINANCE_PAYMENT_COLLECTIONS)) expect(value).not.toMatch(/financeInvoice|financePayable|financeAgreement|partnerReview/i);
    for (const [name, source] of code) expect(source, name).not.toMatch(/collection\(\s*["'`](financeInvoices|financePayables|financeAgreements|partnerReviews|partners|vendors)["'`]/);
  });
});

describe("a Payment never mutates the Invoice, the Payable, the Agreement or Partner Review evidence it consumes", () => {
  it("no Payments file imports an Invoice/Payable WRITE function - only the read-only public barrel functions", () => {
    const forbiddenInvoiceWrites = /\b(createInvoiceDraft|reviseInvoiceDraft|submitInvoice|approveInvoice|rejectInvoice|reopenInvoice|voidInvoice|acceptInvoiceMismatch|resolveInvoicePayeeMismatch|attachInvoiceDocument)\b/;
    const forbiddenPayableWrites = /\b(createPayable|revisePayable|addPayableAdjustment|removePayableAdjustment|confirmPayableTax|markPayableReadyForInvoice|voidPayable)\b/;
    for (const [name, source] of code) {
      expect(source, `${name} calls an Invoice write function`).not.toMatch(forbiddenInvoiceWrites);
      expect(source, `${name} calls a Payable write function`).not.toMatch(forbiddenPayableWrites);
    }
  });

  it("no Payments file recomputes GST/TDS or reconciliation - those words never appear as a computed field/function here", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\bcomputeGst\b|\bcomputeTds\b|\breconcileInvoice\b|\breconcilePayable\b|\bprorateMinor\b|\bpercentBpsOfMinor\b/);
    }
  });
});

describe("no Payment API route exists outside this module's own routes tree, and Payment API routes never import a payment-provider SDK", () => {
  it("no other module's route tree references a payment-provider integration (no Stripe/Razorpay/PayPal/bank-gateway SDK anywhere)", () => {
    for (const [name, source] of raw) expect(source, name).not.toMatch(/stripe|razorpay|paypal|plaid|payment-gateway|bank-gateway/i);
    for (const file of routeFiles) expect(readFileSync(file, "utf8"), path.basename(file)).not.toMatch(/stripe|razorpay|paypal|plaid|payment-gateway|bank-gateway/i);
  });

  it("no Payments file or route calls Google Drive / OCR", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/googleapis|drive\.files|DriveClient/i);
      expect(source, name).not.toMatch(/\bocr\b/i);
    }
    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      expect(source, path.basename(file)).not.toMatch(/googleapis|drive\.files|DriveClient/i);
      expect(source, path.basename(file)).not.toMatch(/\bocr\b/i);
    }
  });
});

describe("no deletes on Payment data", () => {
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

describe("a payment version is immutable once written", () => {
  it("the Firestore helper offers only a CREATE for a version - there is no set/update for one", () => {
    const firestore = code.get("firestore.ts")!;
    expect(firestore).toMatch(/export function txCreatePaymentVersion\(/);
    expect(firestore).not.toMatch(/txSetPaymentVersion|txUpdatePaymentVersion/);
    expect(firestore.match(/financePaymentVersionsCollection\(version\.paymentRef\)/g)).toHaveLength(1);
  });

  it("every writer creates the NEXT version rather than rewriting one", () => {
    for (const [name, source] of code) {
      if (!/txCreatePaymentVersion|txSetPaymentHead/.test(source)) continue;
      expect(source, name).not.toMatch(/versionsCollection\([^)]*\)\.doc\([^)]*\)\.(set|update)\(/);
    }
  });

  it("a CONFIRMED payment's amount/reference are never edited in place - only voided as an explicit reversal (section 7/20)", () => {
    const lifecycle = code.get("payment-lifecycle-service.ts")!;
    expect(lifecycle).toMatch(/PAYMENT_CONFIRMED_REVERSED/);
    expect(lifecycle).not.toMatch(/txSetPaymentHead\([^)]*amountMinor/);
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
    const gate = code.get("finance-payments-gate.ts")!;
    expect(gate).toMatch(/canAccessFeature\(actor, "finance"\)/);
    expect(gate).toMatch(/canPerformAction\(actor, "finance", action\)/);
    expect(gate).toMatch(/canAccessSensitive\(actor, FINANCE_AMOUNTS_CATEGORY\)/);
    expect(gate).toMatch(/isPartnerDocInScope/);
    expect(gate).toMatch(/isVendorDocInScope/);
  });

  it("the four Payment actions each have their OWN exact grant name, never a role check or a shared generic action", () => {
    const source = [...code.values()].join("\n");
    for (const action of ["manage_payments", "confirm_payments", "void_payments", "override_payment_overage"]) expect(source).toMatch(new RegExp(action));
  });

  it("no route re-implements authorization: each one resolves the actor and calls a service", () => {
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.basename(file)).toMatch(/resolveRequestActor\(\)/);
      expect(source, path.basename(file)).not.toMatch(/canAccessFeature|canPerformAction|canAccessSensitive|getActorScopeGrants|getAdminFirestore/);
    }
  });
});

describe("data safety: no restricted identity value, no raw bank data, no KYC, no Drive locator, no scope field in a DTO", () => {
  it("no property with an identity-value or raw-bank-data name is declared anywhere in the module", () => {
    const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber|kyc|driveFileId|webViewLink)\s*\??\s*:/i;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });

  it("the stored shapes contain no identity value and no raw bank field - only the already-masked bankSafeDisplay projection", () => {
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
    for (const schema of [paymentVersionDocSchema, paymentHeadDocSchema]) walkSchema(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
    expect(names.size).toBeGreaterThan(15);
    expect([...names].filter((n) => /^(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|gstin|gstNumber|signedUrl|driveUrl|webViewLink|driveFileId)$/i.test(n))).toEqual([]);
    expect([...names]).toContain("bankSafeDisplay");
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
    const copies = [...dto.matchAll(/\b(\w*Minor):\s*([^,\n;]+),/g)];
    expect(copies.length).toBeGreaterThan(2);
    for (const match of copies) expect(match[2]!.trim(), `client-dto copies a raw amount ${match[1]}: ${match[0]}`).toMatch(/^(amount|nullableAmount)\(/);
  });
});

describe("no approved Overview page is touched or referenced (UI freeze)", () => {
  const OVERVIEW_SURFACES = [/@\/ui\/Overview/, /@\/ui\/overview\.css/, /OverviewPage/, /OverviewTab/, /overview-model/, /overview-aggregate/, /overview-metrics/, /overview-service/];

  it("no Payments server file or route imports or names an Overview surface", () => {
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

describe("Step 17B: the Payment UI is wired only through the published client-dto/service contract", () => {
  // The Step 17A tripwire this block replaces ("no Payment UI exists yet") is now obsolete by
  // design: Step 17B's whole mandate is to build src/features/finance-payments and the three
  // /finance/payments/** routes. Mirrors the equivalent guard's own fate in
  // finance-invoices-static.test.ts / finance-payables-static.test.ts, neither of which keeps a
  // "no UI exists" assertion once their own UI step closed - this block keeps the parts of the old
  // guard that remain meaningful post-UI: exactly the three canonical routes exist (no
  // /finance/payments/overview, no v2/experimental route), and every `.tsx` that imports the
  // Payments backend does so ONLY through the published `@/server/finance-payments` barrel - never
  // its Firestore/gate internals.
  it("exactly the three canonical Payment routes exist under src/app/finance/payments/**", () => {
    const paymentsAppDir = path.join(appDir, "finance", "payments");
    const files = walk(paymentsAppDir, (name) => name.endsWith(".tsx"))
      .map((f) => path.relative(srcDir, f).split(path.sep).join("/"))
      .sort();
    expect(files).toEqual(["app/finance/payments/[paymentRef]/page.tsx", "app/finance/payments/new/page.tsx", "app/finance/payments/page.tsx"].sort());
  });

  it("every .tsx that imports the Payments backend imports only the published @/server/finance-payments barrel (its client-dto types, or the generic resolveRequestActor in http.ts) - never Firestore/gate/lifecycle internals", () => {
    const componentFiles = [...walk(appDir, (name) => name.endsWith(".tsx")), ...(existsSync(path.join(srcDir, "features")) ? walk(path.join(srcDir, "features"), (name) => name.endsWith(".tsx")) : []), ...walk(path.join(srcDir, "ui"), (name) => name.endsWith(".tsx"))];
    for (const file of componentFiles) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (!spec.startsWith("@/server/finance-payments")) continue;
        expect(spec, `${path.relative(srcDir, file)} imports ${spec}`).toMatch(/^@\/server\/finance-payments(\/client-dto|\/types|\/http)?$/);
      }
    }
  });
});
