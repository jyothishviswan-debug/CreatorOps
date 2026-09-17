"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { PartnerVendorLinkDto } from "@/server/vendors/client-dto";
import { listVendorLinksForPartner } from "@/features/vendors/api-client";
import { effectiveDateLabel, LINK_STATUS_LABELS, linkStatusTone, RELATIONSHIP_TYPE_LABELS, VENDOR_TYPE_LABELS } from "@/features/vendors/format";

// Step 8B section 7 / Step 8B.1 REVISED section 5+8: the real
// Partner-side Vendor relationship slice, replacing the earlier truthful
// "Vendors unavailable" placeholder now that Vendors is accepted. Gated
// ENTIRELY by this Partner's own scope (via
// /api/partners/[partnerRef]/vendor-links - see listVendorLinksForPartner's
// own comment) - never Vendor scope. Presents the current ACTIVE Vendor
// (if any) separately from historical ENDED relationships below - never
// implying more than one simultaneous active Vendor is possible. "Open
// Vendor" renders purely from the server-computed canOpenVendor field on
// each row (no client-side per-row authorization probe - see
// listVendorLinksForPartner's own comment for why a per-row fetch was
// removed).
export function PartnerVendorRelationshipsPanel({ partnerRef }: { partnerRef: string }) {
  const [links, setLinks] = useState<PartnerVendorLinkDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listVendorLinksForPartner(partnerRef).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLinks(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [partnerRef]);

  const activeLink = links?.find((l) => l.status === "ACTIVE") ?? null;
  const historicalLinks = links?.filter((l) => l.status !== "ACTIVE") ?? [];

  return (
    <Panel span={12}>
      <PanelHead title="Vendor Relationships" description="This Partner's current Vendor (if any), plus its historical relationships below - never more than one active at a time." />
      <PanelBody>
        {loading ? (
          <Skeleton lines={3} />
        ) : error ? (
          <div className="banner" role="alert">
            {error}
          </div>
        ) : !links || links.length === 0 ? (
          <EmptyState title="No Vendor relationships yet" description="Vendor relationships for this Partner will appear here once linked from the Vendor's own Relationships tab." icon="brief" />
        ) : (
          <>
            {activeLink ? (
              <LinkRow link={activeLink} />
            ) : (
              <EmptyState title="No active Vendor" description="This Partner currently has no active Vendor - representation and payments, if any, are handled directly." icon="brief" />
            )}
            {historicalLinks.length > 0 && (
              <>
                <p className="foundationnote" style={{ margin: "16px 0 10px" }}>
                  Historical relationships ({historicalLinks.length})
                </p>
                {historicalLinks.map((link) => (
                  <LinkRow key={link.vendorPartnerLinkRef} link={link} />
                ))}
              </>
            )}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

function LinkRow({ link }: { link: PartnerVendorLinkDto }) {
  return (
    <div className="record" style={{ marginBottom: 10 }}>
      <div className="recordmeta" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <b>{link.vendor.displayName}</b>
          <Pill tone={linkStatusTone(link.status)}> {LINK_STATUS_LABELS[link.status]}</Pill>
          <Pill tone="default"> {RELATIONSHIP_TYPE_LABELS[link.relationshipType]}</Pill>
          {link.payeeRole && <Pill tone="default"> Payee</Pill>}
          <div>
            <small>{VENDOR_TYPE_LABELS[link.vendor.vendorType]}</small>
          </div>
          <div>
            <small>
              Effective {effectiveDateLabel(link.effectiveFrom)}
              {link.effectiveTo ? ` – ${effectiveDateLabel(link.effectiveTo)}` : " – ongoing"}
            </small>
          </div>
        </div>
        {link.canOpenVendor && (
          <Link href={`/vendors/${link.vendor.vendorRef}`} className="btn">
            Open Vendor
          </Link>
        )}
      </div>
    </div>
  );
}
