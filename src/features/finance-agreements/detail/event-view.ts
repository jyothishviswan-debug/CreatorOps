import type { AgreementEventDto } from "@/server/finance-agreements/client-dto";
import { AGREEMENT_FIELD_BY_KEY, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementEntryDecision, CounterpartyType } from "@/server/finance-agreements/types";

import { NO_VALUE_TEXT, agreementTypeLabel, counterpartyTypeLabel, decisionChip, eventKindLabel, fieldLabel, formatEffectivePeriod, formatInstant, kycComponentLabel, sourceModeLabel, type KycComponentKey, type PillTone } from "../format";

// Step 14B: an Agreement audit event -> one human line (pure). Events carry allowlist-redacted metadata only (version numbers, statuses,
// counts, field NAMES, opaque refs, a typed reason) - never a field value, an amount, an identity value or contract text - and this mapper
// reads nothing else: every access is type-guarded, an unknown / malformed key is ignored, and no value is ever echoed except the
// human-typed reason of a suspend / end (already screened by the server).
export type EventView = {
  kind: AgreementEventDto["kind"];
  label: string;
  // One quiet sentence; null when the event needs nothing more.
  detail: string | null;
  version: number;
  tone: PillTone;
  at: string;
  actorRef: string;
};

type Metadata = Record<string, unknown>;

const num = (metadata: Metadata, key: string): number | null => (typeof metadata[key] === "number" && Number.isFinite(metadata[key]) ? (metadata[key] as number) : null);
const str = (metadata: Metadata, key: string): string | null => (typeof metadata[key] === "string" && (metadata[key] as string).length > 0 ? (metadata[key] as string) : null);

