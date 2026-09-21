import type { FinanceApiFailure } from "../../api-client";
import { refusalNeedsRecheck } from "./duplicate-rules";

// Step 14B.1 onboarding: how a FAILED create call reads (pure). Two very different things can go wrong and the wizard must not blur them:
//   refused  the server answered "no" before writing anything (a typed blocker, a field problem, a denial): the inputs are editable again
//   lost     no usable answer (network / server error): the request MAY have reached the server, so the inputs stay locked and the SAME
//            request is sent again (the step ledger makes that safe: nothing is created twice)

export const REQUEST_CONFLICT_CODE = "request_conflict";

export type CreateFailureView = { kind: "refused"; message: string; code: string | null; recheck: boolean } | { kind: "lost"; message: string };

export const LOST_ANSWER_MESSAGE = "We could not confirm whether it was created. Retry sends the same request, and nothing is created twice.";

export function classifyCreateFailure(failure: FinanceApiFailure): CreateFailureView {
  if (failure.kind === "not_ready") {
    const blocker = failure.blockers?.[0];
    const code = blocker?.code ?? null;
    return { kind: "refused", message: blocker?.message ?? failure.message, code, recheck: refusalNeedsRecheck(code) };
  }
  if (failure.kind === "unauthorized" || failure.kind === "forbidden") return { kind: "refused", message: failure.message, code: null, recheck: false };
  if (failure.kind === "not_found") return { kind: "refused", message: "That record is not available to you. Check for an existing record again, or create a new one.", code: null, recheck: true };
  if (failure.kind === "invalid") return { kind: "refused", message: failure.message, code: null, recheck: false };
  if (failure.kind === "stale" || failure.kind === "conflict") {
    // The same clientRequestId was used for a different request. The wizard never does that by itself; it means an earlier attempt is still on record.
    return { kind: "refused", message: "These details differ from an earlier attempt that has already started. Change the details and start again to use them.", code: REQUEST_CONFLICT_CODE, recheck: false };
  }
  return { kind: "lost", message: LOST_ANSWER_MESSAGE };
}
