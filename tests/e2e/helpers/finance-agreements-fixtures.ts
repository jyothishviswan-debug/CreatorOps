import { randomUUID } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

import type { Page } from "@playwright/test";

import { resolveActor } from "@/server/authz/actor";
import { COLLECTIONS } from "@/server/authz/firestore";
import { scopeGrantDocId } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";
import { getAdminApp, getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import {
  activateAgreementVersion,
  attachExtractionProposals,
  confirmAgreementVersion,
  createAgreementDraft,
  createAgreementRevision,
  decideField,
  endAgreement,
  extractContract,
  suspendAgreement,
  uploadContractArtifact,
  type AgreementDetailDto,
} from "@/server/finance-agreements";
import { contractArtifactClaimId } from "@/server/finance-agreements/contract-service";
import {
  agreementClaimId,
  financeAgreementClaimsCollection,
  financeAgreementExtractionRunsCollection,
  financeAgreementRestrictedExtractionsCollection,
  financeAgreementsCollection,
  financeContractArtifactsCollection,
} from "@/server/finance-agreements/firestore";
import { READY_DECISIONS, type FieldDecisionSeed } from "@/server/finance-agreements/testing/agreement-service-fixtures";
import { makeBlankPdf, makeGarbagePdf, makeTextPdf } from "@/server/finance-agreements/testing/pdf-fixtures";
import { SAMPLE_CONTRACT_PAGES } from "@/server/finance-agreements/testing/sample-contract";
import type { AgreementCounterpartyInput } from "@/server/finance-agreements/types";
import { partnerAccountsCollection, partnersCollection } from "@/server/partners/firestore";
import { partnerAccountDocSchema, partnerDocSchema, type PartnerAccountDoc, type PartnerDoc } from "@/server/partners/types";
import { restrictedFinancialIdentitiesCollection, restrictedFinancialIdentityDocSchema, restrictedIdentityDocId } from "@/server/shared/restricted-financial-identity";
import { vendorsCollection } from "@/server/vendors/firestore";
import { vendorDocSchema, type VendorDoc } from "@/server/vendors/types";

import { emailFor, noDocumentOverflow, PASSWORD, signInAs, VIEWPORTS } from "./partner-reviews-fixtures";

// Shared Admin-SDK fixtures for the Finance Agreements (Step 14B) e2e specs. Same idiom as partner-reviews-fixtures.ts:
//   - every Partner / Partner Account / Vendor is written under a PRIVATE per-spec region that ONLY this fixture's own
//     scope grants can reach (so no other spec's list can ever see them), created long in the past;
//   - every Agreement is created through the TRUSTED services (never hand-rolled business truth) with actors resolved from
//     the seeded users (Manager prepares, Head activates / revises / suspends / ends);
//   - everything created here - AND everything the browser flows created for the fixture counterparties (agreements,
//     versions, events, extraction runs, restricted extractions, idempotency claims, contract artifacts + their storage
//     objects) - is removed in cleanupAll().
// The e2e process must be started with the PRIVATE emulator env (see the run notes in the report) - never the shared one.

export { emailFor, noDocumentOverflow, PASSWORD, signInAs, VIEWPORTS };
export type RoleName = "admin" | "manager" | "head" | "viewer" | "analyst";

// ---- Synthetic sensitive values (all invented) -----------------------------------------------------------------------------
// Seeded into the restricted identity records of fixture counterparties, and present inside the sample contract PDF. A spec proves that
// NONE of them appears in page text / DOM / network JSON for an actor without sensitive access.
export const SECRETS = { pan: "QWERT4321Z", aadhaar: "234123412346", account: "998877665544", ifsc: "TEST0009876", holder: "Zed Holder Name", gst: "27QWERT4321Z1Z9", bankName: "Secret Bank Of Tests", evidenceUrl: "https://example.test/secret-evidence-link" };
export const CONTRACT_SENSITIVE = { pan: "ABCPE1234F", gstin: "29ABCPE1234F1Z5", aadhaarSpaced: "2341 2341 2346", aadhaar: "234123412346", account: "123456789012", ifsc: "HDFC0001234", panHolder: "Sample Creator" };
export const SENSITIVE_STRINGS = [
  SECRETS.pan,
  SECRETS.aadhaar,
  SECRETS.account,
  SECRETS.ifsc,
  SECRETS.holder,
  SECRETS.gst,
  SECRETS.bankName,
  SECRETS.evidenceUrl,
  CONTRACT_SENSITIVE.pan,
  CONTRACT_SENSITIVE.gstin,
  CONTRACT_SENSITIVE.aadhaarSpaced,
  CONTRACT_SENSITIVE.aadhaar,
  CONTRACT_SENSITIVE.account,
  CONTRACT_SENSITIVE.ifsc,
];

// ---- PDFs -----------------------------------------------------------------------------------------------------------------------
export const PDFS = {
  // The synthetic sample collaboration Agreement (text PDF): extracts EXTRACTED / PARTIAL with many proposals.
  sample: () => makeTextPdf(SAMPLE_CONTRACT_PAGES),
  // A PDF with pages but no text at all -> "Manual review required - no extractable text was found."
  scan: () => makeBlankPdf(2),
  // A file that starts with %PDF- but is garbage.
  malformed: () => makeGarbagePdf(2048),
  // Just over the 10 MB limit (a valid PDF header, padded).
  oversize: () => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(10 * 1024 * 1024 + 4096, 0x20), Buffer.from("\n%%EOF\n")]),
  notPdf: () => Buffer.from("This is plainly not a PDF document."),
};

