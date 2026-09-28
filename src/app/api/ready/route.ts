import { NextResponse } from "next/server";

import { getAdminAuth, getAdminFirestore } from "@/server/firebase/admin";
import { getServerEnv } from "@/lib/env/server";

// Production hardening (base spec section 29 - health/readiness): READINESS. Checks the
// dependencies this instance actually needs to serve traffic SAFELY - required config parses
// (getServerEnv's own zod schema), and the Firebase Admin SDK clients construct without throwing.
// Constructing an Admin SDK client is local (parses config, builds an in-memory client object) and
// makes no network call - this deliberately stays far short of the spec's own "do not include
// expensive business queries" line; it is not a real Firestore read. Never returns a stack trace,
// config value, or provider detail either way - only the safe classification an orchestrator needs
// to decide whether to route traffic here. Reachable unauthenticated by design, same as /api/health.
export async function GET() {
  try {
    getServerEnv();
    getAdminFirestore();
    getAdminAuth();
    return NextResponse.json({ status: "ready" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "not_ready" }, { status: 503 });
  }
}
