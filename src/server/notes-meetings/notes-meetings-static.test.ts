import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NOTES_MEETINGS_COLLECTIONS } from "./firestore";

// Notes/Meetings Completion: the static architecture guards for this module, mirroring
// src/server/operations/operations-static.test.ts's own discipline exactly - pure source scans, no
// Firestore, no server startup.

const moduleDir = import.meta.dirname;
const routesDir = path.resolve(moduleDir, "../../app/api/notes-meetings");

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
  return found;
}

const moduleFiles = walk(moduleDir, (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).sort();
const routeFiles = walk(routesDir, (name) => name.endsWith(".ts")).sort();

const code = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), codeOnly(readFileSync(file, "utf8"))] as const));
const raw = new Map(moduleFiles.map((file) => [path.relative(moduleDir, file), readFileSync(file, "utf8")] as const));

describe("the scan itself is sound", () => {
  it("finds the module's own foundation files and the routes", () => {
    for (const expected of ["types.ts", "firestore.ts", "ids.ts", "owner-registry.ts", "notes-meetings-gate.ts", "notes-meetings-events.ts", "client-dto.ts", "http.ts", "index.ts", "promotion.ts"]) {
      expect([...code.keys()]).toContain(expected);
    }
    expect(routeFiles.length).toBeGreaterThan(15);
  });
});

