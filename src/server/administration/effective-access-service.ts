import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import type { ActionId } from "@/server/authz/actions";
import { toScopeSummaryDto, type ScopeSummaryDto } from "@/server/authz/client-dto";
import { FEATURES, type FeatureId } from "@/server/authz/features";
import { getAccessGrantDoc, getSensitiveAccessGrantDoc, getUserAccessOverrideLookup, getUserDocByRef } from "@/server/authz/firestore";
import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import type { Role } from "@/server/authz/roles";
import { getActorScopeGrants } from "@/server/authz/scope";
import type { AccessGrantDoc, ActorContext, OverrideLookup } from "@/server/authz/types";
import { invalidInputResult, unauthorizedResult, type ServiceResult } from "./types";

// "source" makes it possible for the UI to say WHY an effective value is
// what it is - role default vs an explicit user override - without
// re-deriving that itself (see capabilities.ts's resolveFeatureAccess/
// resolveActionAccess, which this mirrors exactly, just also recording
// which branch produced the result). "override_invalid" is Step 5B.1A's
// addition: the user's override document exists but fails schema
// validation, so every module/action denies outright regardless of role
// baseline - distinct from "override_deny" (an explicit, well-formed
// deny) so the UI can explain that this is a data-integrity problem, not
// an intentional access decision.
export type EffectiveSource = "role" | "override_allow" | "override_deny" | "override_invalid";
export type EffectiveValue = { value: boolean; source: EffectiveSource };

function resolveWithSource(roleValue: boolean, override: boolean | undefined, overrideInvalid: boolean): EffectiveValue {
  if (overrideInvalid) return { value: false, source: "override_invalid" };
  if (override !== undefined) return { value: override, source: override ? "override_allow" : "override_deny" };
  return { value: roleValue, source: "role" };
}

export type EffectiveModuleEntry = {
  roleBaseline: boolean;
  override: "inherit" | "allow" | "deny";
  effective: EffectiveValue;
  actions: Partial<
    Record<
      ActionId,
      {
        roleBaseline: boolean;
        override: "inherit" | "allow" | "deny";
        effective: EffectiveValue;
      }
    >
  >;
};

export type EffectiveAccessDto = {
  userRef: string;
  role: Role;
  active: boolean;
  activeFeatures: FeatureId[];
  overridesVersion: number;
  // Step 5B.1A: lets Administration explain a denial without leaking the
  // raw malformed document. "absent" and "valid" both behave normally
  // (inherit / apply overrides); "invalid" means every module/action
  // below is forced to deny, regardless of what the role baseline says.
  overrideProfileStatus: "absent" | "valid" | "invalid";
  modules: Record<FeatureId, EffectiveModuleEntry>;
  scope: ScopeSummaryDto;
  sensitiveCategories: string[];
};

function overrideTriState(value: boolean | undefined): "inherit" | "allow" | "deny" {
  if (value === undefined) return "inherit";
  return value ? "allow" : "deny";
}

function buildModuleEntry(feature: FeatureId, grant: AccessGrantDoc | null, override: OverrideLookup): EffectiveModuleEntry {
  const roleFeature = grant?.features[feature];
  const roleBaseline = roleFeature?.view === true;
  const overrideInvalid = override.status === "invalid";
  const overrideFeature = override.status === "valid" ? override.doc.features[feature] : undefined;
  const moduleEffective = resolveWithSource(roleBaseline, overrideFeature?.view, overrideInvalid);

  const actions: EffectiveModuleEntry["actions"] = {};
  for (const action of MODULE_ACTIONS[feature]) {
    const roleActionValue = roleFeature?.actions[action.id] === true;
    const overrideActionValue = overrideFeature?.actions[action.id];
    // Effective action permission also requires effective module access -
    // an action can never be usable on a module that's effectively denied,
    // even if the action itself was explicitly allowed at some point.
    const actionEffective = moduleEffective.value ? resolveWithSource(roleActionValue, overrideActionValue, overrideInvalid) : { value: false as boolean, source: moduleEffective.source };
    actions[action.id] = {
      roleBaseline: roleActionValue,
      override: overrideTriState(overrideActionValue),
      effective: actionEffective,
    };
  }

  return {
    roleBaseline,
    override: overrideTriState(overrideFeature?.view),
    effective: moduleEffective,
    actions,
  };
}

// Effective Access Review: what does this user *actually* resolve to,
// right now, using the exact same shared precedence every protected
// route and /api/me already use (resolveFeatureAccess/resolveActionAccess
// in capabilities.ts - this module mirrors that precedence exactly,
// annotated with source, rather than reinterpreting it). Run against a
// target user instead of the requesting actor, with far more detail than
// the minimal client DTO needs.
export async function getEffectiveAccess(actor: ActorContext | null, userRef: unknown): Promise<ServiceResult<EffectiveAccessDto>> {
  if (!actor) return unauthorizedResult("not_authenticated");
  const gate = await requireAdministrationAccess(actor, "manage_users");
  if (!gate.ok) return unauthorizedResult(gate.reason);

  if (typeof userRef !== "string" || userRef.length === 0) return invalidInputResult("Missing userRef.");

  const targetDoc = await getUserDocByRef(userRef);
  if (!targetDoc) return { ok: false, code: "not_found", message: "User not found." };

  const targetActor: ActorContext = {
    uid: targetDoc.uid,
    email: targetDoc.email,
    role: targetDoc.role,
    displayName: targetDoc.displayName,
    userRef: targetDoc.userRef,
  };

  const [scopeGrants, accessGrantDoc, sensitiveDoc, overrideLookup] = await Promise.all([
    getActorScopeGrants(targetActor),
    getAccessGrantDoc(targetDoc.role),
    getSensitiveAccessGrantDoc(targetDoc.role),
    getUserAccessOverrideLookup(targetDoc.uid),
  ]);

  const modules = {} as Record<FeatureId, EffectiveModuleEntry>;
  const activeFeatures: FeatureId[] = [];
  for (const feature of FEATURES) {
    const entry = buildModuleEntry(feature, accessGrantDoc, overrideLookup);
    modules[feature] = entry;
    if (entry.effective.value) activeFeatures.push(feature);
  }

  return {
    ok: true,
    data: {
      userRef: targetDoc.userRef,
      role: targetDoc.role,
      active: targetDoc.active,
      activeFeatures,
      // A malformed doc still has SOME (unknown) version on disk - 0 is
      // the same "start a corrective write" base runOverrideMutation's
      // own mutationBase uses, never the stale/unknown number itself.
      overridesVersion: overrideLookup.status === "valid" ? overrideLookup.doc.version : 0,
      overrideProfileStatus: overrideLookup.status,
      modules,
      scope: toScopeSummaryDto(scopeGrants),
      sensitiveCategories: sensitiveDoc?.categories ?? [],
    },
  };
}
