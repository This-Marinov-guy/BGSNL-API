import { findBillingAccount } from "../subscriptions/accounts.js";
import WalletCard from "../../models/WalletCard.js";
import { walletOwnerQuery } from "../wallet/provision.js";
import { validCardToken } from "../wallet/policy.js";

const objectId = (value) => typeof value === "string" ? value : value?.id;

// Read-only: payment success alone must never imply account readiness.
export async function membershipAccountReady(session, region, {
  findAccount = findBillingAccount, wallets = WalletCard,
} = {}) {
  if (session.metadata?.bgsnlFulfilled !== "1" || session.mode !== "subscription" ||
      !objectId(session.subscription) || !objectId(session.customer)) return false;
  const account = await findAccount({ "subscription.id": objectId(session.subscription),
    "subscription.customerId": objectId(session.customer), "subscription.stripeRegion": region });
  if (!account || !["active", "locked"].includes(account.status) || !account.subscription?.syncedAt) return false;
  const wallet = await wallets.findOne(walletOwnerQuery(account));
  return validCardToken(wallet?.token);
}
