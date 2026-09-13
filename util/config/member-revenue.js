// These accounts were read from the central BGSNL Connect platform. Keep account
// IDs used by existing allocations when adding/replacing future region routes.
export const MEMBER_REVENUE_PLATFORM = "acct_1QLOPaAShinXgMFZ";
export const MEMBER_REVENUE_ACCOUNTS = Object.freeze({
  amsterdam: "acct_1UDN8vAsNA3SVv1m",
  groningen: "acct_1UDNdQPLbBQEXyV6",
  leeuwarden: "acct_1UDNAJPRZxbCvsET",
  leiden_hague: "acct_1UDNCEAgrqHPcNaG",
  rotterdam: "acct_1UDNCjPNvWZqP4Cu",
});
export const memberRevenueEnabled = (env = process.env) => env.MEMBER_REVENUE_SHARING_ENABLED === "true";
export const memberRevenueLiveMode = (env = process.env) => env.MEMBER_REVENUE_SHARING_LIVEMODE !== "false";
export const memberRevenueAllocation = (plan, region, env = process.env) => {
  if (!memberRevenueEnabled(env) || plan?.type !== "member" || !Object.hasOwn(MEMBER_REVENUE_ACCOUNTS, region)) return null;
  return { version: 1, accountId: MEMBER_REVENUE_ACCOUNTS[region], region, platformPercent: 20, livemode: memberRevenueLiveMode(env) };
};
export const validMemberRevenueAllocation = (value) => value?.version === 1 && value.platformPercent === 20 &&
  typeof value.livemode === "boolean" && Object.hasOwn(MEMBER_REVENUE_ACCOUNTS, value.region) && MEMBER_REVENUE_ACCOUNTS[value.region] === value.accountId;