function knownFieldLabel(metadata: Metadata): string | null {
  const key = str(metadata, "fieldKey");
  return key !== null && Object.prototype.hasOwnProperty.call(AGREEMENT_FIELD_BY_KEY, key) ? fieldLabel(key as AgreementFieldKey) : null;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const DECISIONS: readonly string[] = ["PENDING", "ACCEPTED", "CORRECTED", "UNAVAILABLE", "NOT_APPLICABLE"];

function componentList(metadata: Metadata): string | null {
  const list = metadata.components;
  if (!Array.isArray(list)) return null;
  const labels = list.filter((item): item is KycComponentKey => item === "pan" || item === "aadhaar" || item === "gst" || item === "bank").map((item) => kycComponentLabel(item));
  return labels.length > 0 ? labels.join(", ") : null;
}

function detailFor(event: AgreementEventDto, metadata: Metadata): string | null {
  switch (event.kind) {
    case "created": {
      const type = str(metadata, "counterpartyType");
      const source = str(metadata, "sourceMode");
      const parts = [type === "PARTNER" || type === "VENDOR" ? `${counterpartyTypeLabel(type as CounterpartyType)} Agreement` : null, source ? `source: ${sourceModeLabel(source as "MANUAL" | "EXTRACTED" | "MIXED")}` : null];
      const text = parts.filter((part): part is string => part !== null).join(" · ");
      const opened = text.length > 0 ? `Draft version ${event.version} opened (${text}).` : `Draft version ${event.version} opened.`;
      // Step 14B.1 provenance: the Agreement was started from Agreement-led onboarding.
      if (str(metadata, "createdVia") === "FINANCE_AGREEMENT_ONBOARDING") {
        const record = type === "PARTNER" || type === "VENDOR" ? counterpartyTypeLabel(type as CounterpartyType) : "record";
        const provenance = `${opened} ${str(metadata, "onboardingMode") === "NEW_COUNTERPARTY" ? `Created from Finance Agreement onboarding: the ${record} record was created from this Agreement.` : `Started from Finance Agreement onboarding using an existing ${record}.`}`;
        // The wizard promises the deliberate `create a new one anyway` reason is recorded in the Agreement activity: show it here.
        const reason = str(metadata, "reason");
        return metadata.duplicatesAcknowledged === true && reason ? `${provenance} A possible existing ${record} was reviewed and a new one was created deliberately. Reason: ${reason}` : provenance;
      }
      return opened;
    }
    case "field_decided": {
      const label = knownFieldLabel(metadata);
      const decision = str(metadata, "decision");
      const decisionText = decision !== null && DECISIONS.includes(decision) ? decisionChip(decision as AgreementEntryDecision).label : null;
      if (label && decisionText) return `${label}: ${decisionText}.`;
      return label ?? null;
    }
    case "extraction_attached": {
      const attached = num(metadata, "attachedCount") ?? num(metadata, "proposalCount");
      return attached === null ? "Extracted values were attached as proposals that still need a decision." : `${plural(attached, "extracted value")} attached as proposals that still need a decision.`;
    }
    case "confirmed": {
      const type = str(metadata, "agreementType");
      const from = str(metadata, "effectiveFrom");
      const to = str(metadata, "effectiveTo");
      const parts = [type ? agreementTypeLabel(type) : null, from ? formatEffectivePeriod(from, to) : null].filter((part): part is string => part !== null);
      return parts.length > 0 ? `Terms frozen · ${parts.join(" · ")}.` : "Terms frozen.";
    }
    case "activated": {
      const replaced = num(metadata, "supersededVersion");
      return replaced === null ? `Version ${event.version} is now the current version.` : `Version ${event.version} is now the current version and replaces version ${replaced}.`;
    }
    case "superseded": {
      const by = num(metadata, "supersededByVersion");
      return by === null ? `Version ${event.version} was replaced. It stays readable.` : `Version ${event.version} was replaced by version ${by}. It stays readable.`;
    }
    case "revision_created": {
      const previous = num(metadata, "previousVersion");
      const next = num(metadata, "newVersion") ?? event.version;
      return previous === null ? `Version ${next} opened as a revision.` : `Version ${next} opened as a revision of version ${previous}. Version ${previous} stays in force until the revision is activated.`;
    }
    case "suspended": {
      const reason = str(metadata, "reason");
      return reason ? `Reason: ${reason}` : null;
    }
    case "resumed":
      return `Version ${event.version} is in force again.`;
    case "ended": {
      const reason = str(metadata, "reason");
      return reason ? `Reason: ${reason}` : null;
    }
    case "master_data_updated": {
      const label = knownFieldLabel(metadata);
      const type = str(metadata, "counterpartyType");
      const record = type === "PARTNER" || type === "VENDOR" ? `${counterpartyTypeLabel(type as CounterpartyType)} record` : "record";
      const mode = str(metadata, "mode");
      const how = mode === "FILL_MISSING" ? "filled a missing value" : mode === "OVERWRITE_MISMATCH" ? "replaced a different value after confirmation" : "updated";
      return label ? `${label} on the ${record}: ${how}.` : `The ${record} was ${how}.`;
    }
    case "kyc_updated_from_agreement": {
      const components = componentList(metadata);
      return components ? `KYC updated in the owning record: ${components}.` : "KYC updated in the owning record.";
    }
    case "document_stored": {
      const file = str(metadata, "fileName");
      return file ? `The original signed document (${file}) was stored.` : "The original signed document was stored.";
    }
    case "document_store_failed": {
      const attempts = num(metadata, "attemptCount");
      return `The original signed document could not be stored${attempts && attempts > 1 ? ` (attempt ${attempts})` : ""}. It can be retried.`;
    }
    default:
      return null;
  }
}

const TONES: Partial<Record<AgreementEventDto["kind"], PillTone>> = {
  confirmed: "blue",
  activated: "default",
  resumed: "default",
  suspended: "orange",
  ended: "gray",
  superseded: "gray",
  document_store_failed: "orange",
};

export function describeAgreementEvent(event: AgreementEventDto): EventView {
  const metadata: Metadata = event.metadata && typeof event.metadata === "object" ? event.metadata : {};
  return {
    kind: event.kind,
    label: eventKindLabel(event.kind),
    detail: detailFor(event, metadata),
    version: event.version,
    tone: TONES[event.kind] ?? "gray",
    at: event.createdAt ? formatInstant(event.createdAt) : NO_VALUE_TEXT,
    actorRef: event.actorUserRef,
  };
}
