import { randomBytes } from "node:crypto";
import { accountEntitlements } from "../../util/subscriptions/policy.js";
import { normalizeRoleNames } from "../../util/config/account-roles.js";

export const WALLET_ORIGIN = "https://bulgariansociety.nl";
export const validCardToken = (token) => typeof token === "string" && /^[A-Za-z0-9_-]{22}$/.test(token);
export const createCardToken = () => randomBytes(16).toString("base64url");
export const cardUrl = (token) => {
  if (!validCardToken(token)) throw new Error("Invalid card token");
  return `${WALLET_ORIGIN}/c/${token}`;
};
export const walletEligible = (account) => !!account && ["active", "locked", "payment_awaiting"].includes(account.status);
export const cardOwner = (account) => [...new Set([String(account.id || account._id), ...(account.accountAliases || [])])]
  .map((id) => id.replace(/^(member|alumni)_/, "")).sort()[0];

const regions = { amsterdam: "Amsterdam", breda_tilburg: "Breda / Tilburg", eindhoven: "Eindhoven", groningen: "Groningen",
  leeuwarden: "Leeuwarden", maastricht: "Maastricht", rotterdam: "Rotterdam", leiden_hague: "Leiden / The Hague", netherlands: "Netherlands" };
const CARD_ROLE_PRIORITY = [
  ["national_board_member", "National Board Member", false],
  ["regional_board_member", "Board Member", true],
  ["national_committee_member", "National Committee Member", false],
  ["regional_committee_member", "Committee Member", true],
];

export function membershipLabel(account, region) {
  const alumni = account.roles?.includes("alumni");
  const base = alumni ? `Alumni Tier ${["0", "I", "II", "III", "IV"][account.tier] || "0"}` : `Member of ${region}`;
  const roles = normalizeRoleNames(account.roles);
  const leadership = CARD_ROLE_PRIORITY.find(([role]) => roles.includes(role));
  if (!leadership) return base;
  const [, title, regional] = leadership;
  const roleLabel = regional ? `${title} of ${region}` : title;
  return alumni ? `${base} & ${roleLabel}` : roleLabel;
}

export function publicCard(account, now = Date.now()) {
  if (!walletEligible(account)) return null;
  const alumni = account.roles?.includes("alumni");
  const region = regions[account.region] || "Netherlands";
  const active = account.status === "active" && ((alumni && account.tier === 0) || accountEntitlements(account, now).hasBenefits);
  let profileImage = "/assets/images/avatars/bg_other_avatar_1.jpeg";
  try {
    const image = new URL(account.image);
    if (image.protocol === "https:" && !image.username && !image.password) profileImage = image.href;
  } catch { /* Keep the local fallback. */ }
  return { firstName: String(account.name || ""), surname: String(account.surname || ""), profileImage, region,
    membershipLabel: membershipLabel(account, region),
    status: active ? "active" : "locked" };
}

export function publicTicketImages(account, now = Date.now()) {
  if (!walletEligible(account) || !accountEntitlements(account, now).hasBenefits) return [];
  return (Array.isArray(account.tickets) ? account.tickets : []).flatMap((ticket) => {
    try {
      const image = new URL(ticket.image);
      return image.protocol === "https:" && !image.username && !image.password ? [image.href] : [];
    } catch { return []; }
  });
}
