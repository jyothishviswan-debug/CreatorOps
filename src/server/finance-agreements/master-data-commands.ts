import { z } from "zod";

import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { requirePartnersAccess } from "@/server/partners/partners-gate";
import { editPartner } from "@/server/partners/partner-service";
import { getPartnerRestrictedIdentity, savePartnerRestrictedIdentity, type PartnerRestrictedIdentityDto } from "@/server/partners/restricted-identity-service";
import { editVendor } from "@/server/vendors/vendor-service";
import { getVendorRestrictedIdentity, saveVendorRestrictedIdentity, type VendorRestrictedIdentityDto } from "@/server/vendors/restricted-identity-service";
import { requireVendorsAccess } from "@/server/vendors/vendors-gate";

import { reconciliationEntriesForVersion, type ReconciliationFieldEntry } from "./agreement-draft";
import { appendAgreementEvent } from "./agreement-events";
import type { AgreementFieldKey } from "./fields";
import { requireContractSensitiveAccess, requireIdentitySensitiveAccess } from "./finance-agreements-gate";
import { getAgreementVersionDoc } from "./firestore";
import { normalizeAadhaar, normalizeEmail, normalizeIdentityCode, normalizePhone } from "./reconciliation-compare";
import { loadCounterpartyDoc, loadRestrictedExtraction } from "./reconciliation-loaders";
import { authorizeAgreementCommand } from "./service-common";
import {
  agreementRefSchema,
  financeAgreementsConflictResult,
  financeAgreementsInternalResult,
  financeAgreementsInvalidInputResult,
  financeAgreementsNotFoundResult,
  financeAgreementsNotReadyResult,
  financeAgreementsStaleResult,
  financeAgreementsUnauthorizedResult,
  type AgreementVersionDoc,
  type CounterpartyType,
  type FinanceAgreementsErrorResult,
  type FinanceAgreementsReadinessIssue,
  type FinanceAgreementsServiceResult,
} from "./types";

// Step 14A: the two explicit MASTER-DATA COMMANDS.
//
// Extraction and reconciliation never change a Partner, Vendor or KYC record - they only propose.
// These are the ONLY paths from an Agreement into a master record, and each one:
//   - is an explicit user command with a strict field / component ALLOWLIST (no bulk sync);
//   - needs manage_agreements + the Agreement's live Record Scope, and then goes THROUGH THE OWNING
//     MODULE's own service (editPartner / editVendor, save*RestrictedIdentity) with the SAME actor and
//     the caller's expectedVersion, so the owning module's action / scope / sensitive / lifecycle /
//     audit rules apply on their own - if it denies or the record is stale, that outcome is returned and
//     nothing changes anywhere;
//   - takes the value from the Agreement's own DECIDED (accepted / corrected) entry or its frozen terms,
//     never from raw extraction and never from the request body;
//   - never replaces a non-empty value unless the caller deliberately says so (mode OVERWRITE_MISMATCH with
//     resolution { acknowledged: true, reason });
//   - appends an Agreement audit event that carries field / component NAMES and flags only, no value.
// Document / evidence uploads keep using the owning modules' own evidence endpoints; there is no upload
// path here.

const versionNumberSchema = z.number().int().min(1);
const expectedVersionSchema = z.number().int().min(1);

// resolution is the caller's deliberate acknowledgement that a NON-empty value is being replaced.
const resolutionSchema = z.object({ acknowledged: z.literal(true), reason: z.string().trim().min(3).max(1000) }).strict();
export const MASTER_DATA_MODES = ["FILL_MISSING", "OVERWRITE_MISMATCH"] as const;
const modeSchema = z.enum(MASTER_DATA_MODES);
export type MasterDataMode = (typeof MASTER_DATA_MODES)[number];

// Only a version that can still be a source of truth: the open draft or the governing (active /
// suspended) one. A superseded / ended version is history and never updates a master record.
const SOURCE_STATUSES: ReadonlyArray<AgreementVersionDoc["status"]> = ["DRAFT", "ACTIVE", "SUSPENDED"];

