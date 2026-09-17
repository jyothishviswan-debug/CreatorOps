import { listVendorLinksForPartner } from "@/server/vendors/vendor-partner-link-service";
import { resolveRequestActor, toVendorsHttpResponse } from "@/server/vendors/http";

type RouteParams = { params: Promise<{ partnerRef: string }> };

// GET /api/partners/[partnerRef]/vendor-links - Step 8A section 10's
// Partner-side relationship query. Lives under the Partners route tree
// (not /api/vendors/*) because it is gated ENTIRELY by the Partner's own
// scope, never Vendor scope - see listVendorLinksForPartner's own
// comment for why this is the one deliberate exception. Read-only;
// Partner UI is not wired to it yet (Step 8B). Added here as harmless,
// additive API surface only - no existing Partner route/UI is touched.
export async function GET(_request: Request, { params }: RouteParams) {
  const { partnerRef } = await params;
  const actor = await resolveRequestActor();
  const result = await listVendorLinksForPartner(actor, partnerRef);
  return toVendorsHttpResponse(result);
}
