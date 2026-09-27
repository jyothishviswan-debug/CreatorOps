import type { TargetReference, TargetType } from "@/server/operations/target-ref";
import { TARGET_TYPE_LABEL } from "./copy";

// Step 18B: the closed map from a bounded TargetReference to its OWN canonical source screen -
// never a generic "record viewer", never a route Operations invents. A target type this map has no
// route for (PARTNER_ACCOUNT/AGREEMENT today - neither has its own standalone detail route in this
// app; an Agreement is viewed from its counterparty's own screen) yields `null`, and the UI must
// render the safe label WITHOUT an "Open linked record" link rather than guess a URL. Section 9:
// knowing a targetRef never grants access to the target - the destination route re-checks access
// itself (this map only decides WHERE to link, never IF the actor may see it).
export function targetHref(target: TargetReference): string | null {
  switch (target.targetType) {
    case "PARTNER":
      return `/partners/${encodeURIComponent(target.targetRef)}`;
    case "VENDOR":
      return `/vendors/${encodeURIComponent(target.targetRef)}`;
    case "CAMPAIGN":
      return `/campaigns/${encodeURIComponent(target.targetRef)}`;
    case "ASSIGNMENT":
      return `/assignments/${encodeURIComponent(target.targetRef)}`;
    case "CONTENT":
      return `/content/${encodeURIComponent(target.targetRef)}`;
    case "PARTNER_REVIEW":
      return `/partner-reviews/${encodeURIComponent(target.targetRef)}`;
    case "PAYABLE":
      return `/finance/payables/${encodeURIComponent(target.targetRef)}`;
    case "INVOICE":
      return `/finance/invoices/${encodeURIComponent(target.targetRef)}`;
    case "PAYMENT":
      return `/finance/payments/${encodeURIComponent(target.targetRef)}`;
    case "AGREEMENT":
    case "PARTNER_ACCOUNT":
      return null;
    default:
      return null;
  }
}

// A resolved display name leads; when none is available (not readable by this actor, a Finance/Agreement
// target with no safe name, or a since-removed record) only the type is shown - the raw ref never dominates
// the label (it stays available as an explicit secondary "Reference" line on the detail screens).
export function targetLabel(target: TargetReference, displayName?: string | null): string {
  return displayName ? `${TARGET_TYPE_LABEL[target.targetType]} · ${displayName}` : TARGET_TYPE_LABEL[target.targetType];
}

// The Approval Queue's own deep-link map (section 6/11): sourceModule + sourceType -> the item's
// real canonical screen in its OWN module. Never a generic "approval viewer" route.
export function approvalSourceHref(input: { sourceModule: string; sourceRef: string }): string | null {
  switch (input.sourceModule) {
    case "finance_payables":
      return `/finance/payables/${encodeURIComponent(input.sourceRef)}`;
    case "finance_invoices":
      return `/finance/invoices/${encodeURIComponent(input.sourceRef)}`;
    case "finance_payments":
      return `/finance/payments/${encodeURIComponent(input.sourceRef)}`;
    case "partner_reviews":
      return `/partner-reviews/${encodeURIComponent(input.sourceRef)}`;
    default:
      return null;
  }
}

export const SUPPORTED_TARGET_TYPES: TargetType[] = ["PARTNER", "PARTNER_ACCOUNT", "VENDOR", "CAMPAIGN", "ASSIGNMENT", "CONTENT", "PARTNER_REVIEW", "AGREEMENT", "PAYABLE", "INVOICE", "PAYMENT"];