export const SAMPLE_PDF_NAME = "signed-collaboration-agreement.pdf";

const OLD = "2010-01-01T00:00:00.000Z";

// A complete, confirmable set of decisions whose qualifying unit is one of the two SUPPORTED units (the UI requires that; the backend fixture
// READY_DECISIONS uses the legacy wording "reel", which the UI marks Needs mapping and refuses to confirm).
export const SUPPORTED_READY_DECISIONS: FieldDecisionSeed[] = READY_DECISIONS.map((seed) => (seed.fieldKey === "qualifyingUnit" ? { ...seed, value: "approved_content_thread" } : seed));
export const LEGACY_UNIT_DECISIONS: FieldDecisionSeed[] = READY_DECISIONS;

let reqCounter = 0;
const requestId = () => `e2e-req-${Date.now()}-${(reqCounter += 1)}`;

export type PartnerOver = { displayName?: string; legalName?: string | null; email?: string | null; phone?: string | null; regionIds?: string[]; status?: "ACTIVE" | "INACTIVE" };
export type KycShape = { pan?: boolean; aadhaar?: boolean; bank?: boolean; gst?: "number" | "not_applicable" };

export function createFinanceFixtures(tag: string) {
  const region = `${tag}-region`;
  const hiddenRegion = `${tag}-hidden`;
  const cleanup: FirebaseFirestore.DocumentReference[] = [];
  const grantIds: string[] = [];
  const partners: PartnerDoc[] = [];
  const vendors: VendorDoc[] = [];
  const agreementRefs = new Set<string>();
  const claimIds = new Set<string>();
  let counter = 0;
  const now = () => new Date().toISOString();

  async function actorOf(name: RoleName): Promise<ActorContext> {
    const user = await getAdminAuth().getUserByEmail(emailFor(name));
    const actor = await resolveActor(user.uid);
    if (!actor) throw new Error(`no actor for ${name}`);
    return actor;
  }

  // Lets the seeded non-global identities reach the fixture region (the ONLY thing that makes a private-region record visible to them).
  async function grantFixtureRegion(names: Array<"manager" | "head" | "viewer" | "analyst"> = ["manager", "head", "viewer", "analyst"]) {
    for (const name of names) {
      const user = await getAdminAuth().getUserByEmail(emailFor(name));
      const input = { type: "REGION" as const, region };
      const id = scopeGrantDocId(user.uid, input);
      await getAdminFirestore()
        .collection(COLLECTIONS.scopeAssignments)
        .doc(id)
        .set({ ...input, uid: user.uid, grantedAt: now(), grantedBy: `e2e:${tag}` } as ScopeGrant);
      grantIds.push(id);
    }
  }

  // ---- Master data -------------------------------------------------------------------------------------------------------------
  async function seedPartner(over: PartnerOver = {}): Promise<PartnerDoc> {
    counter += 1;
    const uid = `${tag}-partner-${counter}-${randomUUID().slice(0, 6)}`;
    const displayName = over.displayName ?? `${tag} Partner ${counter}`;
    const partner = partnerDocSchema.parse({
      uid,
      partnerRef: uid,
      version: 1,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      legalName: over.legalName === undefined ? null : over.legalName,
      status: over.status ?? "ACTIVE",
      previousStatus: null,
      statusReason: null,
      regionIds: over.regionIds ?? [region],
      languageIds: [],
      categoryIds: [],
      tier: null,
      priority: null,
      targetAudience: [],
      email: over.email === undefined ? `partner-${counter}@example.test` : over.email,
      phone: over.phone === undefined ? "+91 90000 00000" : over.phone,
      ownerUid: null,
      teamIds: [],
      originLeadRefs: [],
      sourceDiscovery: null,
      pendingPartnerAccountSetup: false,
      sequenceNumber: null,
      createdAt: OLD,
      createdByUserRef: "e2e",
      updatedAt: OLD,
      updatedByUserRef: "e2e",
    });
    const ref = partnersCollection().doc(uid);
    await ref.set(partner);
    cleanup.push(ref);
    partners.push(partner);
    return partner;
  }

  async function seedAccount(partner: PartnerDoc, platform: "instagram" | "youtube", over: { handle?: string; displayName?: string | null; profileUrl?: string | null; primary?: boolean; status?: "ACTIVE" | "INACTIVE" } = {}): Promise<PartnerAccountDoc> {
    counter += 1;
    const uid = `${tag}-account-${counter}-${randomUUID().slice(0, 6)}`;
    const handle = over.handle ?? `${platform}_${tag.toLowerCase()}_${counter}`;
    const account = partnerAccountDocSchema.parse({
      uid,
      partnerAccountRef: uid,
      version: 1,
      partnerRef: partner.partnerRef,
      platform,
      handle,
      displayName: over.displayName === undefined ? `${platform === "instagram" ? "IG" : "YT"} ${handle}` : over.displayName,
      profileUrl: over.profileUrl === undefined ? `https://${platform}.example.test/${handle}` : over.profileUrl,
      primary: over.primary ?? false,
      normalizedIdentity: `${platform}:${uid}`,
      status: over.status ?? "ACTIVE",
      createdAt: OLD,
      createdByUserRef: "e2e",
      updatedAt: OLD,
      updatedByUserRef: "e2e",
    });
    const ref = partnerAccountsCollection().doc(uid);
    await ref.set(account);
    cleanup.push(ref);
    return account;
  }

  async function seedVendor(over: { displayName?: string; email?: string | null; phone?: string | null; regionIds?: string[]; status?: "ACTIVE" | "INACTIVE" } = {}): Promise<VendorDoc> {
    counter += 1;
    const uid = `${tag}-vendor-${counter}-${randomUUID().slice(0, 6)}`;
    const displayName = over.displayName ?? `${tag} Vendor ${counter}`;
    const vendor = vendorDocSchema.parse({
      uid,
      vendorRef: uid,
      version: 1,
      displayName,
      displayNameLower: displayName.toLowerCase(),
      vendorType: "AGENCY",
      email: over.email === undefined ? `vendor-${counter}@example.test` : over.email,
      phone: over.phone === undefined ? "+91 91111 11111" : over.phone,
      status: over.status ?? "ACTIVE",
      regionIds: over.regionIds ?? [region],
      createdAt: OLD,
      createdByUserRef: "e2e",
      updatedAt: OLD,
      updatedByUserRef: "e2e",
    });
    const ref = vendorsCollection().doc(uid);
    await ref.set(vendor);
    cleanup.push(ref);
    vendors.push(vendor);
    return vendor;
  }

  // Seeds the restricted canonical KYC record: the state a counterparty's KYC is in (full / incomplete via a subset / missing = call nothing).
  async function seedKyc(subject: { type: "PARTNER" | "VENDOR"; uid: string; ref: string }, parts: KycShape) {
    const stamp = now();
    const doc = restrictedFinancialIdentityDocSchema.parse({
      uid: restrictedIdentityDocId(subject.type, subject.uid),
      subjectType: subject.type,
      subjectRef: subject.ref,
      version: 1,
      pan: parts.pan ? { number: SECRETS.pan } : null,
      aadhaar: parts.aadhaar ? { number: SECRETS.aadhaar } : null,
      gst: parts.gst === "number" ? { applicable: true, number: SECRETS.gst } : parts.gst === "not_applicable" ? { applicable: false } : null,
      bank: parts.bank ? { accountHolderName: SECRETS.holder, accountNumber: SECRETS.account, ifsc: SECRETS.ifsc, bankName: SECRETS.bankName, branchName: "Test Branch" } : null,
      evidence: [{ docType: "pan", kind: "link", url: SECRETS.evidenceUrl, fileName: null, addedAt: stamp, addedByUserRef: "e2e" }],
      updatedAt: stamp,
      updatedByUserRef: "e2e",
    });
    const ref = restrictedFinancialIdentitiesCollection().doc(doc.uid);
    await ref.set(doc);
    cleanup.push(ref);
  }
  const fullKyc = (subject: { type: "PARTNER" | "VENDOR"; uid: string; ref: string }) => seedKyc(subject, { pan: true, aadhaar: subject.type === "PARTNER", bank: true, gst: "number" });

  const partnerSubject = (partner: PartnerDoc) => ({ type: "PARTNER" as const, uid: partner.uid, ref: partner.partnerRef });
  const vendorSubject = (vendor: VendorDoc) => ({ type: "VENDOR" as const, uid: vendor.uid, ref: vendor.vendorRef });

  // ---- Agreements through the trusted services ---------------------------------------------------------------------------------
  const partnerCp = (partner: PartnerDoc, accountRefs?: string[]): AgreementCounterpartyInput => ({ type: "PARTNER", partnerRef: partner.partnerRef, ...(accountRefs ? { partnerAccountRefs: accountRefs } : {}) });
  const vendorCp = (vendor: VendorDoc): AgreementCounterpartyInput => ({ type: "VENDOR", vendorRef: vendor.vendorRef });

  function must<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string; blockers?: unknown }, label: string): T {
    if (!result.ok) throw new Error(`${label}: ${result.code} - ${result.message}${"blockers" in result && result.blockers ? ` ${JSON.stringify(result.blockers)}` : ""}`);
    return result.data;
  }

  async function newDraft(counterparty: AgreementCounterpartyInput, as: RoleName = "manager"): Promise<AgreementDetailDto> {
    const actor = await actorOf(as);
    const clientRequestId = `crid-${tag}-${(counter += 1)}-${randomUUID().slice(0, 6)}`;
    const outcome = must(await createAgreementDraft(actor, { clientRequestId, counterparty }, requestId()), "create draft");
    agreementRefs.add(outcome.agreement.head.agreementRef);
    claimIds.add(agreementClaimId(actor.uid, clientRequestId));
    return outcome.agreement;
  }

  const docVersionOf = (detail: AgreementDetailDto) => detail.selectedVersion!.docVersion;

  async function decideAll(detail: AgreementDetailDto, seeds: FieldDecisionSeed[], as: RoleName = "manager"): Promise<AgreementDetailDto> {
    const actor = await actorOf(as);
    let current = detail;
    for (const seed of seeds) {
      current = must(
        await decideField(actor, { agreementRef: current.head.agreementRef, version: current.selectedVersion!.version, expectedDocVersion: docVersionOf(current), fieldKey: seed.fieldKey, decision: seed.decision, ...(seed.value !== undefined ? { value: seed.value } : {}) }, requestId()),
        `decide ${seed.fieldKey}`,
      );
    }
    return current;
  }

  async function acceptPending(detail: AgreementDetailDto, as: RoleName = "manager"): Promise<AgreementDetailDto> {
    const pending = Object.entries(detail.selectedVersion!.draft)
      .filter(([, entry]) => entry?.decision === "PENDING")
      .map(([fieldKey]) => ({ fieldKey, decision: "ACCEPTED" as const }));
    return decideAll(detail, pending as FieldDecisionSeed[], as);
  }

  async function confirm(detail: AgreementDetailDto, as: RoleName = "manager"): Promise<AgreementDetailDto> {
    return must(await confirmAgreementVersion(await actorOf(as), { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: docVersionOf(detail) }, requestId()), "confirm");
  }

  async function activate(detail: AgreementDetailDto, as: RoleName = "head"): Promise<AgreementDetailDto> {
    return must(await activateAgreementVersion(await actorOf(as), { agreementRef: detail.head.agreementRef, version: detail.selectedVersion!.version, expectedDocVersion: detail.head.docVersion }, requestId()), "activate");
  }

  // Uploads + extracts + attaches a PDF to the open draft through the trusted services (the same steps the browser flow performs).
  async function attachContract(detail: AgreementDetailDto, bytes: Buffer = PDFS.sample(), as: RoleName = "admin"): Promise<AgreementDetailDto> {
    const actor = await actorOf(as);
    const version = detail.selectedVersion!;
    const counterparty = detail.head.counterparty;
    const uploaded = must(await uploadContractArtifact(actor, { fileName: SAMPLE_PDF_NAME, bytes, counterparty: { type: counterparty.type, ref: counterparty.ref } }, requestId()), "upload");
    const extraction = must(await extractContract(actor, { agreementRef: detail.head.agreementRef, version: version.version, artifactRef: uploaded.artifact.artifactRef }, requestId()), "extract");
    const attached = must(await attachExtractionProposals(actor, { agreementRef: detail.head.agreementRef, version: version.version, expectedDocVersion: version.docVersion, extractionRunRef: extraction.run.runRef }, requestId()), "attach");
    return attached.agreement;
  }

  // A DRAFT with a few decided commercial fields (still unconfirmed, some PENDING prefills).
  async function seedDraft(counterparty: AgreementCounterpartyInput, extra: FieldDecisionSeed[] = []): Promise<AgreementDetailDto> {
    return decideAll(await newDraft(counterparty), [{ fieldKey: "currency", decision: "CORRECTED", value: "INR" }, ...extra]);
  }

  // A confirmed DRAFT (frozen terms, waiting for activation).
  // `as` = the actor that prepares it (a counterparty outside the seeded Manager's scope needs the global admin).
  async function seedConfirmed(counterparty: AgreementCounterpartyInput, seeds: FieldDecisionSeed[] = SUPPORTED_READY_DECISIONS, as: RoleName = "manager"): Promise<AgreementDetailDto> {
    const created = await newDraft(counterparty, as);
    return confirm(await acceptPending(await decideAll(created, seeds, as), as), as);
  }

  async function seedActive(counterparty: AgreementCounterpartyInput, seeds: FieldDecisionSeed[] = SUPPORTED_READY_DECISIONS, as: RoleName = "manager"): Promise<AgreementDetailDto> {
    return activate(await seedConfirmed(counterparty, seeds, as), as === "manager" ? "head" : as);
  }

  async function seedSuspended(counterparty: AgreementCounterpartyInput): Promise<AgreementDetailDto> {
    const active = await seedActive(counterparty);
    return must(await suspendAgreement(await actorOf("head"), { agreementRef: active.head.agreementRef, expectedDocVersion: active.head.docVersion, reason: "Paused for the e2e fixture" }, requestId()), "suspend");
  }

  async function seedEnded(counterparty: AgreementCounterpartyInput): Promise<AgreementDetailDto> {
    const active = await seedActive(counterparty);
    return must(await endAgreement(await actorOf("head"), { agreementRef: active.head.agreementRef, expectedDocVersion: active.head.docVersion, reason: "Relationship concluded for the e2e fixture" }, requestId()), "end");
  }

  // ACTIVE version 1 + an OPEN (unconfirmed) revision, version 2.
  async function seedActiveWithRevision(counterparty: AgreementCounterpartyInput, seeds: FieldDecisionSeed[] = SUPPORTED_READY_DECISIONS): Promise<AgreementDetailDto> {
    const active = await seedActive(counterparty, seeds);
    return must(await createAgreementRevision(await actorOf("head"), { agreementRef: active.head.agreementRef, expectedDocVersion: active.head.docVersion }, requestId()), "revise");
  }

  // A per-user access override that removes the OWNING module's `edit` action (Partners / Vendors) from a seeded identity, so a test can
  // prove the owning module denies a master-data update the Finance action alone would have allowed. Always undone by restoreOverrides().
  const overriddenUids = new Set<string>();
  async function denyOwningEdit(name: "manager" | "head", feature: "partners" | "vendors" = "partners") {
    const user = await getAdminAuth().getUserByEmail(emailFor(name));
    await getAdminFirestore()
      .collection(COLLECTIONS.userAccessOverrides)
      .doc(user.uid)
      .set({ uid: user.uid, version: 1, features: { [feature]: { actions: { edit: false } } } }, { merge: true });
    overriddenUids.add(`${user.uid}|${feature}`);
  }
  async function restoreOverrides() {
    for (const key of overriddenUids) {
      const [uid, feature] = key.split("|");
      await getAdminFirestore().collection(COLLECTIONS.userAccessOverrides).doc(uid!).update({ [`features.${feature}`]: FieldValue.delete() });
    }
    overriddenUids.clear();
  }

  // ---- Cleanup: EVERYTHING created for the fixture counterparties (also what the browser flows created) -------------------------
  async function cleanupAll() {
    await restoreOverrides();
    const db = getAdminFirestore();
    const partnerUids = partners.map((p) => p.uid);
    const partnerRefs = partners.map((p) => p.partnerRef);
    const vendorUids = vendors.map((v) => v.uid);
    const vendorRefs = vendors.map((v) => v.vendorRef);

    // 1. every head of a fixture counterparty (also the ones a browser flow created)
    for (const uid of partnerUids) for (const doc of (await financeAgreementsCollection().where("partnerUid", "==", uid).get()).docs) agreementRefs.add(doc.id);
    for (const uid of vendorUids) for (const doc of (await financeAgreementsCollection().where("vendorUid", "==", uid).get()).docs) agreementRefs.add(doc.id);

    for (const agreementRef of agreementRefs) {
      // restricted extractions are keyed by the run ref; read the runs first
      const runs = await financeAgreementExtractionRunsCollection(agreementRef).get();
      await Promise.all(runs.docs.map((run) => financeAgreementRestrictedExtractionsCollection().doc(run.id).delete()));
      // idempotency claims that point at this agreement (browser flows use ids we never saw)
      const claims = await financeAgreementClaimsCollection().where("agreementRef", "==", agreementRef).get();
      await Promise.all(claims.docs.map((claim) => claim.ref.delete()));
      // head + versions + events + extractionRuns
      await db.recursiveDelete(financeAgreementsCollection().doc(agreementRef));
    }
    agreementRefs.clear();
    await Promise.all([...claimIds].map((id) => financeAgreementClaimsCollection().doc(id).delete()));
    claimIds.clear();

    // 2. contract artifacts uploaded for a fixture counterparty (+ their idempotency claim + the stored object, best effort)
    for (const [type, refs] of [["PARTNER", partnerRefs], ["VENDOR", vendorRefs]] as const) {
      for (const ref of refs) {
        const artifacts = await financeContractArtifactsCollection().where("counterparty.ref", "==", ref).get();
        for (const artifact of artifacts.docs) {
          const data = artifact.data() as { sha256?: string; storageLocator?: string };
          if (data.sha256) await financeAgreementClaimsCollection().doc(contractArtifactClaimId(type, ref, data.sha256)).delete();
          if (data.storageLocator) {
            try {
              const bucket = process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
              if (bucket) await getStorage(getAdminApp()).bucket(bucket).file(data.storageLocator).delete({ ignoreNotFound: true });
            } catch {
              // best effort: the private storage emulator is wiped by the next run's reset
            }
          }
          await artifact.ref.delete();
        }
      }
    }

    // 3. master data + restricted identity + grants
    await Promise.all(cleanup.splice(0).map((ref) => ref.delete()));
    await Promise.all(grantIds.splice(0).map((id) => db.collection(COLLECTIONS.scopeAssignments).doc(id).delete()));
    partners.length = 0;
    vendors.length = 0;
  }

  return {
    tag,
    region,
    hiddenRegion,
    actorOf,
    grantFixtureRegion,
    seedPartner,
    seedAccount,
    seedVendor,
    seedKyc,
    fullKyc,
    partnerSubject,
    vendorSubject,
    partnerCp,
    vendorCp,
    newDraft,
    decideAll,
    acceptPending,
    confirm,
    activate,
    attachContract,
    seedDraft,
    seedConfirmed,
    seedActive,
    seedSuspended,
    seedEnded,
    seedActiveWithRevision,
    denyOwningEdit,
    restoreOverrides,
    cleanupAll,
  };
}

