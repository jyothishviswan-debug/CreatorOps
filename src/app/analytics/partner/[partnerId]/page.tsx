import { PartnerAnalyticsPage } from "@/features/analytics/PartnerAnalyticsPage";

// Step 12E: thin wrapper - the whole view is the one shared PartnerAnalyticsPage.
// `partnerId` is the canonical partnerRef (same convention as /partners/[partnerId]);
// `platform` is handed over RAW (it may be repeated -> string[]) and parsed
// server-side by the service (parsePartnerViewSelection): only instagram|youtube
// are ever honored, anything else is All.
export default async function PartnerAnalyticsRoute({ params, searchParams }: { params: Promise<{ partnerId: string }>; searchParams: Promise<{ platform?: string | string[] }> }) {
  const { partnerId } = await params;
  const { platform } = await searchParams;
  return <PartnerAnalyticsPage partnerId={partnerId} platform={platform} />;
}
