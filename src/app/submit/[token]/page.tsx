import type { Metadata } from "next";

import "@/ui/public-submit.css";
import { resolveExternalSubmission } from "@/server/assignments/external-submission-service";
import { PublicSubmissionPage } from "@/features/assignments/public/PublicSubmissionPage";

// Step 10C section 11: dynamic/no-store rendering - this page resolves a
// bearer token on every request and must never be cached (the token-bound
// data could otherwise be served stale, or to the wrong viewer, from a
// shared cache). cacheComponents is not enabled in this project's
// next.config.ts, so the classic route-segment-config exports still
// apply (see node_modules/next/dist/docs's own route-segment-config
// version history).
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Static, token-free metadata - the title/description never include the
// token (section 11's own rule), so there is nothing dynamic to compute
// per-request here.
export const metadata: Metadata = {
  title: "Submit links · CreatorOps",
  description: "Secure, single-use link submission.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function SubmitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await resolveExternalSubmission(token);

  return <PublicSubmissionPage token={token} initial={result.ok ? result.data : null} />;
}
