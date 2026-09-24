import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { QUALIFYING_UNITS } from "@/server/partner-reviews/types";

import { MAX_CONTRACT_PDF_BYTES } from "./contract-artifacts/validation";
import { FINANCE_AGREEMENT_COLLECTIONS } from "./firestore";
import { AGREEMENT_FIELDS } from "./fields";
import { PARTNER_REVIEW_QUALIFYING_UNITS } from "./policy-adapter";
import {
  agreementDraftEntrySchema,
  agreementEventSchema,
  agreementHeadDocSchema,
  agreementVersionDocSchema,
  contractArtifactDocSchema,
  restrictedExtractionDocSchema,
} from "./types";
import { CONTRACT_UPLOAD_MAX_REQUEST_BYTES } from "./upload-request";

// Step 14A section 21: STATIC GUARDS over the whole Finance Agreements surface - the module (every sub-folder) AND its API
// routes. Pure source scans plus schema walks; no Firestore. They fail loudly when a future change wires the wrong thing across
// a boundary. finance-agreements-boundary.test.ts holds the module-root scans; this file extends them to sub-folders + routes and
// adds the import-graph, route, adapter and configuration guards.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const moduleDir = import.meta.dirname;
const routesDir = path.join(repoRoot, "src/app/api/finance");
const partnerReviewsDir = path.join(repoRoot, "src/server/partner-reviews");

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, into);
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) into.push(full);
  }
  return into;
}

// Executable code only (comments may explain a boundary by name).
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

const rel = (file: string) => path.relative(repoRoot, file);
const read = (file: string) => readFileSync(file, "utf8");

// Test-support fixtures (testing/) are not production code and stay out of the scans.
const moduleFiles = walk(moduleDir).filter((file) => !file.includes(`${path.sep}testing${path.sep}`));
// Step 15A: /api/finance is a shared URL namespace, not a module boundary - Finance Payables now
// owns /api/finance/payables/**, with its own static guards in
// src/server/finance-payables/finance-payables-static.test.ts. This scan stays the AGREEMENTS route
// surface, so the Payables sub-tree is excluded here rather than being (wrongly) held to the
// Agreements module's own import rules. The "no Payables/Invoices/Payments" guards below still
// apply in full to every Agreements file: the Agreements module must not reach into Payables, and
// nothing in this list stops being checked - it is only the Payables routes' own file set that is
// no longer treated as Agreements code.
// Step 16A: same treatment for Finance Invoices - /api/finance/invoices/** now owns its own static
// guards in src/server/finance-invoices/finance-invoices-static.test.ts, so its routes are excluded
// from this AGREEMENTS-scoped scan the same way Payables' own were in Step 15A. The "no Payment"
// guard below still applies in full to every Agreements file.
const PAYABLES_ROUTE_PREFIX = path.join(routesDir, "payables") + path.sep;
const INVOICES_ROUTE_PREFIX = path.join(routesDir, "invoices") + path.sep;
const routeFiles = walk(routesDir).filter((file) => !file.startsWith(PAYABLES_ROUTE_PREFIX) && !file.startsWith(INVOICES_ROUTE_PREFIX));
const productionFiles = [...moduleFiles, ...routeFiles];
const code = new Map(productionFiles.map((file) => [rel(file), codeOnly(read(file))] as const));

// Resolves an import specifier of a module file to another module file (or null for an external / other-module import).
function resolveInModule(fromFile: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/server/finance-agreements")) base = path.join(repoRoot, "src/server/finance-agreements", spec.slice("@/server/finance-agreements".length));
  if (!base) return null;
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) if (existsSync(candidate)) return candidate;
  return null;
}

// Every module file reachable from `entries` through module-internal imports, plus every external specifier those files import.
function importGraph(entries: string[]) {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = entries.map((entry) => path.join(moduleDir, entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(read(file))) {
      const target = resolveInModule(file, spec);
      if (target) queue.push(target);
      else external.add(spec);
    }
  }
  return { files: [...seen].map((file) => path.relative(moduleDir, file)).sort(), external: [...external].sort() };
}

describe("the scan itself is sound", () => {
  it("covers the module sub-folders and every API route, and strips comments", () => {
    const names = productionFiles.map(rel);
    expect(names).toContain("src/server/finance-agreements/extraction/pdf-text.ts");
    expect(names).toContain("src/server/finance-agreements/contract-artifacts/store.ts");
    expect(names).toContain("src/server/finance-agreements/policy-adapter.ts");
    expect(names.filter((name) => name.startsWith("src/app/api/finance/")).length).toBeGreaterThanOrEqual(25);
    expect(codeOnly("const a = 1; // campaign\n// assignment\n/* creator */ const b = 2;")).not.toMatch(/campaign|assignment|creator/);
    expect(importsOf('import { a } from "./x";\nexport { b } from "../y";')).toEqual(["./x", "../y"]);
  });
});

