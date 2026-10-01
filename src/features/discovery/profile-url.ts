// Step 18-21: relocated to @/server/shared/account-identity (a
// domain-neutral, crypto-free file Discovery/Partner Accounts/Analytics
// all now share) - re-exported under its original name/location here so
// every existing caller (DiscoveryLeadForm.tsx, PartnerForm.tsx,
// profile-url.test.ts) is unaffected.
export { deriveFromProfileUrl } from "@/server/shared/account-identity";
