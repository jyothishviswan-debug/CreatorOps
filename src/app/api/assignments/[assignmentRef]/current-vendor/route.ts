import { getAssignmentCurrentVendorOption } from "@/server/assignments/external-submission-service";
import { resolveRequestActor, toAssignmentsHttpResponse } from "@/server/assignments/http";

type RouteParams = { params: Promise<{ assignmentRef: string }> };

// GET /api/assignments/[assignmentRef]/current-vendor - Step 10C section
// 17's bounded, Assignment-scoped helper read for the WhatsApp share
// dialog's Vendor recipient option. Same action gate as session creation
// (manage_assignment_external_submission); never a broad Vendor list.
export async function GET(_request: Request, { params }: RouteParams) {
  const { assignmentRef } = await params;
  const actor = await resolveRequestActor();

  const result = await getAssignmentCurrentVendorOption(actor, assignmentRef);
  return toAssignmentsHttpResponse(result);
}
