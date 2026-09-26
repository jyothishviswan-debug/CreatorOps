// Export Center against the running Firestore/Auth/Storage emulator, end to end, on REAL records and
// through every real source module's own gate (never mocked). Mirrors
// src/server/reports/reports.emulator.test.ts's own discipline.
//
// Proven here (spec's own "at minimum" authorization/scope-closure list):
//   - Catalog visibility: denied for every role without the "exports" feature grant, denied for the
//     one identity whose per-user override explicitly revokes it despite the role baseline, allowed
//     for Super Admin.
//   - Action-level denial: an actor holding "exports" VIEW but not the create_exports ACTION is
//     denied job creation specifically (not the same as feature_denied).
//   - Per-target source-feature gating: an actor authorized for Export Center in general but lacking
//     the Assignments feature is denied creating an Assignments export specifically (scope_denied),
//     while Super Admin (holding every feature) succeeds on the same target.
//   - Record scope: two real region-scoped actors each get ONLY their own in-scope Partner rows in
//     the generated file - proven by actually downloading and parsing the artifact bytes, not just
//     trusting rowCount.
//   - Column/target/format tampering: unknown column, duplicate column, column valid for a different
//     target, unknown target id, unsupported format - all rejected server-side before any source read.
//   - Cross-actor denial: a guessed jobRef/artifact belonging to a different actor gets the same
//     neutral 404 a genuinely-missing one would.
//   - Job lifecycle + history: PENDING -> GENERATING -> COMPLETED is a real persisted transition;
//     listMyExportJobs is scoped to the caller's own jobs only.
//   - CSV/XLSX/PDF are each generated end to end through the full service (not just the pure
//     generator unit tests) and parsed back for real.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAssignment } from "@/server/assignments/assignment-service";
import { assignmentsCollection } from "@/server/assignments/firestore";
import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { seedAccessControlData, TEST_IDENTITIES } from "@/server/authz/seed-access-data";
import { scopeGrantDocId } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { seedEmulatorTestUsers } from "@/server/auth/seed-users";
import { createCampaign } from "@/server/campaigns/campaign-service";
import { campaignsCollection } from "@/server/campaigns/firestore";
import { transitionCampaignLifecycle } from "@/server/campaigns/campaign-lifecycle-service";
import { getAdminFirestore } from "@/server/firebase/admin";
import { createPartner } from "@/server/partners/partner-service";
import { partnersCollection } from "@/server/partners/firestore";

import { setExportArtifactStoreForTests, createInMemoryExportArtifactStore } from "./artifact-store";
import { createExportJob, getExportArtifactForActor, getExportJobForActor, listExportTargetsForActor, listMyExportJobs } from "./export-service";
import { exportJobsCollection } from "./firestore";
import type { ExportJobDto } from "./client-dto";
import type { ExportsServiceResult } from "./types";

vi.setConfig({ testTimeout: 60_000 });

// This suite's job/artifact generation is REAL end-to-end (real column validation, real bounded
// listPartners/listCampaigns/listAssignments reads, real csv/xlsx/pdf byte generation) - only the
// bytes' final resting place is swapped to an in-memory store, so this file never depends on a
// Storage emulator being up (that dependency is covered separately by artifact-store.emulator.test.ts,
// which proves the REAL Firebase Storage adapter works). This mirrors the same "swap only the
// storage seam under test" discipline the finance-agreements module already established.
setExportArtifactStoreForTests(createInMemoryExportArtifactStore());
afterAll(() => setExportArtifactStoreForTests(null));

const runId = Date.now();
const uidByRole = new Map<string, string>();
let reqCounter = 0;
const requestId = () => `exp-req-${runId}-${(reqCounter += 1)}`;

