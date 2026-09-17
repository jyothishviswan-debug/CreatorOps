"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { PartnerVendorLinkDto } from "@/server/vendors/client-dto";
import { listVendorLinksForPartner } from "@/features/vendors/api-client";
import { effectiveDateLabel, LINK_STATUS_LABELS, linkStatusTone, RELATIONSHIP_TYPE_LABELS, VENDOR_TYPE_LABELS } from "@/features/vendors/format";

// Step 8B section 7: the real Partner-side Vendor relationship slice,
// replacing the earlier truthful "Vendors unavailable" placeholder now
// that Vendors is accepted. Gated ENTIRELY by this Partner's own scope
// (via /api/partners/[partnerRef]/vendor-links - see
// listVendorLinksForPartner's own comment) - never Vendor scope. Shows
// only this one Partner's own link rows with a safe minimal Vendor
// label; a direct link to the Vendor's own detail page is only ever
// rendered when the Vendor is ALSO directly reachable (a 401/403 on
// probing it is treated as "not directly reachable", never surfaced as
// an error to the operator - this is an expected, safe outcome, not a
// failure).
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

  return (
    <Panel span={12}>
      <PanelHead title="Vendor Relationships" description="This Partner's own Vendor relationship history - at most one active at a time - never a Vendor's unrelated portfolio." />
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
          links.map((link) => (
            <div className="record" key={link.vendorPartnerLinkRef} style={{ marginBottom: 10 }}>
              <div className="recordmeta" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <b>{link.vendor.displayName}</b>
                  <Pill tone={linkStatusTone(link.status)}> {LINK_STATUS_LABELS[link.status]}</Pill>
                  <Pill tone="default"> {RELATIONSHIP_TYPE_LABELS[link.relationshipType]}</Pill>
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
                <VendorDetailLink vendorRef={link.vendor.vendorRef} />
              </div>
            </div>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}

// Probes direct Vendor access before rendering a link - a Partner-scope
// actor without direct Vendor scope must see the safe relationship row
// with NO active deep link, never a link that 403s when clicked (Step
// 8B section 7's own explicit requirement).
function VendorDetailLink({ vendorRef }: { vendorRef: string }) {
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/vendors/${encodeURIComponent(vendorRef)}`)
      .then((res) => {
        if (!cancelled) setReachable(res.ok);
      })
      .catch(() => {
        if (!cancelled) setReachable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorRef]);

  if (!reachable) return null;
  return (
    <Link href={`/vendors/${vendorRef}`} className="btn">
      Open Vendor
    </Link>
  );
}
