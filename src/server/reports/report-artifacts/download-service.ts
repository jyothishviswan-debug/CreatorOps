import type { ActorContext } from "@/server/authz/types";

import { getReportDefinition } from "../catalog";
import { getReportArtifactDoc, getReportRunHeadDoc, getReportVersionDoc } from "../firestore";
import { requireReportsAccess, requireSourceFeatureAccess } from "../reports-gate";
import { reportLifecycleNotFoundResult, reportLifecycleUnauthorizedResult, type ReportLifecycleResult } from "../types";
import { getReportArtifactStore, locatorForReportArtifactRef, ReportArtifactStoreError } from "./artifact-store";

// Reports Final-Master (spec section 23): artifact download authorization. DISCLOSED POLICY (the
// spec's own explicit "document whether artifact access requires current access, publication
// audience, or both, then test that policy"): download requires BOTH (a) the actor's CURRENT
// `download_artifact` ActionPermission on the `reports` feature, AND (b) the actor's CURRENT
// FeatureAccess to every source module the underlying report reads through (the same
// requireSourceFeatureAccess gate runReport itself uses). Being part of the "publication audience" at
// finalize time grants NOTHING on its own and is never separately checked - if a role's access is
// later narrowed (a source feature grant removed, or download_artifact revoked), a previously
// generated artifact immediately becomes undownloadable to that actor, even though the artifact
// document and bytes still exist. This is the same "current access, not a point-in-time snapshot of
// who could see it" policy every other module in this codebase already uses (compare Finance
// Agreement's own artifact access, gated by current `finance` FeatureAccess, never by who was present
// when the Agreement was signed).
export type ReportArtifactDownload = { bytes: Uint8Array; contentType: string; safeFilename: string };

export async function downloadReportArtifact(actor: ActorContext | null, rawArtifactRef: unknown): Promise<ReportLifecycleResult<ReportArtifactDownload>> {
  const access = await requireReportsAccess(actor, "download_artifact");
  if (!access.ok) return reportLifecycleUnauthorizedResult(access.reason);
  if (!actor) return reportLifecycleUnauthorizedResult("not_authenticated");
  if (typeof rawArtifactRef !== "string") return reportLifecycleNotFoundResult();

  const artifact = await getReportArtifactDoc(rawArtifactRef);
  if (!artifact) return reportLifecycleNotFoundResult();

  const definition = getReportDefinition(artifact.reportId);
  const sourceAccess = await requireSourceFeatureAccess(actor, definition.requiredSourceFeatures);
  if (!sourceAccess.ok) return reportLifecycleUnauthorizedResult(sourceAccess.reason);

  // The artifact must also belong to a version the actor is otherwise allowed to VIEW (a DRAFT
  // version's artifact - which never exists today since artifacts are only generated at finalize -
  // would still be scoped to its own drafter; defense in depth for a future draft-preview artifact).
  const head = await getReportRunHeadDoc(artifact.runRef);
  if (!head) return reportLifecycleNotFoundResult();
  const version = await getReportVersionDoc(artifact.runRef, artifact.version);
  if (!version) return reportLifecycleNotFoundResult();
  if (version.status === "DRAFT" || version.status === "IN_REVIEW") {
    if (version.actorUserRef !== actor.userRef) return reportLifecycleNotFoundResult();
  }

  const locator = locatorForReportArtifactRef(artifact.artifactRef, artifact.format);
  try {
    const bytes = await getReportArtifactStore().get(locator);
    return { ok: true, data: { bytes, contentType: artifact.contentType, safeFilename: artifact.safeFilename } };
  } catch (error) {
    if (error instanceof ReportArtifactStoreError && error.code === "not_found") return reportLifecycleNotFoundResult();
    throw error;
  }
}