// =====================================================================================================================
describe("routes: thin, and exactly the documented surface", () => {
  const EXPECTED: Record<string, string[]> = {
    "agreements/route.ts": ["GET", "POST"],
    "agreements/[agreementRef]/route.ts": ["GET"],
    "agreements/[agreementRef]/versions/route.ts": ["GET"],
    "agreements/[agreementRef]/events/route.ts": ["GET"],
    "agreements/[agreementRef]/extraction/route.ts": ["GET"],
    "agreements/[agreementRef]/extraction/attach/route.ts": ["POST"],
    "agreements/[agreementRef]/reconciliation/route.ts": ["GET"],
    "agreements/[agreementRef]/fields/route.ts": ["POST"],
    "agreements/[agreementRef]/master-data/route.ts": ["POST"],
    "agreements/[agreementRef]/parties/route.ts": ["POST"],
    "agreements/[agreementRef]/kyc/route.ts": ["POST"],
    "agreements/[agreementRef]/kyc-status/route.ts": ["GET"],
    "agreements/[agreementRef]/confirm/route.ts": ["POST"],
    "agreements/[agreementRef]/activate/route.ts": ["POST"],
    "agreements/[agreementRef]/revise/route.ts": ["POST"],
    "agreements/[agreementRef]/suspend/route.ts": ["POST"],
    "agreements/[agreementRef]/resume/route.ts": ["POST"],
    "agreements/[agreementRef]/end/route.ts": ["POST"],
    "contracts/upload/route.ts": ["POST"],
    "contracts/extract/route.ts": ["POST"],
    // Step 14B: the workspace list, the intake counterparty picker and the permissions probe (all GET, read-only).
    "agreements/workspace/route.ts": ["GET"],
    "counterparties/search/route.ts": ["GET"],
    "counterparties/preview/route.ts": ["GET"],
    "permissions/route.ts": ["GET"],
    // Step 14B.1: the original signed Agreement document (store / retry + status) and its Partner / Vendor contextual projection.
    "agreements/[agreementRef]/document/route.ts": ["GET", "POST"],
    "counterparties/documents/route.ts": ["GET"],
    // Step 14B.1: Agreement-led counterparty onboarding (ephemeral preview, live-scope duplicate check, create / resume + status).
    "onboarding/route.ts": ["GET", "POST"],
    "onboarding/duplicates/route.ts": ["POST"],
    "onboarding/preview/route.ts": ["POST"],
  };

  it("the Agreements route tree is exactly the 29 documented route files (no payments / delete / campaign route exists)", () => {
    const actual = routeFiles.map((file) => path.relative(routesDir, file).split(path.sep).join("/")).sort();
    expect(actual).toEqual(Object.keys(EXPECTED).sort());
    // Step 15A added the "payables" sibling under the shared /api/finance namespace (its own module,
    // its own guards). Step 16A added the "invoices" sibling the same way (its own module, its own
    // guards in src/server/finance-invoices/finance-invoices-static.test.ts). Payments deliberately
    // still has no route surface at all.
    expect(readdirSync(routesDir).sort()).toEqual(["agreements", "contracts", "counterparties", "invoices", "onboarding", "payables", "permissions"]);
    expect(readdirSync(routesDir)).not.toContain("payments");
  });

  it("every route exports only the documented HTTP methods - never PUT / PATCH / DELETE", () => {
    for (const [file, methods] of Object.entries(EXPECTED)) {
      const source = code.get(rel(path.join(routesDir, file)))!;
      const exported = [...source.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]!).sort();
      expect(exported, file).toEqual([...methods].sort());
      expect(source, file).not.toMatch(/export\s+(const|let|var|function)\s/); // no other export shapes (e.g. a config that widens the body limit)
    }
  });

  it("routes import only next/server and the Finance service surface (index, http, upload-request) - no Firestore, no Firebase, no docs / helpers", () => {
    const allowed = new Set(["next/server", "@/server/finance-agreements", "@/server/finance-agreements/http", "@/server/finance-agreements/upload-request"]);
    for (const file of routeFiles) {
      const specs = importsOf(read(file));
      for (const spec of specs) expect(allowed.has(spec), `${rel(file)} imports ${spec}`).toBe(true);
      const source = code.get(rel(file))!;
      expect(source, rel(file)).not.toMatch(/firestore|firebase|getAdminFirestore|\.collection\(|\.doc\(|runTransaction|FieldValue/i);
    }
  });

  it("routes carry no logic: they never read a role, a locator, a bucket, a path, a signed URL or a Firestore doc shape", () => {
    for (const file of routeFiles) {
      const source = code.get(rel(file))!;
      expect(source, rel(file)).not.toMatch(/\bactor\.role\b|minimumRole|role\s*===|["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
      expect(source, rel(file)).not.toMatch(/storageLocator|getContractArtifactStore|getSignedUrl|signedUrl|createFirebaseStorageArtifactStore|bucket|gs:\/\//i);
      expect(source, rel(file)).not.toMatch(/DocSchema|HeadDoc|VersionDoc/);
    }
  });

  it("every route resolves the actor from the session and the service does the authorization", () => {
    for (const file of routeFiles) {
      const source = code.get(rel(file))!;
      expect(source, rel(file)).toMatch(/resolveRequestActor\(\)/);
      // mutations mint a request id for the audit event
      if (/export async function POST/.test(source)) expect(source, rel(file)).toMatch(/newRequestId\(\)/);
    }
  });

  it("the proxy body buffer is raised above the upload cap, and the upload cap is above the 10 MB file limit (a body the proxy would truncate is refused first)", () => {
    const config = read(path.join(repoRoot, "next.config.ts"));
    const match = /proxyClientMaxBodySize:\s*"(\d+)mb"/.exec(config);
    expect(match, "next.config.ts must set experimental.proxyClientMaxBodySize").not.toBeNull();
    const proxyLimit = Number(match![1]) * 1024 * 1024;
    expect(CONTRACT_UPLOAD_MAX_REQUEST_BYTES).toBeGreaterThan(MAX_CONTRACT_PDF_BYTES);
    expect(CONTRACT_UPLOAD_MAX_REQUEST_BYTES).toBeLessThan(proxyLimit);
    expect(proxyLimit).toBeGreaterThan(10 * 1024 * 1024); // Next's default (10 MB) would truncate a 10 MB PDF + multipart framing
  });
});

// =====================================================================================================================
describe("no Campaign / Assignment / Deliverable / Creator concept anywhere in the module or its routes", () => {
  // The contract EXTRACTORS read real contract text: their patterns must recognize the words a contract uses
  // ("Fixed deliverable units", "the Creator"), so those pattern files may contain the WORDS - but never an entity,
  // a reference field or a collection of those concepts.
  const CONTRACT_VOCABULARY_FILES = new Set(["extraction/commercial-rules.ts", "extraction/identity-rules.ts", "extraction/term-rules.ts"]);

  it("no identifier, string or field in executable code mentions one (the policy adapter may name Partner Reviews' own monthlyDeliverableRequirement contract field, nothing else)", () => {
    for (const [name, source] of code) {
      const local = path.relative("src/server/finance-agreements", name);
      if (CONTRACT_VOCABULARY_FILES.has(local)) continue;
      let scanned = source.replace(/CreatorOps|CREATOROPS/g, "");
      if (local === "policy-adapter.ts") scanned = scanned.replace(/monthlyDeliverableRequirement/g, "");
      expect(scanned, name).not.toMatch(/campaign|assignment|creator|deliverable/i);
    }
  });

  it("the contract-vocabulary extractor files name no such entity, reference or collection (only words inside their text patterns)", () => {
    for (const local of CONTRACT_VOCABULARY_FILES) {
      const source = code.get(`src/server/finance-agreements/${local}`)!.replace(/CreatorOps|CREATOROPS/g, "");
      expect(source, local).not.toMatch(/\b(campaignRef|assignmentRef|creatorRef|deliverableRef|campaignId|assignmentId|creatorId|deliverableId)\b/);
      expect(source, local).not.toMatch(/\b(Campaign|Assignment|Creator|Deliverable)[A-Z]?\w*\b/);
      expect(source, local).not.toMatch(/\.collection\(/);
      for (const spec of importsOf(read(path.join(moduleDir, local)))) expect(spec, `${local} imports ${spec}`).not.toMatch(/campaigns|assignments|creators|content|analytics|partners|vendors|firebase/);
    }
  });

  it("no Agreement schema, doc, field key or collection has such a property (no campaignRef / assignmentRef ownership)", () => {
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
    for (const schema of [agreementHeadDocSchema, agreementVersionDocSchema, agreementEventSchema, agreementDraftEntrySchema, contractArtifactDocSchema, restrictedExtractionDocSchema]) walkSchema(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
    expect(names.size).toBeGreaterThan(40);
    expect([...names].filter((name) => /campaign|assignment|creator|deliverable/i.test(name))).toEqual([]);
    for (const field of AGREEMENT_FIELDS) expect(`${field.key} ${field.group}`, field.key).not.toMatch(/campaign|assignment|creator|deliverable/i);
    // the required-count concept is the ONE allowed phrase: "monthly required qualifying content count"
    expect(AGREEMENT_FIELDS.map((field) => field.key)).toContain("monthlyRequiredQualifyingContentCount");
    for (const value of Object.values(FINANCE_AGREEMENT_COLLECTIONS)) expect(value).not.toMatch(/campaign|assignment|creator|deliverable/i);
  });

  it("no canonical Creator entity is revived: no creators collection, module or import", () => {
    for (const file of productionFiles) {
      for (const spec of importsOf(read(file))) expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(/(^|\/)(creators?|campaigns|assignments|content|deliverables?)(\/|$)/);
      expect(code.get(rel(file)), rel(file)).not.toMatch(/collection\(\s*["'`](creators?|campaigns|assignments|deliverables?)["'`]/i);
    }
  });
});

// =====================================================================================================================
describe("identity VALUES never leave the restricted boundary", () => {
  const IDENTITY_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber)\s*\??\s*:/;

  it("an identity-value property is declared only in the field registry and the restricted extraction types", () => {
    const hits = productionFiles.filter((file) => IDENTITY_PROPERTY.test(code.get(rel(file))!)).map((file) => path.relative(moduleDir, file).split(path.sep).join("/"));
    expect(hits.sort()).toEqual(["extraction/extraction-types.ts", "fields.ts"]);
  });

  it("routes and DTO builders never name one", () => {
    for (const file of routeFiles) expect(code.get(rel(file)), rel(file)).not.toMatch(IDENTITY_PROPERTY);
    expect(code.get("src/server/finance-agreements/client-dto.ts")).not.toMatch(IDENTITY_PROPERTY);
  });

  it("the restricted extraction record is the only schema holding a raw value / snippet, and it is written to exactly one place", () => {
    const restricted = new Set<string>();
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (key === "properties" && child && typeof child === "object") Object.keys(child).forEach((property) => restricted.add(property));
          collect(child);
        }
      }
    };
    collect(z.toJSONSchema(restrictedExtractionDocSchema, { io: "input", unrepresentable: "any" }));
    expect(restricted.has("rawValue")).toBe(true);
    expect(restricted.has("rawSnippet")).toBe(true);

    const writers = productionFiles.filter((file) => /txCreateRestrictedExtraction\(/.test(code.get(rel(file))!) && !/export function txCreateRestrictedExtraction/.test(code.get(rel(file))!));
    expect(writers.map((file) => path.relative(moduleDir, file))).toEqual(["extraction-service.ts"]);
  });
});

// =====================================================================================================================
describe("no Payable / Invoice / Payment creation", () => {
  it("no production file (module, sub-folder or route) imports a payables / invoices / payments module or names such a collection", () => {
    for (const file of productionFiles) {
      for (const spec of importsOf(read(file))) expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(/(^|\/)(payables?|invoices?|payments?|settlements?)(\/|$)/i);
      expect(code.get(rel(file)), rel(file)).not.toMatch(/collection\(\s*["'`](payables?|invoices?|payments?|payableLines?|settlements?)\b/i);
      expect(code.get(rel(file)), rel(file)).not.toMatch(/\b(createPayable|createInvoice|recordPayment|createPayment|generatePayable|generateInvoice)\b/);
    }
  });
});

// =====================================================================================================================
describe("extraction and contract upload can never write a Partner, Vendor or KYC record", () => {
  // (Step 14B.1 adds createPartnerAccount: the onboarding orchestration is the only other file that may name the owning WRITE services.)
  const WRITE_SERVICE_IDENTIFIERS = /\b(editPartner|editVendor|savePartnerRestrictedIdentity|saveVendorRestrictedIdentity|createPartner|createVendor|createPartnerAccount|addPartnerRestrictedIdentity\w*|addVendorRestrictedIdentity\w*)\b/;
  // The read-side helpers the gate / status code may import from the owning modules (none of them writes).
  const READ_ONLY_OWNER_IMPORTS = /^@\/server\/(partners|vendors)\/(firestore|types|partners-gate|vendors-gate)$|^@\/server\/shared\/restricted-financial-identity$/;

  it("the import graph of the extraction and upload services never reaches a Partner / Vendor / restricted-identity WRITE service", () => {
    const graph = importGraph(["extraction-service.ts", "contract-service.ts", "extraction-run-builder.ts"]);
    expect(graph.files).toContain("finance-agreements-gate.ts"); // the graph is real (it follows the gate)
    expect(graph.files).not.toContain("master-data-commands.ts");
    expect(graph.files).not.toContain("onboarding-service.ts");
    for (const file of graph.files) expect(code.get(`src/server/finance-agreements/${file}`), file).not.toMatch(WRITE_SERVICE_IDENTIFIERS);
    for (const spec of graph.external) {
      if (!/^@\/server\/(partners|vendors)\//.test(spec) && !/restricted-identity|restricted-financial-identity/.test(spec)) continue;
      expect(READ_ONLY_OWNER_IMPORTS.test(spec), `extraction/upload reach ${spec}`).toBe(true);
    }
    // ... and it never reaches the service modules of the owners at all
    expect(graph.external.filter((spec) => /partner-service|vendor-service|restricted-identity-service|partners-service|vendors-service/.test(spec))).toEqual([]);
  });

  it("the read-only reconciliation / KYC-status / status snapshot code likewise imports no write service", () => {
    const graph = importGraph(["reconciliation-service.ts", "kyc-status-service.ts", "identity-status.ts", "agreement-service.ts", "agreement-lifecycle-service.ts", "policy-adapter.ts"]);
    expect(graph.files).not.toContain("master-data-commands.ts");
    expect(graph.files).not.toContain("onboarding-service.ts");
    for (const file of graph.files) expect(code.get(`src/server/finance-agreements/${file}`), file).not.toMatch(WRITE_SERVICE_IDENTIFIERS);
    expect(graph.external.filter((spec) => /partner-service|vendor-service|restricted-identity-service/.test(spec))).toEqual([]);
  });

  // DELIBERATE 14B.1 CHANGE: exactly TWO module files may import / name the owning WRITE services - the master-data commands (edit +
  // restricted identity) and the Agreement-led onboarding orchestration (create Partner / Vendor / Partner Account). Nothing else, and the
  // extraction / upload / read-only graphs below still must not reach either of them.
  const WRITE_SERVICE_FILES = ["master-data-commands.ts", "onboarding-service.ts"];

  it("the master-data commands and the onboarding orchestration are the ONLY module files that import the owning modules' write services", () => {
    const importers = productionFiles
      .filter((file) => importsOf(read(file)).some((spec) => /^@\/server\/(partners|vendors)\/(partner-service|vendor-service|partner-account-service|restricted-identity-service)$/.test(spec)))
      .map((file) => path.relative(moduleDir, file));
    expect(importers.sort()).toEqual(WRITE_SERVICE_FILES);
    const namers = productionFiles.filter((file) => WRITE_SERVICE_IDENTIFIERS.test(code.get(rel(file))!)).map((file) => path.relative(moduleDir, file));
    expect(namers.sort()).toEqual(WRITE_SERVICE_FILES);
    // Partner Account creation is reachable from the onboarding orchestration only
    const accountWriters = productionFiles.filter((file) => importsOf(read(file)).some((spec) => /partner-account-service$/.test(spec))).map((file) => path.relative(moduleDir, file));
    expect(accountWriters).toEqual(["onboarding-service.ts"]);
  });

  it("the onboarding orchestration reaches every owning record ONLY through the owning services: it never writes a Partner / Vendor / Account / identity document or a Payable / Invoice / Payment", () => {
    const service = code.get("src/server/finance-agreements/onboarding-service.ts")!;
    expect(service).toMatch(/createPartner\(/);
    expect(service).toMatch(/createVendor\(/);
    expect(service).toMatch(/createPartnerAccount\(/);
    expect(service).toMatch(/createAgreementDraftWithProvenance\(/);
    expect(service).not.toMatch(/partnersCollection|vendorsCollection|partnerAccountsCollection|partnerAccountIdentityClaimsCollection|restrictedFinancialIdentitiesCollection|vendorPartnerLinksCollection|tx\.(set|update|create)\(|runTransaction|\.set\(|\.update\(|\.create\(/);
    // a Vendor Agreement never creates a represented-Partner link
    expect(service).not.toMatch(/VendorPartnerLink|createVendorPartnerLink|vendor-partner-link/);
    // the only ledger writer is the ledger module (financeAgreementClaims, onb_ ids); the service imports no Firestore collection helper of its own
    for (const spec of importsOf(read(path.join(moduleDir, "onboarding-service.ts")))) expect(spec, spec).not.toMatch(/^\.\/firestore$|firebase\/admin/);
    const ledgerWriters = productionFiles.filter((file) => /ONBOARDING_LEDGER_ID_PREFIX/.test(code.get(rel(file))!)).map((file) => path.relative(moduleDir, file));
    expect(ledgerWriters.sort()).toEqual(["onboarding-ledger.ts"]);
  });

  it("the onboarding orchestration is reached only by its own route; the preview and duplicate services are read-only and reach no write service", () => {
    const users = routeFiles.filter((file) => /createCounterpartyFromOnboarding|getOnboardingStatus/.test(code.get(rel(file))!)).map((file) => path.relative(routesDir, file).split(path.sep).join("/"));
    expect(users).toEqual(["onboarding/route.ts"]);
    for (const readOnly of ["onboarding-preview-service.ts", "onboarding-duplicates.ts"]) {
      const graph = importGraph([readOnly]);
      expect(graph.files, readOnly).not.toContain("onboarding-service.ts");
      expect(graph.files, readOnly).not.toContain("master-data-commands.ts");
      for (const file of graph.files) expect(code.get(`src/server/finance-agreements/${file}`), file).not.toMatch(WRITE_SERVICE_IDENTIFIERS);
      expect(graph.external.filter((spec) => /partner-service|vendor-service|partner-account-service|restricted-identity-service/.test(spec)), readOnly).toEqual([]);
    }
    // the preview persists NOTHING: no store, no transaction, no write call of any kind in its own code
    const preview = code.get("src/server/finance-agreements/onboarding-preview-service.ts")!;
    expect(preview).not.toMatch(/getContractArtifactStore|uploadContractArtifact|runTransaction|txCreate|\.doc\(|\.(create|update)\(|Collection\(\)/);
    const duplicates = code.get("src/server/finance-agreements/onboarding-duplicates.ts")!;
    expect(duplicates).not.toMatch(/runTransaction|txCreate|\.doc\(|\.(create|update)\(|Collection\(\)/);
  });

  it("the onboarding ledger is status-only: no contact detail, identity value, contract text or account locator in its schema", async () => {
    const { onboardingLedgerDocSchema } = await import("./onboarding-ledger");
    const names = new Set<string>();
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (key === "properties" && child && typeof child === "object") Object.keys(child).forEach((property) => names.add(property));
          collect(child);
        }
      }
    };
    collect(z.toJSONSchema(onboardingLedgerDocSchema, { io: "input", unrepresentable: "any" }));
    expect(names.size).toBeGreaterThan(20);
    expect([...names].filter((name) => /email|phone|pan|aadhaar|gst|bank|ifsc|handle|profileUrl|displayName|legalName|snippet|locator|url/i.test(name) && name !== "displayName")).toEqual([]);
  });

  it("the master-data commands are reached only by their two routes, and both go through the owning module", () => {
    const users = routeFiles.filter((file) => /updateCounterpartyContactFromAgreement|applyExtractedKycToCanonical/.test(code.get(rel(file))!)).map((file) => path.relative(routesDir, file).split(path.sep).join("/"));
    expect(users.sort()).toEqual(["agreements/[agreementRef]/kyc/route.ts", "agreements/[agreementRef]/master-data/route.ts"]);
    const commands = code.get("src/server/finance-agreements/master-data-commands.ts")!;
    expect(commands).toMatch(/editPartner\(/);
    expect(commands).toMatch(/editVendor\(/);
    expect(commands).toMatch(/savePartnerRestrictedIdentity\(/);
    expect(commands).toMatch(/saveVendorRestrictedIdentity\(/);
    // it never writes a Partner / Vendor / identity document itself
    expect(commands).not.toMatch(/partnersCollection|vendorsCollection|restrictedFinancialIdentitiesCollection|tx\.(set|update|create)\(/);
  });
});

// =====================================================================================================================
describe("no delete, no rank, no roles - across the module, sub-folders and routes", () => {
  it("there is no delete of any kind, and no exported delete / remove / purge function", () => {
    for (const file of productionFiles) {
      const source = code.get(rel(file))!;
      // A pure parser may use Map / Set .delete(); any file that can reach Firestore (or Storage) may not delete at all.
      const reachesStore = importsOf(read(file)).some((spec) => /(^|\/)firestore$|firebase|firebase-admin|contract-artifacts\/store$/.test(spec));
      if (reachesStore) expect(source, rel(file)).not.toMatch(/\.delete\s*\(/);
      expect(source, rel(file)).not.toMatch(/\b(deleteDoc|recursiveDelete|bulkWriter|deleteCollection|FieldValue\.delete)\b/);
      expect(source, rel(file)).not.toMatch(/export\s+(async\s+)?(function|const)\s+(delete|remove|purge|erase|destroy)\w*/i);
      expect(source, rel(file)).not.toMatch(/export async function DELETE/);
    }
    const barrel = code.get("src/server/finance-agreements/index.ts")!;
    expect(barrel).not.toMatch(/\b(delete|remove|purge)\w*Agreement|\bdeleteAgreement\b/i);
  });

  it("the extraction folder is pure: it imports no Firestore, Firebase, Storage or owning module (only the PDF reader, zod, siblings and Discovery's pure region-name constant)", () => {
    for (const file of moduleFiles.filter((f) => f.includes(`${path.sep}extraction${path.sep}`))) {
      for (const spec of importsOf(read(file))) expect(spec, `${rel(file)} imports ${spec}`).toMatch(/^(\.\/|unpdf$|zod$|@\/server\/discovery\/types$)/);
    }
  });

  it("explicit grants only: no role name, role read, rank or minimumRole in any file", () => {
    for (const file of productionFiles) {
      const source = code.get(rel(file))!;
      expect(source, rel(file)).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
      expect(source, rel(file)).not.toMatch(/["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
      expect(source, rel(file)).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b|\bisAtLeast\w*Role\b|\brank\b/i);
      for (const spec of importsOf(read(file))) expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(/authz\/roles$/);
    }
  });
});

// =====================================================================================================================
describe("the Partner Reviews seam: the adapter is registered ONLY by the server composition module, and Partner Reviews production code knows nothing of Finance", () => {
  const partnerReviewFiles = walk(partnerReviewsDir);

  it("no Partner Reviews production file imports anything Finance / Agreement", () => {
    expect(partnerReviewFiles.length).toBeGreaterThan(20);
    for (const file of partnerReviewFiles) {
      for (const spec of importsOf(read(file))) expect(spec, `${rel(file)} imports ${spec}`).not.toMatch(/finance|agreement/i);
    }
  });

  // DELIBERATE 14C CHANGE (was: "production registration is DEFERRED: no non-test file outside the adapter imports it"). Step 14C registers the
  // adapter as THE Partner Reviews commercial-policy provider. Exactly ONE production file may import the adapter - the server composition
  // module - and exactly ONE production file may install it (that module, via the neutral registry). Nothing else, and the test-only override
  // stays confined to commercial-policy.ts.
  it("production registration: ONLY src/server/composition/register-providers.ts imports the adapter, and ONLY it (plus the registry itself) calls the registry", () => {
    const serverRoot = path.join(repoRoot, "src");
    const all = walk(serverRoot).filter((file) => !file.endsWith("finance-agreements/policy-adapter.ts"));
    const importers = all.filter((file) => importsOf(read(file)).some((spec) => /policy-adapter/.test(spec))).map(rel);
    expect(importers).toEqual(["src/server/composition/register-providers.ts"]);

    const registrars = all.filter((file) => /\bregisterCommercialPolicyProvider\s*\(/.test(codeOnly(read(file)))).map(rel);
    expect(registrars.sort()).toEqual(["src/server/composition/register-providers.ts", "src/server/partner-reviews/commercial-policy.ts"]);

    for (const file of all) {
      if (!rel(file).endsWith("partner-reviews/commercial-policy.ts")) expect(codeOnly(read(file)), rel(file)).not.toMatch(/setCommercialPolicyProviderForTests|resetRegisteredCommercialPolicyProviderForTests/);
    }
  });

  it("the composition module registers the adapter under one stable id and is reached from exactly one place (src/instrumentation.ts)", () => {
    const composition = codeOnly(read(path.join(repoRoot, "src/server/composition/register-providers.ts")));
    expect(composition).toMatch(/registerCommercialPolicyProvider\(\{ id: AGREEMENT_COMMERCIAL_POLICY_PROVIDER_ID, provider: agreementCommercialPolicyProvider \}\)/);
    const callers = walk(path.join(repoRoot, "src")).filter((file) => importsOf(read(file)).some((spec) => /composition\/register-providers/.test(spec))).map(rel);
    expect(callers).toEqual(["src/instrumentation.ts"]);
  });

  it("the adapter is server-only, actor-independent, time-independent and read-only", () => {
    const source = code.get("src/server/finance-agreements/policy-adapter.ts")!;
    expect(source).not.toMatch(/ActorContext|actor\b|resolveActor|canAccess|canPerform|requireFinance/);
    expect(source).not.toMatch(/Date\.now|new Date\(\s*\)|performance\.now|Math\.random|randomUUID/);
    expect(source).not.toMatch(/\.(set|update|create|delete)\s*\(|runTransaction|batch\(\)/);
    expect(source).not.toMatch(/next\/|"use client"|cookies\(|headers\(/);
    // its only Partner Reviews import is the policy contract
    expect(importsOf(read(path.join(moduleDir, "policy-adapter.ts"))).filter((spec) => /partner-reviews/.test(spec))).toEqual(["@/server/partner-reviews/commercial-policy"]);
  });

  it("the adapter's local list of supported qualifying units equals Partner Reviews' own (no drift)", () => {
    expect([...PARTNER_REVIEW_QUALIFYING_UNITS]).toEqual([...QUALIFYING_UNITS]);
  });
});

// =====================================================================================================================
// Step 14B.1: the original signed Agreement document (Drive). These guards keep a test - or any stray import - from ever reaching real
// Google Drive, keep folder ids and links out of source / events / DTO shapes, and keep the storage seam the only way in.
describe("Agreement document storage (Drive) boundaries", () => {
  const srcRoot = path.join(repoRoot, "src");
  const walkAll = (dir: string, into: string[] = []): string[] => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walkAll(full, into);
      else if (full.endsWith(".ts") || full.endsWith(".tsx") || full.endsWith(".mts")) into.push(full);
    }
    return into;
  };
  const allSource = walkAll(srcRoot);
  const isTest = (file: string) => /\.test\.tsx?$/.test(file);

  it("the real Drive adapter is reachable only through the storage resolver, and 'googleapis' is loaded only by it (lazily) within Finance", () => {
    // Scoped to THIS module's own production files (not a repo-wide scan): Step 16E gives Finance
    // Invoices its own, separate document-storage/google-drive.ts behind its own resolver - a
    // sibling module's identically-named relative import is not this module's concern.
    const importers = productionFiles.filter((file) => importsOf(read(file)).some((spec) => /(^|\/)document-storage\/google-drive$|^\.\/google-drive$/.test(spec))).map((file) => path.relative(moduleDir, file));
    expect(importers).toEqual(["document-storage/index.ts"]);
    const googleapisUsers = productionFiles.filter((file) => importsOf(read(file)).includes("googleapis")).map((file) => path.relative(moduleDir, file));
    expect(googleapisUsers).toEqual(["document-storage/google-drive.ts"]);
    // dynamic import only (a top-level import would load the Google client for every route that imports the barrel)
    expect(read(path.join(moduleDir, "document-storage/google-drive.ts"))).not.toMatch(/^import[^;]*from\s+"googleapis"/m);
  });

  it("no TEST file can reach real Drive: only the adapter's own mocked-googleapis unit test imports the real adapter or 'googleapis'", () => {
    const offenders = allSource
      .filter((file) => isTest(file) && !file.endsWith(`document-storage${path.sep}document-storage.test.ts`))
      .filter((file) => {
        const source = read(file);
        return /createGoogleDriveAgreementStorage|document-storage\/google-drive|from\s+"googleapis"|import\(\s*"googleapis"\s*\)|vi\.mock\(\s*"googleapis"/.test(source);
      })
      .map(rel);
    // (any module's own *-static.test.ts legitimately names these identifiers inside string / regex
    // literals for its OWN Drive-boundary guards - e.g. Finance Invoices' equivalent guard, Step 16E -
    // without ever actually importing the real adapter or 'googleapis' itself)
    expect(offenders.filter((name) => !/-static\.test\.ts$/.test(name))).toEqual([]);
    const own = read(path.join(moduleDir, "document-storage/document-storage.test.ts"));
    expect(own).toMatch(/vi\.mock\(\s*"googleapis"/);
  });

  it("the real adapter checks the automated-test-run guard FIRST on every call, and the guard covers both NODE_ENV=test and VITEST", () => {
    const adapter = code.get("src/server/finance-agreements/document-storage/google-drive.ts")!;
    const storeBody = adapter.slice(adapter.indexOf("async store("));
    expect(storeBody.indexOf("isAutomatedTestRun()")).toBeGreaterThan(-1);
    expect(storeBody.indexOf("isAutomatedTestRun()")).toBeLessThan(storeBody.indexOf("getClient()"));
    expect(storeBody.indexOf("isAutomatedTestRun()")).toBeLessThan(storeBody.indexOf("config."));
    const guard = code.get("src/server/finance-agreements/document-storage/guard.ts")!;
    expect(guard).toMatch(/NODE_ENV === "test"/);
    expect(guard).toMatch(/process\.env\.VITEST/);
  });

  it("no Drive folder id, link or credential is hard-coded in source; folder ids come only from configuration", () => {
    for (const file of allSource.filter((f) => !isTest(f))) {
      const source = read(file);
      expect(source, rel(file)).not.toMatch(/1K8lBfs_n4N2TDwmgRjfFEHeciuH41e56|17ml7p5D5n2L5P0jyEv1cqjxBK_PVkFrG/);
    }
    const adapter = code.get("src/server/finance-agreements/document-storage/google-drive.ts")!;
    expect(adapter).not.toMatch(/drive\.google\.com\/(drive|file)/);
    const env = read(path.join(repoRoot, "src/lib/env/server.ts"));
    expect(env).toMatch(/FINANCE_AGREEMENT_DRIVE_PARTNERS_FOLDER_ID/);
    expect(env).toMatch(/FINANCE_AGREEMENT_DRIVE_VENDORS_FOLDER_ID/);
    // the tracked example documents the variables; the real credential path stays blank there
    const example = read(path.join(repoRoot, ".env.example"));
    expect(example).toMatch(/^FINANCE_AGREEMENT_DRIVE_PARTNERS_FOLDER_ID=/m);
    expect(example).toMatch(/^FINANCE_AGREEMENT_DRIVE_VENDORS_FOLDER_ID=/m);
    expect(example).toMatch(/^GOOGLE_APPLICATION_CREDENTIALS=\s*$/m);
    expect(example).toMatch(/^# FINANCE_AGREEMENT_DRIVE_MODE=fake/m);
  });

  it("the fake selection is honoured only outside production, and the fake link host is the reserved .invalid one", () => {
    const resolver = code.get("src/server/finance-agreements/document-storage/index.ts")!;
    expect(resolver).toMatch(/mode === "fake" && inputs\.nodeEnv !== "production"/);
    expect(read(path.join(moduleDir, "document-storage/in-memory.ts"))).toMatch(/https:\/\/drive\.invalid\/fake\//);
  });

  it("the Drive link / file id never appear on a DTO shape or in an audit event key: DTOs expose `link` only, events carry a file NAME and a code", async () => {
    const dto = code.get("src/server/finance-agreements/client-dto.ts")!;
    expect(dto).not.toMatch(/driveFileId/);
    expect(dto.match(/driveLink/g)?.length ?? 0).toBeLessThanOrEqual(3); // read from the stored record and copied to `link` under the finance_contracts flag only
    expect(dto).toMatch(/options\.contractDetailVisible && stored\.driveLink/);
    const { AGREEMENT_EVENT_METADATA_ALLOWLIST } = await import("./agreement-events");
    expect(Object.keys(AGREEMENT_EVENT_METADATA_ALLOWLIST).filter((key) => /link|url|fileId|driveFile|folder|locator|bucket/i.test(key))).toEqual([]);
    // the version document schema is the only place the reference is declared
    const version = z.toJSONSchema(agreementVersionDocSchema, { io: "input", unrepresentable: "any" }) as { properties: Record<string, unknown> };
    expect(Object.keys(version.properties)).toContain("document");
    expect(JSON.stringify(z.toJSONSchema(agreementEventSchema, { io: "input", unrepresentable: "any" }))).not.toMatch(/driveLink|driveFileId/);
  });

  it("only the document service writes the version's `document`, and it reads the bytes through the artifact store and the storage seam (no direct Drive / Storage client)", () => {
    const writers = productionFiles.filter((file) => /\{\s*\.\.\.\w+,\s*document,/.test(code.get(rel(file))!) && /txSetAgreementVersion\(/.test(code.get(rel(file))!) && !/export function txSetAgreementVersion/.test(code.get(rel(file))!)).map((file) => path.relative(moduleDir, file));
    expect(writers).toEqual(["agreement-document-service.ts"]);
    const service = code.get("src/server/finance-agreements/agreement-document-service.ts")!;
    expect(service).toMatch(/getContractArtifactStore\(\)\.get\(/);
    expect(service).toMatch(/getAgreementDocumentStorage\(\)/);
    expect(service).not.toMatch(/googleapis|firebase-admin\/storage|getStorage\(/);
  });
});
