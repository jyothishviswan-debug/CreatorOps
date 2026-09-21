import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agreementDraftEntrySchema,
  agreementEventSchema,
  agreementHeadDocSchema,
  agreementVersionDocSchema,
  confirmedAgreementTermsSchema,
  contactSnapshotSchema,
  extractionRunDocSchema,
  identityStatusSnapshotSchema,
} from "./types";
import { FINANCE_AGREEMENT_COLLECTIONS } from "./firestore";

// Step 14A: static architecture boundaries of the Finance Agreements module. Pure source scans
// (no Firestore) - they fail loudly if a future change wires the wrong thing across a boundary.
// Scope: every non-test .ts file directly in this module directory (sub-folders such as
// extraction/ and contract-artifacts/ carry their own tests).

const moduleDir = import.meta.dirname;

const moduleFiles = readdirSync(moduleDir)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

function readModule(name: string): string {
  return readFileSync(path.join(moduleDir, name), "utf8");
}

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

const code = new Map(moduleFiles.map((name) => [name, codeOnly(readModule(name))] as const));

describe("the scan itself is sound", () => {
  it("finds the module's own foundation files and strips comments", () => {
    for (const expected of ["types.ts", "terms.ts", "fields.ts", "firestore.ts", "agreement-events.ts", "finance-agreements-gate.ts", "client-dto.ts", "http.ts", "ids.ts"]) {
      expect(moduleFiles).toContain(expected);
    }
    expect(codeOnly("const a = 1; // campaign\n// assignment\n/* creator */ const b = 2;")).not.toMatch(/campaign|assignment|creator/);
  });
});

describe("no Campaign / Assignment / Deliverable / Creator concept", () => {
  it("no identifier or string in executable code mentions one (the policy adapter may name Partner Reviews' own monthlyDeliverableRequirement contract field, nothing else)", () => {
    for (const [name, source] of code) {
      // The product name may appear in its enum spelling (MISSING_IN_CREATOROPS, KEEP_CREATOROPS_VALUE) as well as CreatorOps.
      let scanned = source.replace(/CreatorOps|CREATOROPS/g, "");
      if (name === "policy-adapter.ts") scanned = scanned.replace(/monthlyDeliverableRequirement/g, "");
      expect(scanned, name).not.toMatch(/campaign|assignment|creator|deliverable/i);
    }
  });
});

describe("no Payables / Invoices / Payments", () => {
  it("imports no payable/invoice/payment module and touches no such collection", () => {
    for (const [name, source] of code) {
      for (const spec of importsOf(readModule(name))) expect(spec, `${name} imports ${spec}`).not.toMatch(/(^|\/)(payables?|invoices?|payments?)(\/|$)/i);
      expect(source, name).not.toMatch(/collection\(\s*["'`](payables?|invoices?|payments?|payableLines?|settlements?)\b/i);
    }
    for (const value of Object.values(FINANCE_AGREEMENT_COLLECTIONS)) expect(value).not.toMatch(/payable|invoice|payment|settlement/i);
  });

  it("only ever names collections from FINANCE_AGREEMENT_COLLECTIONS (plus the Partner/Vendor stores it reads through their own modules)", () => {
    const allowed = new Set<string>(Object.values(FINANCE_AGREEMENT_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowed.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
    }
  });
});

describe("no deletes on Agreement data", () => {
  it("there is no delete of any kind (doc, batch, transaction, recursive) anywhere in the module", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\.delete\s*\(/);
      expect(source, name).not.toMatch(/\b(deleteDoc|recursiveDelete|bulkWriter|deleteCollection)\b/);
    }
  });
});

describe("explicit grants only: no role names, no role reads, no rank", () => {
  it("never reads actor.role, compares a role name, imports the role catalog, or uses a rank / minimumRole helper", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
      expect(source, name).not.toMatch(/["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
      expect(source, name).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b|\bisAtLeast\w*Role\b|\brank\b/i);
      for (const spec of importsOf(readModule(name))) expect(spec, `${name} imports ${spec}`).not.toMatch(/authz\/roles$/);
    }
  });

  it("the gate authorizes only through canAccessFeature / canPerformAction / canAccessSensitive", () => {
    const gate = code.get("finance-agreements-gate.ts")!;
    expect(gate).toMatch(/canAccessFeature\(actor, "finance"\)/);
    expect(gate).toMatch(/canPerformAction\(actor, "finance", action\)/);
    expect(gate).toMatch(/canAccessSensitive\(actor, FINANCE_CONTRACTS_CATEGORY\)/);
    expect(gate).toMatch(/isPartnerDocInScope/);
    expect(gate).toMatch(/isVendorDocInScope/);
  });
});

describe("no restricted identity VALUE field in an ordinary schema or DTO", () => {
  // fields.ts is the registry: it NAMES the identity fields (as quoted keys mapped to z.null()) and is
  // exercised by fields.test.ts. Every other file must not declare a property with these names.
  const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber)\s*\??\s*:/;

  it("no property with an identity-value name is declared or built outside the field registry", () => {
    for (const [name, source] of code) {
      if (name === "fields.ts") continue;
      expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
    }
  });

  it("the ordinary (non-restricted) stored shapes contain no identity-value property anywhere", () => {
    const names = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (key === "properties" && child && typeof child === "object") Object.keys(child).forEach((property) => names.add(property));
          walk(child);
        }
      }
    };
    for (const schema of [confirmedAgreementTermsSchema, contactSnapshotSchema, identityStatusSnapshotSchema, agreementVersionDocSchema, agreementHeadDocSchema, agreementDraftEntrySchema, agreementEventSchema, extractionRunDocSchema]) {
      walk(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
    }
    expect(names.size).toBeGreaterThan(40);
    // identity appears only as component names + status
    expect([...names].filter((n) => /^(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber|rawValue|rawSnippet|storageLocator)$/i.test(n))).toEqual([]);
    for (const component of ["pan", "aadhaar", "gst", "bank"]) expect(names.has(component)).toBe(true);
  });

  it("the DTO builders never import the restricted identity store, the restricted extraction reader or the Firestore helpers", () => {
    for (const spec of importsOf(readModule("client-dto.ts"))) {
      expect(spec).not.toMatch(/restricted-financial-identity|\.\/firestore$|firebase\/admin|partners\/|vendors\//);
    }
    expect(code.get("client-dto.ts")).not.toMatch(/getRestrictedExtractionDoc|restrictedExtraction|storageLocator/);
    expect(code.get("http.ts")).not.toMatch(/firestore/);
  });
});

describe("no reach into Partner Reviews internals", () => {
  it("the only Partner Reviews import allowed is its commercial-policy contract", () => {
    for (const name of moduleFiles) {
      for (const spec of importsOf(readModule(name))) {
        if (/partner-reviews/.test(spec)) expect(spec, `${name} imports ${spec}`).toBe("@/server/partner-reviews/commercial-policy");
      }
    }
  });
});
