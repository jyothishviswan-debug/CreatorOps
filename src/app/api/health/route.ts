import { NextResponse } from "next/server";

// Production hardening (base spec section 29 - health/readiness): LIVENESS. Proves the Next.js
// server process itself is up and responding to requests - nothing more. Must not depend on any
// external dependency (Firestore, Auth, a provider), so an outage in one of THOSE never makes a
// healthy process report itself dead and get killed/recycled by an orchestrator for the wrong
// reason. Readiness (whether this instance should actually receive traffic) is the separate
// GET /api/ready. Reachable unauthenticated by design (proxy.ts already exempts every /api/* path
// from the session gate) - the same way a load balancer/orchestrator health probe expects to reach
// it, with no secret/config detail in the response either way.
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
