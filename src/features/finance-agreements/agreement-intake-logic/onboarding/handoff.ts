import type { AttachExtractionOutcome } from "@/server/finance-agreements/agreement-service";
import type { ContractArtifactDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";

import type { FinanceApiFailure, FinanceApiResult } from "../../api-client";

// Step 14B.1 onboarding: the HAND-OFF from the wizard to the normal intake (pure + one module-level holder).
//
// When the onboarding completes, the wizard navigates to the normal intake of the new draft (`?agreementRef=`). That REMOUNTS the whole form,
// so anything the new form needs from the wizard travels in module scope (the same trick `Start draft` uses):
//   - the SAME File the person selected (held in memory only): the new form sends it through the ordinary upload -> extract -> attach flow, so
//     the persisted extraction (and, later, the restricted KYC values) are produced server-side and never pass through the browser;
//   - the sentence to announce ("Partner created from Finance Agreement onboarding ...").
// If the page is reloaded the File is gone: nothing is lost (the records exist) and the normal Contract source section asks for the file again.

export type OnboardingHandoff = {
  agreementRef: string;
  // The Agreement file the person selected, or null when it is no longer in memory.
  file: File | null;
  // What the new form announces once (already worded).
  announcement: string;
  // USE_EXISTING for a Partner: the platform(s) the person chose in section 1. No Partner Account is named on such an Agreement (Partner-level), so the intended
  // platforms are RECORDED through the `platforms` field once the draft exists - exactly as `Start draft` does for a Partner-level Agreement. Empty otherwise.
  recordPlatforms?: string[];
};

let held: OnboardingHandoff | null = null;

export function holdOnboardingHandoff(handoff: OnboardingHandoff): void {
  held = handoff;
}

// Consumed ONCE by the form that mounted for `agreementRef`; a handoff for another Agreement is left alone (and dropped when replaced).
export function takeOnboardingHandoff(agreementRef: string | null): OnboardingHandoff | null {
  if (!held || !agreementRef || held.agreementRef !== agreementRef) return null;
  const taken = held;
  held = null;
  return taken;
}

export function peekOnboardingHandoff(): OnboardingHandoff | null {
  return held;
}

// --- The re-upload sequence ---------------------------------------------------------------------------------------------------------
// upload the file  ->  extract that artifact  ->  attach the run's proposals to the draft. Each step needs the previous one's result and runs
// only if it succeeded; the first failure stops the sequence and names the stage, so the person is told exactly what still has to be done.
export type ReuploadDeps = {
  upload: (file: File) => Promise<FinanceApiResult<ContractArtifactDto>>;
  extract: (artifactRef: string) => Promise<FinanceApiResult<ExtractionResultDto>>;
  attach: (extractionRunRef: string) => Promise<FinanceApiResult<AttachExtractionOutcome>>;
};

export type ReuploadResult =
  | { ok: true; artifact: ContractArtifactDto; extraction: ExtractionResultDto; attached: true; attachedCount: number }
  // Extracted, but there was nothing to attach (a scanned / unreadable Agreement): a normal, honest outcome, not a failure.
  | { ok: true; artifact: ContractArtifactDto; extraction: ExtractionResultDto; attached: false; attachedCount: 0 }
  | { ok: false; stage: "upload" | "extract" | "attach"; failure: FinanceApiFailure; artifact: ContractArtifactDto | null; extraction: ExtractionResultDto | null };

// Something attachable = at least one proposal the actor may see (the same rule the Contract source section uses).
export const hasAttachableProposals = (extraction: ExtractionResultDto): boolean => extraction.fields.some((field) => field.valueState === "VISIBLE");

export async function reuploadAgreement(file: File, deps: ReuploadDeps): Promise<ReuploadResult> {
  const uploaded = await deps.upload(file);
  if (!uploaded.ok) return { ok: false, stage: "upload", failure: uploaded, artifact: null, extraction: null };
  const extracted = await deps.extract(uploaded.data.artifactRef);
  if (!extracted.ok) return { ok: false, stage: "extract", failure: extracted, artifact: uploaded.data, extraction: null };
  if (!hasAttachableProposals(extracted.data)) return { ok: true, artifact: uploaded.data, extraction: extracted.data, attached: false, attachedCount: 0 };
  const attached = await deps.attach(extracted.data.run.runRef);
  if (!attached.ok) return { ok: false, stage: "attach", failure: attached, artifact: uploaded.data, extraction: extracted.data };
  return { ok: true, artifact: uploaded.data, extraction: extracted.data, attached: true, attachedCount: attached.data.attachedCount };
}

// The sentence for each way the re-upload can end (also the focus target: the section to work on next).
export type HandoffView = { tone: "success" | "warning" | "error"; message: string; nextSection: "cross_verification" | "contract_source" };

export function describeReupload(result: ReuploadResult): HandoffView {
  if (result.ok && result.attached) {
    return { tone: "success", message: `The signed Agreement was added and ${result.attachedCount} extracted ${result.attachedCount === 1 ? "value was" : "values were"} attached to the draft as pending. Continue with Cross-verification and review each value.`, nextSection: "cross_verification" };
  }
  if (result.ok) {
    return { tone: "warning", message: "The signed Agreement was added, but no values could be read from it. Enter the terms in the sections below.", nextSection: "cross_verification" };
  }
  const where = result.stage === "upload" ? "could not be uploaded" : result.stage === "extract" ? "was uploaded, but could not be read" : "was read, but its values could not be attached";
  return { tone: "error", message: `The Agreement draft was created, but the signed Agreement ${where}. ${result.failure.message} Try again, or choose the file again in Contract source.`, nextSection: "contract_source" };
}