function mapOwningFailure(failure: { code: string; message: string; reason?: string; blockers?: Array<{ code: string; message: string }> }): FinanceAgreementsErrorResult {
  switch (failure.code) {
    case "unauthorized": {
      const reason = failure.reason;
      return financeAgreementsUnauthorizedResult(reason === "not_authenticated" || reason === "feature_denied" || reason === "scope_denied" || reason === "sensitive_denied" ? reason : "action_denied");
    }
    case "not_found":
      return financeAgreementsNotFoundResult();
    case "invalid_input":
      return financeAgreementsInvalidInputResult(failure.message);
    case "stale_write":
      return financeAgreementsStaleResult(failure.message);
    case "conflict":
      return financeAgreementsConflictResult(failure.message);
    case "not_ready":
      return financeAgreementsNotReadyResult(failure.message, (failure.blockers ?? []).map((blocker) => ({ code: blocker.code, message: blocker.message })));
    default:
      return financeAgreementsInternalResult();
  }
}

const blank = (value: string | null | undefined) => value === null || value === undefined || value.trim().length === 0;
const isDecided = (entry: ReconciliationFieldEntry | undefined): entry is ReconciliationFieldEntry => entry !== undefined && (entry.decision === "ACCEPTED" || entry.decision === "CORRECTED");

// --- (a) Contact: email / phone ------------------------------------------------------------------------------------------------
export const CONTACT_COMMAND_FIELDS = ["emailAddress", "contactNumber"] as const;

const updateContactInputSchema = z
  .object({
    agreementRef: agreementRefSchema,
    version: versionNumberSchema,
    fieldKey: z.enum(CONTACT_COMMAND_FIELDS),
    mode: modeSchema,
    resolution: resolutionSchema.optional(),
    // The Partner's / Vendor's own `version` the caller saw (the owning module verifies it in its transaction).
    expectedCounterpartyVersion: expectedVersionSchema,
    // Optional: the version doc's docVersion the caller saw, so a value changed since is a stale_write.
    expectedDocVersion: expectedVersionSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.mode === "OVERWRITE_MISMATCH" && !input.resolution) ctx.addIssue({ code: "custom", path: ["resolution"], message: "Replacing an existing value needs resolution { acknowledged: true, reason }." });
  });
export type UpdateCounterpartyContactInput = z.input<typeof updateContactInputSchema>;

export type UpdateCounterpartyContactOutcome = {
  agreementRef: string;
  version: number;
  fieldKey: (typeof CONTACT_COMMAND_FIELDS)[number];
  mode: MasterDataMode;
  counterpartyType: CounterpartyType;
  // The Partner's / Vendor's version after the owning module's own accepted edit.
  counterpartyVersion: number;
};