function must<T>(result: ExportsServiceResult<T>, label: string): T {
  if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}`);
  return result.data;
}

function failure<T>(result: ExportsServiceResult<T>) {
  if (result.ok) throw new Error("expected a failure, got a success");
  return result;
}

async function actorFor(role: string): Promise<ActorContext> {
  const actor = await resolveActor(uidByRole.get(role)!);
  if (!actor) throw new Error(`no seeded actor for ${role}`);
  return actor;
}

// A synthetic actor - a real role-baseline lookup (accessGrants/{role}), but a fresh, non-Auth-backed
// uid/userRef with NO userAccessOverrides doc (so canAccessFeature/canPerformAction fall through to
// the plain role baseline) and its OWN scopeAssignments grants, written directly below. This is the
// only way to exercise a real "exports + a specific region scope, together" actor, since none of the
// five fixed seeded test identities happens to combine both (Export Center access is Analyst/Super-
// Admin-only, while the seeded analyst@creatorops.com identity itself carries a deliberate
// per-user override denying exports - see seed-access-data.ts's own USER_OVERRIDES comment).
function syntheticActor(tag: string, role: ActorContext["role"]): ActorContext {
  return { uid: `export-test-${tag}-${runId}`, email: `export-test-${tag}-${runId}@example.com`, role, displayName: `Export Test ${tag}`, userRef: `export-test-ref-${tag}-${runId}` };
}

async function grantRegion(actor: ActorContext, region: string): Promise<void> {
  const db = getAdminFirestore();
  const grant = { type: "REGION" as const, region, uid: actor.uid, grantedAt: new Date().toISOString(), grantedBy: "system:test" };
  await db.collection(COLLECTIONS.scopeAssignments).doc(scopeGrantDocId(actor.uid, { type: "REGION", region })).set(grant);
}

const partnerRefs: string[] = [];
const campaignRefs: string[] = [];
const assignmentRefs: string[] = [];

let admin: ActorContext;
let keralaPartnerRef: string;
let delhiPartnerRef: string;
let campaignRef: string;
let assignmentRef: string;

// Two synthetic Export-Center-authorized actors, each with exactly one region grant - the load-
// bearing record-scope proof.
const exporterKerala = syntheticActor("kerala", "analyst");
const exporterDelhi = syntheticActor("delhi", "analyst");
// An actor with "exports" VIEW (per-user override) but no create_exports ACTION at all - the
// action-level (not feature-level) denial proof. Role baseline is "viewer" (no exports entry), so
// the action check falls through to "denied".
const viewOnlyActor = syntheticActor("view-only", "viewer");

beforeAll(async () => {
  const password = process.env.EMULATOR_TEST_USER_PASSWORD;
  if (!password) throw new Error("EMULATOR_TEST_USER_PASSWORD is not set - check .env.local. Requires a running Firebase emulator.");
  await seedEmulatorTestUsers(password);
  await seedAccessControlData();
  for (const identity of TEST_IDENTITIES) {
    const { getAdminAuth } = await import("@/server/firebase/admin");
    const user = await getAdminAuth().getUserByEmail(identity.email);
    uidByRole.set(identity.role, user.uid);
  }

  admin = await actorFor("super_admin");

  await grantRegion(exporterKerala, "Kerala");
  await grantRegion(exporterDelhi, "Delhi");

  const db = getAdminFirestore();
  await db
    .collection(COLLECTIONS.userAccessOverrides)
    .doc(viewOnlyActor.uid)
    .set({ uid: viewOnlyActor.uid, features: { exports: { view: true, actions: {} } }, version: 1 });

  const keralaPartner = await createPartner(admin, { displayName: `Export Fixture Partner Kerala ${runId}`, regionIds: ["Kerala"] }, requestId());
  if (!keralaPartner.ok) throw new Error(`createPartner (Kerala) failed: ${keralaPartner.code} - ${keralaPartner.message}`);
  keralaPartnerRef = (keralaPartner.data as { partnerRef: string }).partnerRef;
  partnerRefs.push(keralaPartnerRef);

  const delhiPartner = await createPartner(admin, { displayName: `Export Fixture Partner Delhi ${runId}`, regionIds: ["Delhi"] }, requestId());
  if (!delhiPartner.ok) throw new Error(`createPartner (Delhi) failed: ${delhiPartner.code} - ${delhiPartner.message}`);
  delhiPartnerRef = (delhiPartner.data as { partnerRef: string }).partnerRef;
  partnerRefs.push(delhiPartnerRef);

  const campaign = await createCampaign(admin, { name: `Export Fixture Campaign ${runId}`, objective: "Certify Export Center", startDate: "2026-01-01", endDate: "2026-12-31", defaultReviewPolicy: "NO_PREPOST_REVIEW", regionIds: ["Kerala"], platforms: ["instagram"] }, requestId());
  if (!campaign.ok) throw new Error(`createCampaign failed: ${campaign.code} - ${campaign.message}`);
  campaignRef = campaign.data.campaignRef;
  campaignRefs.push(campaignRef);

  const planned = await transitionCampaignLifecycle(admin, campaignRef, { to: "PLANNED", expectedVersion: campaign.data.version }, requestId());
  if (!planned.ok) throw new Error(`transitionCampaignLifecycle(PLANNED) failed: ${planned.code} - ${planned.message}`);

  const assignment = await createAssignment(admin, { campaignRef, partnerRef: keralaPartnerRef }, requestId());
  if (!assignment.ok) throw new Error(`createAssignment failed: ${assignment.code} - ${assignment.message}`);
  assignmentRef = assignment.data.assignmentRef;
  assignmentRefs.push(assignmentRef);
});

afterAll(async () => {
  const db = getAdminFirestore();
  for (const ref of partnerRefs) await partnersCollection().doc(ref).delete().catch(() => {});
  for (const ref of campaignRefs) await campaignsCollection().doc(ref).delete().catch(() => {});
  for (const ref of assignmentRefs) await assignmentsCollection().doc(ref).delete().catch(() => {});
  await db.collection(COLLECTIONS.scopeAssignments).doc(scopeGrantDocId(exporterKerala.uid, { type: "REGION", region: "Kerala" })).delete().catch(() => {});
  await db.collection(COLLECTIONS.scopeAssignments).doc(scopeGrantDocId(exporterDelhi.uid, { type: "REGION", region: "Delhi" })).delete().catch(() => {});
  await db.collection(COLLECTIONS.userAccessOverrides).doc(viewOnlyActor.uid).delete().catch(() => {});
});

describe("catalog visibility", () => {
  it("Super Admin sees the full 3-target catalog", async () => {
    const data = must(await listExportTargetsForActor(admin), "catalog(admin)");
    expect(data.map((d) => d.targetId).sort()).toEqual(["assignments", "campaigns", "partners"]);
  });

  it("Viewer/Manager/Head - none hold the exports feature at all - are denied the catalog", async () => {
    for (const role of ["viewer", "partnership_manager", "partnership_head"]) {
      const actor = await actorFor(role);
      const result = failure(await listExportTargetsForActor(actor));
      expect(result.code).toBe("unauthorized");
      expect(result.reason).toBe("feature_denied");
    }
  });

  it("the seeded Analyst identity is denied by its own explicit per-user override, despite the role baseline granting exports", async () => {
    const analyst = await actorFor("analyst");
    const result = failure(await listExportTargetsForActor(analyst));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("feature_denied");
  });

  it("an unauthenticated caller is denied", async () => {
    const result = failure(await listExportTargetsForActor(null));
    expect(result.reason).toBe("not_authenticated");
  });
});

describe("action-level denial: exports VIEW without the create_exports ACTION", () => {
  it("can see the catalog but cannot create a job", async () => {
    const catalog = must(await listExportTargetsForActor(viewOnlyActor), "catalog(viewOnly)");
    expect(catalog.length).toBe(3);

    const result = failure(await createExportJob(viewOnlyActor, { targetId: "partners", format: "csv" }));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("action_denied");
  });
});

describe("per-target source-feature gating", () => {
  it("an Export-Center-authorized actor lacking the Assignments feature is denied creating an Assignments export specifically", async () => {
    const result = failure(await createExportJob(exporterKerala, { targetId: "assignments", format: "csv" }));
    expect(result.code).toBe("unauthorized");
    expect(result.reason).toBe("scope_denied");
  });

  it("Super Admin, holding every source feature, succeeds on the same Assignments target", async () => {
    const job = must(await createExportJob(admin, { targetId: "assignments", format: "csv" }), "createExportJob(admin, assignments)");
    expect(job.status).toBe("COMPLETED");
    expect(job.hasArtifact).toBe(true);
  });
});

describe("column/target/format tampering is rejected server-side", () => {
  it("rejects an unknown column id", async () => {
    const result = failure(await createExportJob(exporterKerala, { targetId: "partners", format: "csv", columns: ["displayName", "panNumber"] }));
    expect(result.code).toBe("invalid_input");
  });

  it("rejects a duplicate column id", async () => {
    const result = failure(await createExportJob(exporterKerala, { targetId: "partners", format: "csv", columns: ["displayName", "displayName"] }));
    expect(result.code).toBe("invalid_input");
  });

  it("rejects a column that belongs to a different target", async () => {
    const result = failure(await createExportJob(exporterKerala, { targetId: "campaigns", format: "csv", columns: ["partnerRef"] }));
    expect(result.code).toBe("invalid_input");
  });

  it("rejects an unknown target id", async () => {
    const result = failure(await createExportJob(exporterKerala, { targetId: "vendors", format: "csv" }));
    expect(result.code).toBe("invalid_input");
  });

  it("rejects an unsupported format", async () => {
    const result = failure(await createExportJob(exporterKerala, { targetId: "partners", format: "docx" }));
    expect(result.code).toBe("invalid_input");
  });
});

describe("record scope is preserved: each actor's generated file contains only their own in-scope rows", () => {
  it("the Kerala-scoped actor's Partners CSV contains the Kerala partner but not the Delhi partner", async () => {
    const job = must(await createExportJob(exporterKerala, { targetId: "partners", format: "csv" }), "createExportJob(exporterKerala)");
    expect(job.status).toBe("COMPLETED");
    const artifact = must(await getExportArtifactForActor(exporterKerala, job.jobRef), "artifact(exporterKerala)");
    const text = Buffer.from(artifact.bytes).toString("utf8");
    expect(text).toContain(`Export Fixture Partner Kerala ${runId}`);
    expect(text).not.toContain(`Export Fixture Partner Delhi ${runId}`);
  });

  it("the Delhi-scoped actor's Partners CSV contains the Delhi partner but not the Kerala partner", async () => {
    const job = must(await createExportJob(exporterDelhi, { targetId: "partners", format: "csv" }), "createExportJob(exporterDelhi)");
    expect(job.status).toBe("COMPLETED");
    const artifact = must(await getExportArtifactForActor(exporterDelhi, job.jobRef), "artifact(exporterDelhi)");
    const text = Buffer.from(artifact.bytes).toString("utf8");
    expect(text).toContain(`Export Fixture Partner Delhi ${runId}`);
    expect(text).not.toContain(`Export Fixture Partner Kerala ${runId}`);
  });
});

describe("cross-actor job/artifact access fails closed with a neutral not-found", () => {
  let keralaJob: ExportJobDto;

  beforeAll(async () => {
    keralaJob = must(await createExportJob(exporterKerala, { targetId: "partners", format: "csv" }), "createExportJob(exporterKerala, for cross-actor test)");
  });

  it("a different actor cannot read the job by its real jobRef", async () => {
    const result = failure(await getExportJobForActor(exporterDelhi, keralaJob.jobRef));
    expect(result.code).toBe("not_found");
  });

  it("a different actor cannot download the artifact by its real jobRef", async () => {
    const result = failure(await getExportArtifactForActor(exporterDelhi, keralaJob.jobRef));
    expect(result.code).toBe("not_found");
  });

  it("a syntactically-invalid/guessed jobRef gets the identical neutral not-found", async () => {
    const result = failure(await getExportJobForActor(exporterDelhi, "exp_0000000000000000guess"));
    expect(result.code).toBe("not_found");
  });

  it("the owning actor CAN read their own job and artifact", async () => {
    const own = must(await getExportJobForActor(exporterKerala, keralaJob.jobRef), "own job read");
    expect(own.jobRef).toBe(keralaJob.jobRef);
    const artifact = must(await getExportArtifactForActor(exporterKerala, keralaJob.jobRef), "own artifact read");
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("job history is scoped to the caller's own jobs only", () => {
  it("listMyExportJobs never includes another actor's job", async () => {
    const keralaJobs = must(await listMyExportJobs(exporterKerala, undefined), "listMyExportJobs(exporterKerala)");
    const delhiJobs = must(await listMyExportJobs(exporterDelhi, undefined), "listMyExportJobs(exporterDelhi)");
    const keralaRefs = new Set(keralaJobs.map((j) => j.jobRef));
    const delhiRefs = new Set(delhiJobs.map((j) => j.jobRef));
    expect(keralaJobs.length).toBeGreaterThan(0);
    expect(delhiJobs.length).toBeGreaterThan(0);
    for (const ref of delhiRefs) expect(keralaRefs.has(ref)).toBe(false);
  });
});

describe("job lifecycle is a real persisted transition", () => {
  it("a completed job's Firestore doc shows PENDING -> COMPLETED with generatingAt/completedAt timestamps set", async () => {
    const job = must(await createExportJob(admin, { targetId: "partners", format: "csv" }), "createExportJob(admin) for lifecycle check");
    const snap = await exportJobsCollection().doc(job.jobRef).get();
    const doc = snap.data()!;
    expect(doc.status).toBe("COMPLETED");
    expect(doc.createdAt).toBeTruthy();
    expect(doc.generatingAt).toBeTruthy();
    expect(doc.completedAt).toBeTruthy();
    expect(new Date(doc.generatingAt).getTime()).toBeGreaterThanOrEqual(new Date(doc.createdAt).getTime());
    expect(new Date(doc.completedAt).getTime()).toBeGreaterThanOrEqual(new Date(doc.generatingAt).getTime());
  });
});

describe("CSV/XLSX/PDF are each generated end to end through the real service and parsed back for real", () => {
  it("xlsx: downloads and parses back with the real xlsx contents", async () => {
    const job = must(await createExportJob(admin, { targetId: "partners", format: "xlsx", columns: ["partnerRef", "displayName"] }), "createExportJob(admin, xlsx)");
    expect(job.status).toBe("COMPLETED");
    const artifact = must(await getExportArtifactForActor(admin, job.jobRef), "artifact(admin, xlsx)");
    const { parseXlsxForVerification } = await import("./xlsx");
    const parsed = parseXlsxForVerification(artifact.bytes);
    expect(parsed.headers).toEqual(["Partner ref", "Display name"]);
    const flat = parsed.rows.flat().join(" ");
    expect(flat).toContain(`Export Fixture Partner Kerala ${runId}`);
  });

  it("pdf: downloads and loads back with pdf-lib", async () => {
    const job = must(await createExportJob(admin, { targetId: "partners", format: "pdf" }), "createExportJob(admin, pdf)");
    expect(job.status).toBe("COMPLETED");
    const artifact = must(await getExportArtifactForActor(admin, job.jobRef), "artifact(admin, pdf)");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(artifact.bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("campaigns target: csv end to end", async () => {
    const job = must(await createExportJob(admin, { targetId: "campaigns", format: "csv" }), "createExportJob(admin, campaigns)");
    expect(job.status).toBe("COMPLETED");
    const artifact = must(await getExportArtifactForActor(admin, job.jobRef), "artifact(admin, campaigns)");
    const text = Buffer.from(artifact.bytes).toString("utf8");
    expect(text).toContain(`Export Fixture Campaign ${runId}`);
  });

  it("assignments target: csv end to end contains the fixture assignment's Partner", async () => {
    const job = must(await createExportJob(admin, { targetId: "assignments", format: "csv" }), "createExportJob(admin, assignments) 2");
    expect(job.status).toBe("COMPLETED");
    const artifact = must(await getExportArtifactForActor(admin, job.jobRef), "artifact(admin, assignments)");
    const text = Buffer.from(artifact.bytes).toString("utf8");
    expect(text).toContain(`Export Fixture Partner Kerala ${runId}`);
  });
});

describe("generation failure is handled safely (the FAILED lifecycle branch, not just authorization-layer rejection)", () => {
  it("a store failure during put() marks the job FAILED with a generic, provider-neutral message - never a raw exception/stack", async () => {
    const goodStore = createInMemoryExportArtifactStore();
    const throwingStore: typeof goodStore = {
      ...goodStore,
      async put() {
        throw new Error("simulated upstream storage outage: connection reset by peer at 10.0.0.7:443");
      },
    };
    setExportArtifactStoreForTests(throwingStore);
    try {
      const job = must(await createExportJob(admin, { targetId: "partners", format: "csv" }), "createExportJob(admin) with failing store");
      expect(job.status).toBe("FAILED");
      expect(job.hasArtifact).toBe(false);
      expect(job.errorMessage).toBe("Export generation failed. Please try again.");
      expect(job.errorMessage).not.toMatch(/10\.0\.0\.7|connection reset|simulated upstream/i);

      const snap = await exportJobsCollection().doc(job.jobRef).get();
      const doc = snap.data()!;
      expect(doc.status).toBe("FAILED");
      expect(doc.failedAt).toBeTruthy();
      expect(doc.artifactRef).toBeUndefined();
    } finally {
      setExportArtifactStoreForTests(createInMemoryExportArtifactStore());
    }
  });

  it("a FAILED job's artifact is correctly reported unavailable, never a broken download", async () => {
    const goodStore = createInMemoryExportArtifactStore();
    const throwingStore: typeof goodStore = {
      ...goodStore,
      async put() {
        throw new Error("simulated failure");
      },
    };
    setExportArtifactStoreForTests(throwingStore);
    let jobRef: string;
    try {
      const job = must(await createExportJob(admin, { targetId: "partners", format: "csv" }), "createExportJob(admin) with failing store 2");
      jobRef = job.jobRef;
    } finally {
      setExportArtifactStoreForTests(createInMemoryExportArtifactStore());
    }
    const result = failure(await getExportArtifactForActor(admin, jobRef));
    expect(result.code).toBe("not_found");
  });
});

describe("bounded execution", () => {
  it("every completed job's rowCount is <= its own maxRows, and truncated is a real boolean", async () => {
    const job = must(await createExportJob(admin, { targetId: "partners", format: "csv" }), "createExportJob(admin) bounded check");
    expect(job.rowCount).not.toBeNull();
    expect(job.rowCount!).toBeLessThanOrEqual(job.maxRows);
    expect(typeof job.truncated).toBe("boolean");
  });
});
