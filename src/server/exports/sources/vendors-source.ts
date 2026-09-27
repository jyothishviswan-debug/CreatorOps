import type { ActorContext } from "@/server/authz/types";
import { listVendors } from "@/server/vendors/vendor-service";
import type { VendorDto } from "@/server/vendors/client-dto";

import { mapSourceError } from "../source-errors";
import type { AppliedExportFilters, ExportRow, ExportsServiceResult } from "../types";
import type { FetchRowsOptions } from "./types";

// Composes ONLY Vendors' own published, already actor-scoped, already-bounded listVendors - never a
// raw Firestore read, never a second Vendor query of this module's own invention.

function joinArray(values: string[]): string {
  return values.join("; ");
}

function projectRow(vendor: VendorDto): ExportRow {
  return {
    vendorRef: vendor.vendorRef,
    displayName: vendor.displayName,
    vendorType: vendor.vendorType,
    status: vendor.status,
    email: vendor.email,
    phone: vendor.phone,
    regionIds: joinArray(vendor.regionIds),
    ownerDisplayName: vendor.ownerDisplayName,
    teamIds: joinArray(vendor.teamIds),
    createdAt: vendor.createdAt,
    updatedAt: vendor.updatedAt,
  };
}

export async function fetchVendorsRows(actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions): Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>> {
  const result = await listVendors(actor, {
    limit: options.limit,
    status: appliedFilters.status,
    region: appliedFilters.region,
    vendorType: appliedFilters.vendorType,
  });
  if (!result.ok) return mapSourceError(result);

  const rows = result.data.vendors.map(projectRow);
  return { ok: true, data: { rows, rowCount: rows.length, truncated: result.data.nextCursor !== null } };
}
