import type { ActorContext } from "@/server/authz/types";
import { getAssignment } from "@/server/assignments/assignment-service";
import { getCampaign } from "@/server/campaigns/campaign-service";
import { getContent } from "@/server/content/content-service";
import { getLead } from "@/server/discovery/lead-service";
import { getPartner } from "@/server/partners/partner-service";
import { getVendor } from "@/server/vendors/vendor-service";

import type { TargetReference } from "./target-ref";

// Whole-product integration: a Task/Reminder target used to render as a raw `Type . ref` string. This resolves a
// human display name for a target by calling the OWNING module's own published, actor-gated getter (the same
// scope/feature checks that module's own screen applies), so the name is shown only when the actor could open the
// target anyway - a target the actor cannot read (or that no longer exists) resolves to null, never a raw record.
// Only the module's already-safe display fields are read (Partner/Vendor displayName, Campaign name, and the
// partner/campaign labels of an Assignment/Content). Finance/Agreement/Review/Account targets resolve to null (the UI then
// shows just the type label). Deduplicated: N distinct targets on a page cost at most N gated reads.
function key(target: TargetReference): string {
  return `${target.targetType}:${target.targetRef}`;
}

async function resolveOne(actor: ActorContext | null, target: TargetReference): Promise<string | null> {
  try {
    switch (target.targetType) {
      case "PARTNER": {
        const r = await getPartner(actor, target.targetRef);
        return r.ok ? r.data.displayName : null;
      }
      case "VENDOR": {
        const r = await getVendor(actor, target.targetRef);
        return r.ok ? r.data.displayName : null;
      }
      case "CAMPAIGN": {
        const r = await getCampaign(actor, target.targetRef);
        return r.ok ? r.data.name : null;
      }
      case "ASSIGNMENT": {
        const r = await getAssignment(actor, target.targetRef);
        return r.ok ? [r.data.partnerDisplayName, r.data.campaignName].filter(Boolean).join(" · ") || null : null;
      }
      case "CONTENT": {
        const r = await getContent(actor, target.targetRef);
        return r.ok ? [r.data.partnerDisplayName, r.data.campaignName].filter(Boolean).join(" · ") || null : null;
      }
      // Notes/Meetings Completion: a Task/Reminder promoted from a Discovery-Lead-owned Meeting
      // Action Item needs a resolvable target name too - same gated-getter composition as every
      // other case above.
      case "DISCOVERY_LEAD": {
        const r = await getLead(actor, target.targetRef);
        return r.ok ? r.data.displayName : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function resolveTargetDisplayNames(actor: ActorContext | null, targets: TargetReference[]): Promise<Map<string, string | null>> {
  const unique = new Map<string, TargetReference>();
  for (const t of targets) unique.set(key(t), t);
  const entries = await Promise.all([...unique.entries()].map(async ([k, t]): Promise<[string, string | null]> => [k, await resolveOne(actor, t)]));
  return new Map(entries);
}

export function targetDisplayKey(target: TargetReference): string {
  return key(target);
}
