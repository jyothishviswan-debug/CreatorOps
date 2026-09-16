import { requireAdministrationAccess } from "@/server/authz/administration-gate";
import type { ActionId } from "@/server/authz/actions";
import { toScopeSummaryDto, type ScopeSummaryDto } from "@/server/authz/client-dto";
import { FEATURES, type FeatureId } from "@/server/authz/features";
import { getAccessGrantDoc, getSensitiveAccessGrantDoc, getUserAccessOverrideDoc, getUserDocByRef } from "@/server/authz/firestore";
import { MODULE_ACTIONS } from "@/server/authz/module-actions";
import type { Role } from "@/server/authz/roles";
import { getActorScopeGrants } from "@/server/authz/scope";
import type { AccessGrantDoc, ActorContext, UserAccessOverrideDoc } from "@/server/authz/types";
import { invalidInputResult, unauthorizedResult, type ServiceResult } from "./types";

// "source" makes it possible for the UI to say WHY an effective value is
// what it is - role default vs an explicit user override - without
// re-deriving that itself (see capabilities.ts's resolveFeatureAccess/
// resolveActionAccess, which this mirrors exactly, just also recording
// which branch produced the result).
export type EffectiveSource = "role" | "override_allow" | "override_deny";
export type EffectiveValue = { value: boolean; source: EffectiveSource };

function resolveWithSource(roleValue: boolean, override: boolean | undefined): EffectiveValue {
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
  modules: Record<FeatureId, EffectiveModuleEntry>;
  scope: ScopeSummaryDto;
  sensitiveCategories: string[];
};

function overrideTriState(value: boolean | undefined): "inherit" | "allow" | "deny" {
  if (value === undefined) return "inherit";
  return value ? "allow" : "deny";
}

function buildModuleEntry(feature: FeatureId, grant: AccessGrantDoc | null, override: UserAccessOverrideDoc | null): EffectiveModuleEntry {
  const roleFeature = grant?.features[feature];
  const roleBaseline = roleFeature?.view === true;
  const overrideFeature = override?.features[feature];
  const moduleEffective = resolveWithSource(roleBaseline, overrideFeature?.view);

  const actions: EffectiveModuleEntry["actions"] = {};
  for (const action of MODULE_ACTIONS[feature]) {
    const roleActionValue = roleFeature?.actions[action.id] === true;
    const overrideActionValue = overrideFeature?.actions[action.id];
    // Effective action permission also requires effective module access -
    // an action can never be usable on a module that's effectively denied,
    // even if the action itself was explicitly allowed at some point.
    const actionEffective = moduleEffective.value ? resolveWithSource(roleActionValue, overrideActionValue) : { value: false as boolean, source: moduleEffective.source };
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

  const [scopeGrants, accessGrantDoc, sensitiveDoc, overrideDoc] = await Promise.all([
    getActorScopeGrants(targetActor),
    getAccessGrantDoc(targetDoc.role),
    getSensitiveAccessGrantDoc(targetDoc.role),
    getUserAccessOverrideDoc(targetDoc.uid),
  ]);

  const modules = {} as Record<FeatureId, EffectiveModuleEntry>;
  const activeFeatures: FeatureId[] = [];
  for (const feature of FEATURES) {
    const entry = buildModuleEntry(feature, accessGrantDoc, overrideDoc);
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
      overridesVersion: overrideDoc?.version ?? 0,
      modules,
      scope: toScopeSummaryDto(scopeGrants),
      sensitiveCategories: sensitiveDoc?.categories ?? [],
    },
  };
}
