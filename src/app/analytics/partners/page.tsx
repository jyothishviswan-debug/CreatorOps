import { PartnersAnalyticsPage } from "@/features/analytics/PartnersAnalyticsPage";

// Step 12F: thin wrapper - the whole page is the one shared PartnersAnalyticsPage.
// The search params are handed over RAW (any of them may be repeated -> string[]):
// the trusted service parses and bounds every value server-side.
type SearchParams = { partners?: string | string[]; month?: string | string[]; platform?: string | string[]; targetAudience?: string | string[]; region?: string | string[]; metric?: string | string[] };

export default async function PartnersAnalyticsRoute({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return <PartnersAnalyticsPage params={params} />;
}
