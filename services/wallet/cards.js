import WalletCard from "../../models/WalletCard.js";
import { findUserById } from "../main-services/user-service.js";
import { reconcileAccount } from "../subscriptions/reconcile.js";
import { cardOwner, createCardToken, validCardToken, publicCard, publicTicketImages, walletEligible, cardUrl } from "./policy.js";

export function createWalletCards({ records = WalletCard, findAccount = findUserById, reconcile = reconcileAccount } = {}) {
  const ownerQuery = (account) => ({ $or: [{ _id: cardOwner(account) },
    { accountId: { $in: [String(account.id || account._id), ...(account.accountAliases || [])] } }] });
  const recordFor = (account) => records.findOne(ownerQuery(account));
  async function packet(account, record) {
    if (!record || record.revokedAt || !walletEligible(account)) return null;
    const fresh = account.subscription?.syncedAt && Date.now() - new Date(account.subscription.syncedAt).getTime() < 60000;
    const latest = fresh ? { user: account } : await reconcile(account);
    if (account.subscription?.id && !latest?.user) throw new Error("Membership verification unavailable");
    const currentAccount = latest?.user || account;
    const card = publicCard(currentAccount);
    return card ? { card, ticketImages: publicTicketImages(currentAccount), token: record.token, publicUrl: cardUrl(record.token) } : null;
  }
  return {
    async own(account) {
      if (!walletEligible(account)) return null;
      return packet(account, await recordFor(account));
    },
    async create(account) {
      if (!walletEligible(account)) return null;
      await records.init();
      const id = (await recordFor(account))?._id || cardOwner(account);
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          let record = await records.findOneAndUpdate({ _id: id }, { $setOnInsert: {
            accountId: String(account.id || account._id), token: createCardToken(), provisionedAutomatically: true,
          } }, { upsert: true, new: true });
          if (record.revokedAt) record = await records.findOneAndUpdate({ _id: id, revokedAt: record.revokedAt }, {
            $set: { token: createCardToken(), revokedAt: null },
          }, { new: true }) || await recordFor(account);
          return packet(account, record);
        } catch (error) { if (error.code !== 11000 || attempt === 3) throw error; }
      }
      return null;
    },
    async revoke(account) {
      await records.updateMany({ ...ownerQuery(account), revokedAt: null }, { $set: { revokedAt: new Date() } });
    },
    async public(token) {
      if (!validCardToken(token)) return null;
      const record = await records.findOne({ token, revokedAt: null });
      if (!record) return null;
      return packet(await findAccount(record.accountId), record);
    },
  };
}
export const walletCards = createWalletCards();
