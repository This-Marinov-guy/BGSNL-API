import mongoose from "mongoose";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import { lockAccountCredentials } from "../authentication/embedded-credentials.js";
import { CURRENT_ACCOUNT_FILTER, accountType } from "../../util/subscriptions/policy.js";

export async function findBillingAccount(query, session = null) {
  const [member, alumni] = await Promise.all([User, AlumniUser].map((Model) =>
    Model.findOne({ ...query, ...CURRENT_ACCOUNT_FILTER }).session(session)));
  if (member && alumni && member.subscription?.id === alumni.subscription?.id && member.subscription?.id) {
    throw new Error("Multiple accounts own the same subscription; reconciliation is required");
  }
  return alumni || member;
}

const mergeArray = (previous = [], current = []) => {
  const values = new Map();
  for (const value of [...previous, ...current]) values.set(String(value?._id || JSON.stringify(value)), value);
  return [...values.values()];
};

// Reuse the archived counterpart when changing back. Old account IDs remain
// aliases, so sessions, ticket references and applications continue to resolve.
// Both writes are atomic; only the current profile is retained.
export async function persistSubscriptionAccount(user, fields, plan, assertOwned) {
  const session = await mongoose.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      await assertOwned(session);
      await lockAccountCredentials(session);
      const source = await user.constructor.findById(user._id).select("+identities +passkeys").session(session);
      if (!source || CURRENT_ACCOUNT_FILTER.status.$nin.includes(source.status)) throw new Error("Account changed during billing update");
      const targetType = plan?.type || accountType(source);
      const nextSubscription = fields.subscription || source.subscription?.toObject() || {};
      fields = { ...fields, subscription: { ...nextSubscription,
        connected: targetType === "member" && nextSubscription.connected === true } };
      if (targetType === accountType(source)) {
        source.set(fields);
        if (targetType === "alumni" && plan) source.tier = plan.tier;
        saved = await source.save({ session });
        return;
      }
      const Target = targetType === "alumni" ? AlumniUser : User;
      const aliases = [...new Set([String(source._id), ...(source.accountAliases || [])])];
      const existing = await Target.findOne({ $or: [
        { _id: { $in: aliases } }, { accountAliases: { $in: aliases } }, { email: source.email },
      ] }).session(session);
      if (existing && !CURRENT_ACCOUNT_FILTER.status.$nin.includes(existing.status)) {
        throw new Error("Another active account uses this email; contact support before changing membership");
      }
      const data = { ...(existing?.toObject() || {}), ...source.toObject(), ...fields };
      data._id = existing?._id || aliases.find((id) => id.startsWith(`${targetType}_`)) || String(source._id).replace(/^(member|alumni)_/, `${targetType}_`);
      delete data.__v;
      data.accountAliases = [...new Set([String(source._id), String(data._id),
        ...(source.accountAliases || []), ...(existing?.accountAliases || [])])];
      // Keep administrative assignments; the member discount additionally
      // requires the member programme and a healthy paid subscription.
      data.roles = [...new Set([...(source.roles || []).filter((role) => !["member", "alumni"].includes(role)), targetType])];
      if (targetType === "alumni") data.tier = plan.tier;
      else delete data.tier;
      for (const key of ["tickets", "christmas", "documents", "internshipApplications", "campaignsSeen"]) {
        data[key] = mergeArray(existing?.[key], source[key]);
      }
      for (const key of ["birth", "phone", "region", "university", "course", "studentNumber", "profession", "graduationDate", "otherUniversityName"]) {
        if (!data[key] && existing?.[key]) data[key] = existing[key];
      }
      data.identities = source.identities?.map((item) => item.toObject()) || [];
      data.passkeys = source.passkeys?.map((item) => item.toObject()) || [];
      const target = existing || new Target();
      target.set(data);
      saved = await target.save({ session });
      await source.constructor.deleteOne({ _id: source._id }, { session });
    });
    return saved;
  } finally { await session.endSession(); }
}
