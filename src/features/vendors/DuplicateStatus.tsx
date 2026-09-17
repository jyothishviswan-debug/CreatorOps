import { Pill } from "@/ui/Badge";
import type { VendorDuplicateCheckResult } from "@/server/vendors/types";

// Shared rendering for a Vendor duplicate-check result - used by the
// create form's live pre-check. "unknown" (a failed lookup) is always
// shown as its own distinct, unmistakably-not-clean state - never
// collapsed into "no duplicate". Mirrors Partners' own
// DuplicateStatusBanner exactly.
export function DuplicateStatusBanner({ result, checking }: { result: VendorDuplicateCheckResult | null; checking?: boolean }) {
  if (checking) {
    return (
      <div className="banner" role="status">
        Checking for duplicates…
      </div>
    );
  }
  if (!result) return null;

  if (result.status === "unknown") {
    return (
      <div className="banner" role="alert">
        <b>Duplicate check unavailable.</b> The lookup failed - this is unknown/error, not confirmation of no duplicate. Try again before proceeding.
      </div>
    );
  }
  if (result.status === "confirmed") {
    return (
      <div className="banner" role="alert">
        <b>Likely duplicate found.</b> {result.matches.length} matching Vendor{result.matches.length === 1 ? "" : "s"} on file.
        <DuplicateMatchList matches={result.matches} />
      </div>
    );
  }
  if (result.status === "possible") {
    return (
      <div className="banner" role="status">
        <b>Possible duplicate.</b> Review before proceeding.
        <DuplicateMatchList matches={result.matches} />
      </div>
    );
  }
  return (
    <div className="kv">
      <span>Duplicate check</span>
      <Pill tone="default">No duplicate found</Pill>
    </div>
  );
}

function DuplicateMatchList({ matches }: { matches: VendorDuplicateCheckResult["matches"] }) {
  if (matches.length === 0) return null;
  return (
    <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
      {matches.map((match, i) => (
        <li key={`${match.type}-${match.ref}-${i}`} style={{ fontSize: 11 }}>
          {match.type} match on an existing Vendor · {match.confidence} confidence
        </li>
      ))}
    </ul>
  );
}
