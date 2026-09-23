// Step 15B: a small, read-only counterparty lookup for Stage 1 (Source). Calls the generic Partner /
// Vendor list endpoints directly (a name-prefix search) - these are root modules, not another Finance
// sub-feature's client code, so this is an ordinary cross-module HTTP call like any other page makes.
export type CounterpartyOption = { ref: string; displayName: string };

async function fetchOptions(url: string, rowsKey: "partners" | "vendors", refKey: "partnerRef" | "vendorRef", signal?: AbortSignal): Promise<CounterpartyOption[]> {
  try {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) return [];
    const body = (await response.json()) as Record<string, unknown>;
    const rows = body[rowsKey];
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const ref = (row as Record<string, unknown>)[refKey];
        const displayName = (row as Record<string, unknown>).displayName;
        return typeof ref === "string" && typeof displayName === "string" ? { ref, displayName } : null;
      })
      .filter((option): option is CounterpartyOption => option !== null);
  } catch {
    return [];
  }
}

export function searchCounterparties(type: "PARTNER" | "VENDOR", prefix: string, signal?: AbortSignal): Promise<CounterpartyOption[]> {
  const query = `?displayNamePrefix=${encodeURIComponent(prefix)}&limit=10`;
  return type === "PARTNER" ? fetchOptions(`/api/partners${query}`, "partners", "partnerRef", signal) : fetchOptions(`/api/vendors${query}`, "vendors", "vendorRef", signal);
}

// A Vendor payable names WHICH Agreement governs the period (a Vendor may hold several). Reads the
// Vendor's own Agreement heads through the Finance Agreements read endpoint - a plain cross-module GET,
// not an import of that feature's client code.
export type VendorAgreementOption = { agreementRef: string; status: string };

export async function listVendorAgreements(vendorRef: string, signal?: AbortSignal): Promise<VendorAgreementOption[]> {
  try {
    const response = await fetch(`/api/finance/agreements?counterpartyType=VENDOR&ref=${encodeURIComponent(vendorRef)}`, { signal, cache: "no-store" });
    if (!response.ok) return [];
    const body = (await response.json()) as { agreements?: unknown };
    if (!Array.isArray(body.agreements)) return [];
    return body.agreements
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const { agreementRef, status } = entry as Record<string, unknown>;
        return typeof agreementRef === "string" && typeof status === "string" ? { agreementRef, status } : null;
      })
      .filter((option): option is VendorAgreementOption => option !== null);
  } catch {
    return [];
  }
}