describe("no hard delete anywhere - a Note is archived, a Meeting/action item is cancelled, a version is immutable", () => {
  it("there is no delete of any kind anywhere in the module or its routes", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\.delete\s*\(/);
      expect(source, name).not.toMatch(/\b(deleteDoc|recursiveDelete|bulkWriter|deleteCollection)\b/);
    }
    for (const file of routeFiles) expect(codeOnly(readFileSync(file, "utf8")), path.basename(file)).not.toMatch(/\.delete\s*\(|recursiveDelete|deleteDoc/);
  });

  it("the Firestore helper offers only a CREATE for each version subcollection - there is no set/update for one", () => {
    const firestore = code.get("firestore.ts")!;
    for (const fn of ["txCreateNoteVersion", "txCreateMeetingVersion", "txCreateActionItemVersion"]) expect(firestore).toMatch(new RegExp(`export function ${fn}\\(`));
    expect(firestore).not.toMatch(/txSet(Note|Meeting|ActionItem)Version|txUpdate(Note|Meeting|ActionItem)Version/);
  });

  it("only firestore.ts performs a direct Firestore write, and every collection name used anywhere is one of this module's own fixed constants", () => {
    const allowedCollections = new Set<string>(Object.values(NOTES_MEETINGS_COLLECTIONS));
    for (const [name, source] of code) {
      for (const match of source.matchAll(/\.collection\(\s*["'`]([^"'`]+)["'`]/g)) expect(allowedCollections.has(match[1]!), `${name}: collection("${match[1]}")`).toBe(true);
      if (name === "firestore.ts") continue;
      expect(source, `${name} performs a direct Firestore write`).not.toMatch(/\btx\.(set|create|update|delete)\s*\(/);
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
});

describe("owner composition (spec section 10): never a parallel RecordScope re-implementation", () => {
  it("owner-registry.ts calls each owning module's own gated getter and nothing else business-shaped", () => {
    const registry = code.get("owner-registry.ts")!;
    for (const getter of ["getLead", "getPartner", "getVendor", "getCampaign", "getAssignment", "getContent"]) expect(registry).toMatch(new RegExp(getter));
  });

  it("the gate never imports a business module's Firestore internals directly", () => {
    for (const [name, source] of raw) {
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(/partners\/firestore|vendors\/firestore|campaigns\/firestore|assignments\/firestore|content\/firestore|discovery\/firestore/);
    }
  });

  it("no file reads actor.role, compares a role name, or uses a rank/minimumRole helper (explicit grants only)", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/\bactor\.role\b|\.role\s*(===|!==|==|!=)/);
      expect(source, name).not.toMatch(/\bminimumRole\b|\broleRank\b|\bROLE_RANK\b|\bhasRoleAtLeast\b/i);
    }
  });
});

describe("promotion (spec section 9/19): the ONE place this module writes into Operations, never a bespoke second Task system", () => {
  it("only promotion.ts imports the Operations WRITE surface (generateSystemTask/getTask/ids) - owner-registry.ts's only Operations import is the read-only, shared TargetReference/TargetType shape (a type-only reuse of the same opaque ref convention, never a write)", () => {
    for (const [name, source] of raw) {
      if (name === "promotion.ts") continue;
      if (name === "owner-registry.ts") {
        for (const spec of importsOf(source)) if (spec.startsWith("@/server/operations")) expect(spec, `${name} imports ${spec}`).toBe("@/server/operations/target-ref");
        continue;
      }
      // promoted-task-display.ts is the ONE other file allowed to reach Operations - a READ-only
      // getTask call (never a write) shared by promotion.ts and action-item-service.ts so a
      // MeetingActionItem's promotedTaskDisplayName resolves identically on every read path, not only
      // right after promotion (spec section 15) - kept out of both callers to avoid a circular import.
      if (name === "promoted-task-display.ts") {
        expect(source).toMatch(/import { getTask } from "@\/server\/operations"/);
        expect(source).not.toMatch(/generateSystemTask|createTask|tx\.(set|create|update|delete)/);
        continue;
      }
      for (const spec of importsOf(source)) expect(spec, `${name} imports ${spec}`).not.toMatch(/^@\/server\/operations/);
    }
  });

  it("promotion.ts never writes directly to an operationsTasks collection - it only calls the published generateSystemTask/getTask surface", () => {
    const promotion = code.get("promotion.ts")!;
    expect(promotion).toMatch(/generateSystemTask/);
    expect(promotion).not.toMatch(/collection\(\s*["'`]operationsTasks["'`]/);
  });

  it("no file declares Task's own richer status vocabulary (BLOCKED) - MeetingActionItem's own status enum stays the compact OPEN/IN_PROGRESS/DONE/CANCELLED only (spec section 8: never mirror Task's full lifecycle). `URGENT` legitimately appears once, in types.ts's promoteActionItemInputSchema, as a pass-through Task priority for the promotion request - not a competing status.", () => {
    for (const [name, source] of code) {
      expect(source, name).not.toMatch(/["'`]BLOCKED["'`]/);
    }
    const types = code.get("types.ts")!;
    expect(types).toMatch(/ACTION_ITEM_STATUSES = \["OPEN", "IN_PROGRESS", "DONE", "CANCELLED"\]/);
  });
});

describe("no sensitive-data leakage in a Notes/Meetings DTO or event", () => {
  it("no property with an identity-value, raw-storage-locator, or credential name is declared anywhere in the module", () => {
    const FORBIDDEN_PROPERTY = /\b(panNumber|aadhaarNumber|bankAccountNumber|accountNumber|ifsc|gstin|gstNumber|password|apiKey|token|credential|bucketName|objectPath)\s*\??\s*:/i;
    for (const [name, source] of code) expect(source, name).not.toMatch(FORBIDDEN_PROPERTY);
  });

  it("client-dto.ts never imports Firestore, the attachment store, the gate, or a business module's internals", () => {
    for (const spec of importsOf(raw.get("client-dto.ts")!)) {
      expect(spec, `client-dto imports ${spec}`).not.toMatch(/\.\/firestore$|\.\/attachment-store$|firebase\/admin|partners\/|vendors\/|-gate$|authz\/(?!types)/);
    }
    expect(code.get("http.ts")).not.toMatch(/firestore/);
  });

  it("the attachment DTO never carries the opaque Storage locator - only attachmentRef/fileName/mimeType/size/uploader", () => {
    const dto = code.get("client-dto.ts")!;
    const attachmentDtoBlock = dto.split("export type AttachmentDto")[1]!.split("};")[0]!;
    expect(attachmentDtoBlock).not.toMatch(/locator/);
  });
});

describe("no external notification/OCR/Drive integration this stage (spec sections 10/13/20)", () => {
  it("no file or route references an email/SMS/Slack/push provider", () => {
    for (const [name, source] of raw) expect(source, name).not.toMatch(/twilio|sendgrid|nodemailer|slack\.com|firebase-messaging|webpush|smtp/i);
    for (const file of routeFiles) expect(readFileSync(file, "utf8"), path.basename(file)).not.toMatch(/twilio|sendgrid|nodemailer|slack\.com|firebase-messaging|webpush|smtp/i);
  });

  it("no file calls Google Drive or an OCR SDK - attachments are Storage-emulator/in-memory only", () => {
    for (const [name, source] of raw) {
      expect(source, name).not.toMatch(/googleapis|drive\.files|DriveClient/i);
      expect(source, name).not.toMatch(/\bocr\b/i);
    }
  });

  it("no fake/persisted notification record is ever created (section 20's explicit prohibition)", () => {
    for (const [name, source] of code) expect(source, name).not.toMatch(/collection\(\s*["'`]notifications["'`]/i);
  });
});

describe("no route re-implements authorization: each one resolves the actor and calls a service", () => {
  it("every route calls resolveRequestActor and none calls canAccessFeature/canPerformAction/getAdminFirestore directly", () => {
    for (const file of routeFiles) {
      const source = codeOnly(readFileSync(file, "utf8"));
      expect(source, path.basename(file)).toMatch(/resolveRequestActor\(\)/);
      expect(source, path.basename(file)).not.toMatch(/canAccessFeature|canPerformAction|getActorScopeGrants|getAdminFirestore/);
    }
  });
});
