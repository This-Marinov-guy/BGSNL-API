import WalletCard from "../../models/WalletCard.js";
import { cardOwner, createCardToken } from "./policy.js";

export const walletOwnerQuery = (account) => ({ $or: [{ _id: cardOwner(account) },
  { accountId: { $in: [String(account.id || account._id), ...(account.accountAliases || [])] } }] });

// Shared by signup, authenticated recovery and the migration. No billing calls.
// Existing tokens and revocations are deliberately never changed.
export async function ensureWalletRecord(account, records = WalletCard) {
  const accountId = String(account.id || account._id || "");
  if (!/^(member|alumni)_/.test(accountId)) throw new Error("Wallet owner must be a member or alumni account");
  await records.init();
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = await records.findOne(walletOwnerQuery(account));
    if (existing) return existing;
    try {
      return await records.findOneAndUpdate({ _id: cardOwner(account) }, { $setOnInsert: {
        accountId, token: createCardToken(), provisionedAutomatically: true,
      } }, { upsert: true, new: true });
    } catch (error) {
      if (error.code !== 11000 || attempt === 3) throw error;
    }
  }
  return null;
}

export function automaticWalletCard(schema, { provision = ensureWalletRecord } = {}) {
  // Before persistence: a successfully created account already has its token.
  // A failed account save can leave a harmless record: public reads require an account.
  schema.pre("save", async function () {
    if (this.isNew) await provision(this);
  });
  schema.pre("insertMany", function (next, accounts) {
    for (const account of accounts) if (!account._id) account._id = new this()._id;
    Promise.all(accounts.map((account) => provision(account))).then(() => next(), next);
  });
}