export type FinanceFixtures = ReturnType<typeof createFinanceFixtures>;

// ---- Browser helpers --------------------------------------------------------------------------------------------------------------
export const FIXTURE_DECISIONS = SUPPORTED_READY_DECISIONS;

// The console / pageerror collector every spec attaches: returns the messages seen so a test can assert none.
export function collectBrowserErrors(page: Page): { errors: string[] } {
  const bag = { errors: [] as string[] };
  page.on("pageerror", (error) => bag.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = message.text();
      // A deliberate 4xx from a route under test is logged by the browser as a console error; only real script errors count.
      if (/Failed to load resource/i.test(text)) return;
      bag.errors.push(`console.error: ${text}`);
    }
  });
  return bag;
}

// Every response body (JSON / text) the page receives from an own-origin request, so a test can scan the network for sensitive strings.
export function collectResponseBodies(page: Page): { bodies: Array<{ url: string; text: string }> } {
  const bag = { bodies: [] as Array<{ url: string; text: string }> };
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.startsWith("http://localhost:3100")) return;
      const type = response.headers()["content-type"] ?? "";
      if (!/json|text|html|javascript/i.test(type)) return;
      if (/_next\/static|hmr|\.map$/.test(url)) return;
      bag.bodies.push({ url, text: await response.text() });
    } catch {
      // response body unavailable (redirect / aborted): nothing to scan
    }
  });
  return bag;
}

export function leaked(text: string, strings: readonly string[] = SENSITIVE_STRINGS): string[] {
  return strings.filter((value) => text.includes(value));
}

// Server-rendered controls exist (and can be clicked) BEFORE React hydrates them; a click in that window does nothing. Wait until the
// element has been claimed by React (it carries React's internal props key only after hydration) before interacting with it.
export async function waitForHydration(page: Page, selector: string): Promise<void> {
  // The target itself AND the app shell (top bar): the shell hydrates after the page body, and an interaction that lands during its
  // hydration is replayed / lost (it also re-syncs the router history, which looks like a navigation).
  await page.waitForFunction(
    (sels) =>
      sels.every((sel) => {
        const element = document.querySelector(sel);
        return !!element && Object.keys(element).some((key) => key.startsWith("__reactProps$"));
      }),
    [selector, ".topbar button"],
  );
}

// The RENDERED DOM (elements, attributes, text) without <script> payloads. Next embeds the server-passed props (the Flight payload) in inline
// scripts; for an actor who holds the identity category those DTOs still carry full values (the backend policy is a separate decision) - what
// the page itself PRINTS must never be a full value.
export async function renderedDom(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script").forEach((script) => script.remove());
    return clone.outerHTML;
  });
}
