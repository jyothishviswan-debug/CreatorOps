import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { OPERATIONS_COLLECTIONS } from "./firestore";
import { operationsReminderHeadDocSchema, operationsTaskHeadDocSchema, taskVersionDocSchema } from "./types";

// Step 18A section 15: the STATIC ARCHITECTURE GUARDS of the Operations module. Pure source scans
// (no Firestore) - they fail loudly if a future change wires the wrong thing across a boundary.
// Scope: every non-test .ts file in this module directory and its sub-folders, plus the Operations
// API routes. Mirrors src/server/finance-payments/finance-payments-static.test.ts exactly.

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/operations");
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
    for (const expected of ["types.ts", "firestore.ts", "ids.ts", "target-ref.ts", "operations-gate.ts", "task-events.ts", "reminder-events.ts", "client-dto.ts", "http.ts", "index.ts", "approval-queue/types.ts", "approval-queue/approval-queue-service.ts"]) {
      expect([...code.keys()]).toContain(expected);
    }
    expect(routeFiles.length).toBeGreaterThan(15);
    expect(codeOnly("const a = 1; // campaign\n// assignment\n/* creator */ const b = 2;")).not.toMatch(/campaign|assignment|creator/);
  });
});

describe("section 6: the Approval Queue never becomes a second approval engine", () => {
  it("no file in this module (or its routes) assigns/declares a persisted approval status field - `currentSourceStatus` is always read straight through from a source DTO, never assigned a literal", () => {
    for (const [name, source] of code) {
      if (!name.startsWith("approval-queue")) continue;
      // The only literal-status assignment allowed anywhere in the Approval Queue surface is
      // copying the source module's OWN dto field (`row.status` / `head.latestStatus`) into
      // currentSourceStatus - never a hand-authored literal like "PENDING"/"APPROVED"/etc.
      expect(source, name).not.toMatch(/currentSourceStatus:\s*["'`]/);
    }
  });

  it("no Approval Queue file performs a Firestore write, and none names a Firestore collection at all - it is a pure derived read model", () => {
    for (const [name, source] of code) {
      if (!name.startsWith("approval-queue")) continue;
      expect(source, `${name} performs a Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
      expect(source, `${name} calls getAdminFirestore`).not.toMatch(/getAdminFirestore\(\)/);
      expect(source, `${name} names a Firestore collection`).not.toMatch(/\.collection\(/);
    }
  });

  it("no Approval Queue adapter CALLS a source module's write function (comments may mention one by name for context; only real calls - `name(` - are forbidden), and imports only that module's published barrel", () => {
    const forbiddenCalls =
      /\b(finalizePartnerReview|submitPartnerReviewForReview|createPayable|revisePayable|addPayableAdjustment|removePayableAdjustment|confirmPayableTax|markPayableReadyForInvoice|voidPayable|createInvoiceDraft|reviseInvoiceDraft|submitInvoice|approveInvoice|rejectInvoice|reopenInvoice|voidInvoice|acceptInvoiceMismatch|resolveInvoicePayeeMismatch|createPaymentDraft|revisePaymentDraft|recordPayment|confirmPayment|failPayment|reopenPayment|voidPayment)\s*\(/;
    for (const [name, source] of code) {
      if (!name.startsWith("approval-queue")) continue;
      expect(source, `${name} calls a source-module WRITE function`).not.toMatch(forbiddenCalls);
      for (const spec of importsOf(raw.get(name)!)) {
        if (spec.startsWith("@/server/partner-reviews")) expect(spec, `${name} imports ${spec}`).toBe("@/server/partner-reviews/partner-review-list-service");
        if (spec.startsWith("@/server/finance-payables")) expect(spec, `${name} imports ${spec}`).toBe("@/server/finance-payables");
        if (spec.startsWith("@/server/finance-invoices")) expect(spec, `${name} imports ${spec}`).toBe("@/server/finance-invoices");
        if (spec.startsWith("@/server/finance-payments")) expect(spec, `${name} imports ${spec}`).toBe("@/server/finance-payments");
      }
    }
  });

  it("Step 18A ships NO act_on_approval_queue action and NO generic setStatus/act function anywhere in the module or its routes", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/act_on_approval_queue/);
      expect(source, name).not.toMatch(/function\s+setStatus\s*\(/);
      expect(source, name).not.toMatch(/function\s+actOnApproval/);
    }
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.basename(file)).not.toMatch(/act_on_approval_queue/);
    }
    // No route exists to act on an approval item beyond list/get/refresh (all read-only).
    const approvalsRoutesDir = path.join(routesDir, "approvals");
    const approvalRoutes = routeFiles.filter((f) => f.startsWith(approvalsRoutesDir + path.sep)).map((f) => path.relative(approvalsRoutesDir, f).split(path.sep).join("/"));
    expect(approvalRoutes.sort()).toEqual(["[approvalItemRef]/refresh/route.ts", "[approvalItemRef]/route.ts", "route.ts"].sort());
  });

  it("every approvalItemRef is a pure function of its source coordinates (buildApprovalItemRef), never randomly generated - proves 'one Approval projection per exact source action/version'", () => {
    const ids = code.get("ids.ts")!;
    expect(ids).toMatch(/export function buildApprovalItemRef/);
    expect(ids.split("export function buildApprovalItemRef")[1]).not.toMatch(/randomUUID/);
  });
});

describe("record scope: Operations does not derive scope live from any of the 11 target modules", () => {
  it("no file outside the approval-queue adapters imports a business module's Firestore internals or gate", () => {
    const forbiddenModules = /partners\/firestore|vendors\/firestore|campaigns\/firestore|assignments\/firestore|content\/firestore|partner-reviews\/firestore|finance-agreements\/firestore|finance-payables\/firestore|finance-invoices\/firestore|finance-payments\/firestore|-gate["']/;
    for (const [name, source] of raw) {
      if (name.startsWith("approval-queue")) continue;
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(forbiddenModules);
    }
  });
});

describe("explicit grants only: no role names, no role reads, no rank", () => {
  it("never reads actor.role, compares a role name, imports the role catalog, or uses a rank/minimumRole helper", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
      expect(source, name).not.toMatch(/["'`](viewer|analyst|partnership_manager|partnership_head|super_admin)["'`]/);
      expect(source, name).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b|\bisAtLeast\w*Role\b/i);
      for (const spec of importsOf(raw.get(name)!)) expect(spec, `${name} imports ${spec}`).not.toMatch(/authz\/roles$/);
    }
  });

  it("the gate authorizes only through canAccessFeature / canPerformAction plus the explicit scope-grant primitives", () => {
    const gate = code.get("operations-gate.ts")!;
    expect(gate).toMatch(/canAccessFeature\(actor, "operations"\)/);
    expect(gate).toMatch(/canPerformAction\(actor, "operations", action\)/);
    expect(gate).toMatch(/hasGlobalScope/);
    expect(gate).toMatch(/isSelfInScope/);
  });

  it("each Operations action has its own exact grant name, never a role check or a shared generic action", () => {
    const source = [...code.values()].join("\n");
    for (const action of ["manage_tasks", "assign_tasks", "complete_tasks", "view_approval_queue", "manage_reminders"]) expect(source).toMatch(new RegExp(action));
  });

  it("no route re-implements authorization: each one resolves the actor and calls a service", () => {
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.basename(file)).toMatch(/resolveRequestActor\(\)/);
      expect(source, path.basename(file)).not.toMatch(/canAccessFeature|canPerformAction|getActorScopeGrants|getAdminFirestore/);
    }
  });
});

describe("no hard delete anywhere, and a Task version is immutable once written", () => {
  it("there is no delete of any kind (doc, batch, transaction, recursive) anywhere in the module or its routes", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\.delete\s*\(/);
      expect(source, name).not.toMatch(/\b(deleteDoc|recursiveDelete|bulkWriter|deleteCollection)\b/);
    }
    for (const file of routeFiles) {
      expect(codeOnly(readFileSync(file, "utf8")), path.basename(file)).not.toMatch(/\.delete\s*\(|recursiveDelete|deleteDoc/);
    }
  });

  it("the Firestore helper offers only a CREATE for a task version - there is no set/update for one", () => {
    const firestore = code.get("firestore.ts")!;
    expect(firestore).toMatch(/export function txCreateTaskVersion\(/);
    expect(firestore).not.toMatch(/txSetTaskVersion|txUpdateTaskVersion/);
  });

  it("only the module's own Firestore helper performs a write, and it names only Operations collections", () => {
    const allowedCollections = new Set<string>(Object.values(OPERATIONS_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowedCollections.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
      if (name === "firestore.ts") continue;
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\bgetAdminFirestore\(\)\s*\.collection/);
    }
  });
});

describe("bounded queries only - never a whole-collection scan", () => {
  it("every function in firestore.ts that calls .orderBy(...).get() also carries an explicit .limit(...)", () => {
    const firestore = code.get("firestore.ts")!;
    const functionBlocks = firestore.split(/\nexport (?:async )?function /).slice(1);
    const queryBlocks = functionBlocks.filter((block) => /\.orderBy\(/.test(block) && /\.get\(\)/.test(block));
    expect(queryBlocks.length).toBeGreaterThan(0);
    for (const block of queryBlocks) expect(block.split(".get()")[0]).toMatch(/\.limit\(/);
  });

  it("no arbitrary collection target ref: a Firestore collection name is never built from `targetType`/`targetRef` - only the module's own fixed OPERATIONS_COLLECTIONS constants", () => {
    for (const [name, source] of code) {
      expect(source, `${name} builds a collection name from a target field`).not.toMatch(/\.collection\(\s*(target|targetType|targetRef)\b/);
    }
    const targetRef = code.get("target-ref.ts")!;
    expect(targetRef).toMatch(/export const TARGET_TYPES = \[/);
  });
});

describe("no sensitive-data leakage in an Operations DTO", () => {
  it("no property with an identity-value, raw-bank-data, or Drive/credential name is declared anywhere in the module", () => {
    const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|accountHolderName|panHolderName|gstin|gstNumber|kyc|driveFileId|webViewLink|signedUrl|driveUrl|password|apiKey|token|credential)\s*\??\s*:/i;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });

  it("the stored Task/Reminder shapes carry no identity value and no scope field ever reaches client-dto.ts", () => {
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
    for (const schema of [taskVersionDocSchema, operationsTaskHeadDocSchema, operationsReminderHeadDocSchema]) walkSchema(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
    expect([...names].filter((n) => /^(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|gstin|gstNumber|signedUrl|driveUrl|webViewLink|driveFileId)$/i.test(n))).toEqual([]);

    const dto = code.get("client-dto.ts")!;
    for (const scopeField of ["ownerUid", "regionIds", "teamIds"]) expect(dto, `client-dto exposes ${scopeField}`).not.toMatch(new RegExp(`\\b${scopeField}\\b`));
  });

  it("the DTO builder never imports Firestore, the gate, or any business module's internals", () => {
    for (const spec of importsOf(raw.get("client-dto.ts")!)) {
      expect(spec, `client-dto imports ${spec}`).not.toMatch(/\.\/firestore$|firebase\/admin|partners\/|vendors\/|-gate$|authz\/(?!types)/);
    }
    expect(code.get("http.ts")).not.toMatch(/firestore/);
  });
});

describe("no external notification integration, no Drive/OCR/bank calls, no cron infrastructure", () => {
  it("no Operations file or route references an email/SMS/Slack/push provider", () => {
    for (const [name, source] of raw) expect(source, name).not.toMatch(/twilio|sendgrid|nodemailer|slack\.com|firebase-messaging|webpush|smtp/i);
    for (const file of routeFiles) expect(readFileSync(file, "utf8"), path.basename(file)).not.toMatch(/twilio|sendgrid|nodemailer|slack\.com|firebase-messaging|webpush|smtp/i);
  });

  it("no Operations file or route calls Google Drive/OCR or a bank/payment-gateway SDK", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/googleapis|drive\.files|DriveClient/i);
      expect(source, name).not.toMatch(/\bocr\b/i);
      expect(source, name).not.toMatch(/stripe|razorpay|paypal|plaid|payment-gateway|bank-gateway/i);
    }
  });

  it("no cron/scheduler infrastructure - a due Reminder is derived at read time only (deriveReminderEffectiveStatus), never written by a background job", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/node-cron|node-schedule|setInterval\s*\(|cron\.schedule/);
    }
    const dto = code.get("client-dto.ts")!;
    expect(dto).toMatch(/export function deriveReminderEffectiveStatus/);
  });

  it("a due Reminder overlay function never writes - deriveReminderEffectiveStatus takes no transaction/Firestore argument and appears nowhere near a tx.set/create", () => {
    const dto = code.get("client-dto.ts")!;
    const fn = dto.split("export function deriveReminderEffectiveStatus")[1]!.split(/\n}\n/)[0]!;
    expect(fn).not.toMatch(/tx\.|getAdminFirestore|\.set\(|\.create\(/);
  });
});

describe("no Operations UI in Step 18A (the existing placeholder route is untouched)", () => {
  it("no .tsx file anywhere imports the Operations backend module", () => {
    const componentFiles = walk(appDir, (name) => name.endsWith(".tsx"));
    for (const file of componentFiles) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        expect(spec, `${path.relative(srcDir, file)} imports ${spec}`).not.toMatch(/@\/server\/operations/);
      }
    }
  });

  it("the operations app route directory holds only its four pre-existing placeholder pages - no new page was added", () => {
    const opsAppDir = path.join(appDir, "operations");
    const files = walk(opsAppDir, (name) => name.endsWith(".tsx"))
      .map((f) => path.relative(srcDir, f).split(path.sep).join("/"))
      .sort();
    expect(files).toEqual(["app/operations/approvals/page.tsx", "app/operations/page.tsx", "app/operations/reminders/page.tsx", "app/operations/tasks/page.tsx"].sort());
  });
});

describe("no approved Overview page is touched or referenced (UI freeze)", () => {
  const OVERVIEW_SURFACES = [/@\/ui\/Overview/, /@\/ui\/overview\.css/, /OverviewPage/, /OverviewTab/, /overview-model/, /overview-aggregate/, /overview-metrics/, /overview-service/];

  it("no Operations server file or route imports or names an Overview surface", () => {
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
