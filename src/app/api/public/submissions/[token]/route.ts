import { NextResponse } from "next/server";

import { resolveExternalSubmission, submitExternalLinks } from "@/server/assignments/external-submission-service";
import { checkAndRecordAttempt, rateLimitTokenKey, requestIpKey } from "@/server/assignments/rate-limit";

// Step 10A section 16: the one deliberately, genuinely unauthenticated
// business-data surface in this app - hence the separate /api/public/
// prefix (no other route lives under it), making that fact visually
// unmistakable in the route tree. This file must NEVER import
// resolveRequestActor or anything from @/server/administration/http - the
// bearer token in the URL is the SOLE authorization primitive, verified
// server-side by re-hashing and a deterministic doc-id lookup (see
// external-submission-service.ts's loadValidSession). No client-side
// Firestore access exists anywhere in this flow; every read/write goes
// through this trusted route and the Admin SDK.

type RouteParams = { params: Promise<{ token: string }> };

// Step 10A.1 section 5: exact limit/window/keying - 20 attempts per
// rolling 60s window, keyed by (route action, caller IP, hashed token) so
// abuse against one token or from one IP is bounded independently of
// every other token/IP. Never keyed by the raw token itself (see
// rate-limit.ts's own rateLimitTokenKey comment) - NOT a production
// defense (in-process, per-instance, no shared state - see rate-limit.ts).
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

// GET /api/public/submissions/[token] - resolve a valid token to the
// minimum safe brief (Step 10A section 12's exact allowlist). An invalid,
// expired, revoked, used, or otherwise unusable token gets the exact same
// generic response - never a distinguishable reason (Step 10A section 11:
// "revoked/expired/used tokens return a generic safe response").
export async function GET(request: Request, { params }: RouteParams) {
  const { token } = await params;

  if (!checkAndRecordAttempt(`resolve:${requestIpKey(request)}:${rateLimitTokenKey(token)}`, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const result = await resolveExternalSubmission(token);
  if (!result.ok) return NextResponse.json({ error: "This submission link is no longer valid." }, { status: 404 });

  return NextResponse.json(result.data, { status: 200 });
}

// POST /api/public/submissions/[token] {rows: [{platform, url}, ...]}
export async function POST(request: Request, { params }: RouteParams) {
  const { token } = await params;

  if (!checkAndRecordAttempt(`submit:${requestIpKey(request)}:${rateLimitTokenKey(token)}`, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rows = body && typeof body === "object" && "rows" in body ? (body as { rows: unknown }).rows : undefined;
  const result = await submitExternalLinks(token, rows);

  if (!result.ok) {
    const status = result.code === "invalid" ? 400 : 404;
    return NextResponse.json({ error: result.message }, { status });
  }

  return NextResponse.json(result.data, { status: 201 });
}
