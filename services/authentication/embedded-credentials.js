import { randomUUID } from "node:crypto";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import TemporaryCode from "../../models/TemporaryCode.js";
import HttpError from "../../models/Http-error.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";

// Mongo unique indexes apply to one collection. Every credential acquisition
// and member/alumni move writes this same document FIRST in its transaction,
// forcing concurrent ownership checks to retry against a fresh snapshot.
// No expiresAt: this is a permanent mutex, not an expiring rate-limit bucket.
export async function lockAccountCredentials(session) {
  if (!session?.inTransaction()) throw new Error("Credential ownership requires a transaction");
  await TemporaryCode.collection.updateOne({ _id: "coordination:account-credentials" },
    { $inc: { revision: 1 }, $set: { expiresAt: new Date(Date.now() + 86400000) } }, { upsert: true, session });
}

const conflict = () => new HttpError("Your account or sign-in method changed. Please try again.", 409);
const duplicate = () => Object.assign(new Error("Credential already belongs to an account"), { code: 11000 });
const queryResult = (run) => ({ session: (session) => run(session), then: (resolve, reject) => run(null).then(resolve, reject) });
const plain = (item) => ({ ...(item.toObject ? item.toObject() : item),
  ...(item.publicKey ? { publicKey: Buffer.from(item.publicKey) } : {}) });
const matches = (item, query) => Object.entries(query).every(([key, value]) => key === "accountId" || item[key] === value);

// This repository exposes the small operations used by the authentication
// service, but stores every credential inside its owning account document.
// No mongoose model or separate identity/passkey collection is registered.
export function embeddedCredentialStore(field, { models = [User, AlumniUser] } = {}) {
  if (!["identities", "passkeys"].includes(field)) throw new Error("Unknown credential field");
  function accountQuery(query) {
    const { accountId, ...credential } = query;
    return { ...CURRENT_ACCOUNT_FILTER, ...(accountId ? { _id: accountId } : {}),
      ...(Object.keys(credential).length ? { [field]: { $elemMatch: credential } } : {}) };
  }
  async function accounts(query, session) {
    const found = [];
    // Do not parallelize operations in a Mongo transaction.
    for (const Model of models) {
      const account = await Model.findOne(accountQuery(query)).select(`+${field}`).session(session);
      if (account) found.push(account);
    }
    if (found.length > 1) throw conflict(); // Ambiguous owners fail closed.
    return found;
  }
  async function rows(query, session) {
    return (await accounts(query, session)).flatMap((account) => (account[field] || [])
      .map((item) => ({ ...plain(item), accountId: String(account._id) })).filter((item) => matches(item, query)));
  }
  async function mutate(query, update, session) {
    if (!session?.inTransaction()) throw new Error("Credential mutation requires a transaction");
    const [account] = await accounts(query, session);
    if (!account) return null;
    return account.constructor.findOneAndUpdate({ ...accountQuery(query), _id: account._id }, update,
      { new: true, session, runValidators: true }).select(`+${field}`);
  }
  const store = {
    find: (query) => queryResult((session) => rows(query, session)),
    findOne: (query) => queryResult(async (session) => (await rows(query, session))[0] || null),
    exists: (query) => queryResult(async (session) => (await rows(query, session)).length > 0),
    countDocuments: (query) => queryResult(async (session) => (await rows(query, session)).length),
    async create(items, { session } = {}) {
      const saved = [];
      for (const item of items) {
        const { accountId, ...data } = item;
        data._id ||= randomUUID();
        const ownerKey = field === "identities" ? { provider: data.provider, subject: data.subject } : { _id: data._id };
        if (await store.exists(ownerKey).session(session)) throw duplicate();
        const [owner] = await accounts({ accountId }, session);
        if (!owner) throw conflict();
        if (field === "identities" && owner.identities?.some((identity) => identity.provider === data.provider)) throw duplicate();
        if (field === "passkeys" && owner.passkeys?.filter((key) => key.rpId === data.rpId).length >= 10) throw conflict();
        const now = new Date();
        const entry = { ...data, ...(field === "passkeys" ? { revision: 0 } : {}), createdAt: data.createdAt || now, updatedAt: now };
        if (!await mutate({ accountId }, { $push: { [field]: entry } }, session)) throw conflict();
        saved.push({ ...entry, accountId });
      }
      return saved;
    },
    async findOneAndUpdate(query, update, { session } = {}) {
      const mapped = {};
      for (const op of ["$set", "$inc"]) {
        if (update[op]) mapped[op] = Object.fromEntries(Object.entries(update[op]).map(([key, value]) => [`${field}.$.${key}`, value]));
      }
      mapped.$set = { ...mapped.$set, [`${field}.$.updatedAt`]: new Date() };
      const account = await mutate(query, mapped, session);
      if (!account) return null;
      const item = account[field].find((entry) => String(entry._id) === String(query._id));
      return item ? { ...plain(item), accountId: String(account._id) } : null;
    },
    async updateOne(query, update, options) {
      return { matchedCount: await store.findOneAndUpdate(query, update, options) ? 1 : 0 };
    },
    async deleteOne(query, { session } = {}) {
      const { accountId: _accountId, ...credential } = query;
      return { deletedCount: await mutate(query, { $pull: { [field]: credential } }, session) ? 1 : 0 };
    },
    async deleteMany(query, options) {
      // Google unlink/email changes remove the one provider on one account.
      if (typeof query.accountId !== "string" || query.provider !== "google") throw new Error("An exact identity owner and provider are required");
      return store.deleteOne(query, options);
    },
  };
  return store;
}

export const embeddedIdentities = embeddedCredentialStore("identities");
export const embeddedPasskeys = embeddedCredentialStore("passkeys");