// Copies ONE contact fact (email or phone) the Agreement has DECIDED onto the Partner / Vendor.
//   FILL_MISSING        only when CreatorOps has nothing there; otherwise a conflict (use OVERWRITE_MISMATCH)
//   OVERWRITE_MISMATCH  only when CreatorOps has a DIFFERENT value and resolution.acknowledged is true with a reason
export async function updateCounterpartyContactFromAgreement(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<UpdateCounterpartyContactOutcome>> {
  const command = await authorizeAgreementCommand(actor, "manage_agreements", updateContactInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;
  const viewer = actor!;
  const type = authorized.counterpartyType;

  // Preflight the OWNING module's own gate first (feature + edit), so a denied actor learns nothing about
  // the record's current values from a conflict / stale outcome. The owning service re-runs it for real.
  const owning = type === "PARTNER" ? await requirePartnersAccess(viewer, "edit") : await requireVendorsAccess(viewer, "edit");
  if (!owning.ok) return financeAgreementsUnauthorizedResult(owning.reason);

  const version = await getAgreementVersionDoc(input.agreementRef, input.version);
  if (!version) return financeAgreementsNotFoundResult();
  if (!SOURCE_STATUSES.includes(version.status)) return financeAgreementsConflictResult("A superseded or ended agreement version cannot update master data.");
  if (input.expectedDocVersion !== undefined && version.docVersion !== input.expectedDocVersion) return financeAgreementsStaleResult();

  // The value is the Agreement's DECIDED one - never raw extraction, never the request body.
  const entry = reconciliationEntriesForVersion(version).find((item) => item.fieldKey === input.fieldKey);
  if (!isDecided(entry) || typeof entry.value !== "string" || blank(entry.value)) {
    return financeAgreementsNotReadyResult("The agreement's value must be accepted or corrected before it can update master data.", [{ code: "field_not_decided", message: `${input.fieldKey} has no accepted or corrected value in this version.`, fieldKey: input.fieldKey }]);
  }
  const value = entry.value.trim();

  const counterparty = await loadCounterpartyDoc(authorized.head);
  if (!counterparty) return financeAgreementsNotFoundResult();
  const master = counterparty.type === "PARTNER" ? counterparty.partner : counterparty.vendor;
  if (master.version !== input.expectedCounterpartyVersion) return financeAgreementsStaleResult(`This ${type === "PARTNER" ? "Partner" : "Vendor"} was changed elsewhere. Reload and try again.`);

  const current = input.fieldKey === "emailAddress" ? master.email : master.phone;
  const normalize = input.fieldKey === "emailAddress" ? normalizeEmail : normalizePhone;
  if (input.mode === "FILL_MISSING") {
    if (!blank(current)) return financeAgreementsConflictResult("CreatorOps already has a value here. Use OVERWRITE_MISMATCH with an acknowledged reason to replace it.");
  } else {
    if (blank(current)) return financeAgreementsConflictResult("CreatorOps has no value here to replace. Use FILL_MISSING.");
    if (normalize(current!) === normalize(value)) return financeAgreementsConflictResult("CreatorOps already has this value; there is nothing to overwrite.");
  }

  // The OWNING module applies its own action / scope / lifecycle / audit rules. A denial or a stale
  // record is returned as-is and leaves everything unchanged.
  const patch = { ...(input.fieldKey === "emailAddress" ? { email: value } : { phone: value }), expectedVersion: input.expectedCounterpartyVersion };
  const edited = counterparty.type === "PARTNER" ? await editPartner(viewer, counterparty.partner.partnerRef, patch, requestId) : await editVendor(viewer, counterparty.vendor.vendorRef, patch, requestId);
  if (!edited.ok) return mapOwningFailure(edited);

  const recorded = await recordEvent({
    agreementRef: input.agreementRef,
    kind: "master_data_updated",
    version: version.version,
    actorUserRef: viewer.userRef,
    metadata: { fieldKey: input.fieldKey, mode: input.mode, counterpartyType: type, resolutionAcknowledged: input.resolution?.acknowledged === true, ...(input.resolution ? { reason: input.resolution.reason } : {}) },
    requestId,
  });
  if (!recorded) return financeAgreementsInternalResult("The master data was updated, but the agreement audit event could not be recorded.");

  return { ok: true, data: { agreementRef: input.agreementRef, version: version.version, fieldKey: input.fieldKey, mode: input.mode, counterpartyType: type, counterpartyVersion: edited.data.version } };
}

// --- (b) Restricted KYC: pan / aadhaar / gst / bank ------------------------------------------------------------------------------
export const KYC_COMPONENTS = ["pan", "aadhaar", "gst", "bank"] as const;
export type KycComponent = (typeof KYC_COMPONENTS)[number];

const applyKycInputSchema = z
  .object({
    agreementRef: agreementRefSchema,
    version: versionNumberSchema,
    components: z.array(z.enum(KYC_COMPONENTS)).min(1).max(KYC_COMPONENTS.length),
    mode: modeSchema,
    resolution: resolutionSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (new Set(input.components).size !== input.components.length) ctx.addIssue({ code: "custom", path: ["components"], message: "Each component may be named once." });
    if (input.mode === "OVERWRITE_MISMATCH" && !input.resolution) ctx.addIssue({ code: "custom", path: ["resolution"], message: "Replacing an existing value needs resolution { acknowledged: true, reason }." });
  });
export type ApplyExtractedKycInput = z.input<typeof applyKycInputSchema>;

export type ApplyExtractedKycOutcome = {
  agreementRef: string;
  version: number;
  counterpartyType: CounterpartyType;
  mode: MasterDataMode;
  // Component NAMES only.
  components: KycComponent[];
  // The canonical restricted record's version after the owning module's own accepted save.
  identityVersion: number;
};

// The Agreement identity field(s) a human must have ACKNOWLEDGED (decision ACCEPTED) for a component.
const COMPONENT_FIELDS: Record<Exclude<KycComponent, "bank">, AgreementFieldKey> = { pan: "panNumber", aadhaar: "aadhaarNumber", gst: "gstin" };

const PAN_SHAPE = /^[A-Z]{5}\d{4}[A-Z]$/;
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Copies restricted identity components the Agreement's contract extraction found into the CANONICAL
// restricted store - and only there. The extracted values are read server-side from the restricted
// extraction record; the Agreement never holds them, and nothing returned or audited contains one.
//   requires   manage_agreements + finance_contracts + the counterparty's identity category, and (through
//              the owning service) manage_*_restricted_identity + the owning scope
//   FILL_MISSING        every named component must be EMPTY in the canonical record, else a conflict
//   OVERWRITE_MISMATCH  every named component must hold a DIFFERENT value, with resolution acknowledged + reason
//   a component is only used when its Agreement identity field was ACCEPTED (a human acknowledged the extracted
//   value), the extraction run is attached to the version, and the value is well-formed. Aadhaar is Partner-only.
//   bank is refused: the canonical bank record also needs holder name, bank name and branch, which a
//   contract extraction cannot supply - the operator adds it through the owning identity page.
export async function applyExtractedKycToCanonical(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<FinanceAgreementsServiceResult<ApplyExtractedKycOutcome>> {
  const command = await authorizeAgreementCommand(actor, "manage_agreements", applyKycInputSchema, rawInput);
  if (!command.ok) return command.error;
  const { input, authorized } = command;
  const viewer = actor!;
  const type = authorized.counterpartyType;

  const contracts = await requireContractSensitiveAccess(viewer);
  if (!contracts.ok) return financeAgreementsUnauthorizedResult(contracts.reason);
  const identityCategory = await requireIdentitySensitiveAccess(viewer, type);
  if (!identityCategory.ok) return financeAgreementsUnauthorizedResult(identityCategory.reason);

  if (type === "VENDOR" && input.components.includes("aadhaar")) return financeAgreementsInvalidInputResult("A vendor has no Aadhaar component.");

  // The OWNING module's own gate (manage_*_restricted_identity + category + scope), exercised by reading the
  // canonical record through it. A denial leaves everything unchanged.
  const counterparty = await loadCounterpartyDoc(authorized.head);
  if (!counterparty) return financeAgreementsNotFoundResult();
  const read = counterparty.type === "PARTNER" ? await getPartnerRestrictedIdentity(viewer, counterparty.partner.partnerRef) : await getVendorRestrictedIdentity(viewer, counterparty.vendor.vendorRef);
  if (!read.ok) return mapOwningFailure(read);
  const existing: PartnerRestrictedIdentityDto | VendorRestrictedIdentityDto | null = read.data;

  const version = await getAgreementVersionDoc(input.agreementRef, input.version);
  if (!version) return financeAgreementsNotFoundResult();
  if (!SOURCE_STATUSES.includes(version.status)) return financeAgreementsConflictResult("A superseded or ended agreement version cannot update master data.");

  const restricted = await loadRestrictedExtraction(version, { attachedOnly: true });
  const entries = reconciliationEntriesForVersion(version);
  const blockers: FinanceAgreementsReadinessIssue[] = [];
  const conflicts: string[] = [];
  const next: { pan?: { number: string }; aadhaar?: { number: string }; gst?: { applicable: true; number: string } } = {};

  if (!restricted) blockers.push({ code: "no_extraction_attached", message: "No contract extraction is attached to this agreement version." });

  for (const component of input.components) {
    if (component === "bank") {
      blockers.push({ code: "bank_details_incomplete", message: "The bank record needs a holder name, bank name and branch that a contract extraction cannot supply. Add it on the Partner / Vendor identity page." });
      continue;
    }
    const fieldKey = COMPONENT_FIELDS[component];
    const entry = entries.find((item) => item.fieldKey === fieldKey);
    if (!entry || entry.decision !== "ACCEPTED") {
      blockers.push({ code: "field_not_decided", message: `${fieldKey} must be accepted on the agreement before it can update the identity record.`, fieldKey });
      continue;
    }
    if (!restricted) continue;

    const raw = restricted.doc.fields[fieldKey]?.rawValue ?? null;
    const normalized = raw === null ? null : component === "aadhaar" ? normalizeAadhaar(raw) : normalizeIdentityCode(raw);
    const wellFormed = normalized !== null && (component === "pan" ? PAN_SHAPE.test(normalized) : component === "gst" ? GSTIN_SHAPE.test(normalized) : true);
    if (!normalized || !wellFormed) {
      blockers.push({ code: "no_usable_extracted_value", message: `The extraction holds no usable ${component} value.`, fieldKey });
      continue;
    }

    const held = component === "pan" ? (existing?.pan?.number ?? null) : component === "aadhaar" ? ((existing as PartnerRestrictedIdentityDto | null)?.aadhaar?.number ?? null) : existing?.gst ? (existing.gst.number ?? "declared-not-applicable") : null;
    if (input.mode === "FILL_MISSING") {
      if (held !== null) conflicts.push(component);
    } else if (held === null) {
      conflicts.push(component);
    } else if (held !== "declared-not-applicable" && normalizeIdentityCode(held) === normalized) {
      conflicts.push(component);
    }

    if (component === "pan") next.pan = { number: normalized };
    else if (component === "aadhaar") next.aadhaar = { number: normalized };
    else next.gst = { applicable: true, number: normalized };
  }

  if (blockers.length > 0) return financeAgreementsNotReadyResult("The extracted identity cannot be applied yet.", blockers);
  if (conflicts.length > 0) {
    return financeAgreementsConflictResult(
      input.mode === "FILL_MISSING"
        ? `CreatorOps already holds: ${conflicts.join(", ")}. Use OVERWRITE_MISMATCH with an acknowledged reason to replace it.`
        : `Nothing to overwrite for: ${conflicts.join(", ")} (empty, or already the same value). Use FILL_MISSING for empty components.`,
    );
  }

  // Merged existing + new: unchanged components are carried through exactly as the owning module returned them.
  const expectedVersion = existing?.version ?? 0;
  const merged = {
    pan: next.pan ?? existing?.pan ?? null,
    gst: next.gst ?? existing?.gst ?? null,
    bank: existing?.bank ?? null,
    expectedVersion,
  };
  const saved =
    counterparty.type === "PARTNER"
      ? await savePartnerRestrictedIdentity(viewer, counterparty.partner.partnerRef, { ...merged, aadhaar: next.aadhaar ?? (existing as PartnerRestrictedIdentityDto | null)?.aadhaar ?? null }, requestId)
      : await saveVendorRestrictedIdentity(viewer, counterparty.vendor.vendorRef, merged, requestId);
  if (!saved.ok) return mapOwningFailure(saved);

  const recorded = await recordEvent({
    agreementRef: input.agreementRef,
    kind: "kyc_updated_from_agreement",
    version: version.version,
    actorUserRef: viewer.userRef,
    metadata: { components: input.components, mode: input.mode, counterpartyType: type, resolutionAcknowledged: input.resolution?.acknowledged === true, ...(input.resolution ? { reason: input.resolution.reason } : {}) },
    requestId,
  });
  if (!recorded) return financeAgreementsInternalResult("The identity record was updated, but the agreement audit event could not be recorded.");

  return { ok: true, data: { agreementRef: input.agreementRef, version: version.version, counterpartyType: type, mode: input.mode, components: [...input.components], identityVersion: saved.data.version } };
}

// The audit event, in its OWN transaction (the owning module's write already committed). Returns false
// when it could not be written so the caller can say so, rather than pretending nothing happened.
async function recordEvent(event: { agreementRef: string; kind: "master_data_updated" | "kyc_updated_from_agreement"; version: number; actorUserRef: string; metadata: Record<string, unknown>; requestId: string }): Promise<boolean> {
  try {
    const createdAt = new Date().toISOString();
    await getAdminFirestore().runTransaction(async (tx) => {
      appendAgreementEvent(tx, { ...event, createdAt });
    });
    return true;
  } catch {
    return false;
  }
}
