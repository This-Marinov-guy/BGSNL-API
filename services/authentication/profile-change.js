import { createHmac, randomBytes, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { hashPassword as createPasswordHash, validNewPassword, PASSWORD_MESSAGE } from "./passwords.js";
import ProfileChange from "../../models/ProfileChange.js";
import AccountIdentity from "../../models/AccountIdentity.js";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import HttpError from "../../models/Http-error.js";
import { findUserById, normalizeEmail } from "../main-services/user-service.js";
import { sendEmail } from "../background-services/email-provider.js";
import { NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME } from "../../util/config/defines.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";

export const PROFILE_CHANGE_TTL = 60 * 60 * 1000;
const invalid = () => new HttpError("This confirmation link expired, was already used, or your account changed. Please request the change again from your profile.", 409);
const digest = (value) => {
  if (!process.env.JWT_STRING) throw new Error("Authentication secret is missing");
  return createHmac("sha256", process.env.JWT_STRING).update(`profile-change:${value}`).digest("hex");
};
const random = () => randomBytes(32).toString("base64url");
export const validProfileOrigin = (origin) => ["https://www.bulgariansociety.nl", "https://bulgariansociety.nl"].includes(origin) ||
  (process.env.NODE_ENV !== "production" && process.env.APP_ENV !== "prod" && /^http:\/\/(localhost|127\.0\.0\.1):300[0-2]$/.test(origin || ""));
const fence = (user, version) => ({ _id: user.id, ...CURRENT_ACCOUNT_FILTER, email: user.email, password: user.password,
  ...(version === 0 ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] } : { sessionVersion: version }),
});
const safe = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function profileChangeEmail(record, token, stage) {
  const url = `${record.origin}/account/confirm#token=${token}`;
  const email = stage === "owner" ? record.oldEmail : record.newEmail;
  const description = stage === "owner"
    ? `A change to your BGSNL ${[record.newEmail ? "email address" : "", record.passwordHash ? "password" : ""].filter(Boolean).join(" and ")} was requested. ${record.newEmail ? `New email: ${record.newEmail}. ` : ""}Approve only if you requested this. Your account will not change until all required confirmations are complete.`
    : "Confirm that this is your new BGSNL email address. The account owner has already approved the change.";
  return { from: { email: NO_REPLY_EMAIL, name: NO_REPLY_EMAIL_NAME }, to: [{ email }],
    subject: stage === "owner" ? "Confirm your BGSNL profile change" : "Verify your new BGSNL email address",
    text: `${description}\n\n${url}\n\nThis link expires within one hour. If you did not request this, do not approve it and contact support.`,
    html: `<p>${safe(description)}</p><p><a href="${safe(url)}">${stage === "owner" ? "Review and approve change" : "Verify new email"}</a></p><p>This link expires within one hour. If you did not request this, do not approve it and contact support.</p>`,
  };
}

async function availableEmail(email, accountId, session) {
  if (!email) return;
  for (const Model of [User, AlumniUser]) {
    const other = await Model.findOne({ ...CURRENT_ACCOUNT_FILTER, email }).session(session);
    if (other && other.id !== accountId) throw new HttpError("That email is already used by another account. Please request a different email from your profile.", 409);
  }
}

export async function requestProfileChange(user, { email, password, origin, claims }, {
  records = ProfileChange, startSession = () => mongoose.startSession(), deliver = sendEmail,
  hashPassword = createPasswordHash, now = Date.now, checkEmail = availableEmail,
} = {}) {
  const newEmail = normalizeEmail(email || user.email) !== normalizeEmail(user.email) ? normalizeEmail(email) : undefined;
  if (!newEmail && !password) return null;
  if (!validProfileOrigin(origin) || !claims || claims.userId !== user.id || claims.sessionVersion !== Number(user.sessionVersion ?? 0)) throw invalid();
  if (newEmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) || newEmail.length > 254)) throw new HttpError("Please provide a valid email address.", 422);
  if (password && !validNewPassword(password)) throw new HttpError(PASSWORD_MESSAGE, 422);
  const token = random(), generation = randomUUID();
  const record = { generation, accountId: user.id, oldEmail: user.email, newEmail,
    passwordHash: password ? await hashPassword(password) : undefined,
    passwordDigest: digest(user.password), sessionVersion: Number(user.sessionVersion ?? 0), authTime: claims.auth_time,
    origin, stage: "owner", approvalHash: digest(token), expiresAt: new Date(now() + PROFILE_CHANGE_TTL) };
  for (const key of Object.keys(record)) if (record[key] === undefined) delete record[key];
  const session = await startSession();
  try {
    await session.withTransaction(async () => {
      if (!await user.constructor.findOneAndUpdate(fence(user, record.sessionVersion), { $inc: { identityRevision: 1 } }, { new: true, session })) throw invalid();
      await checkEmail(newEmail, user.id, session);
      await records.findOneAndUpdate({ _id: user.id }, { $set: record, $unset: { newEmailHash: 1,
        ...(!newEmail ? { newEmail: 1 } : {}), ...(!password ? { passwordHash: 1 } : {}) } }, { upsert: true, new: true, session });
    });
  } finally { await session.endSession(); }
  try { await deliver(profileChangeEmail(record, token, "owner")); }
  catch {
    await records.deleteOne({ _id: user.id, generation });
    throw new HttpError("We could not send the confirmation email. Your email and password have not changed. Please try again.", 503);
  }
  return { confirmationRequired: true, message: "Your profile details were saved. Check your current email to approve the email or password change. Your sign-in details stay unchanged until confirmed." };
}

export async function confirmProfileChange(token, {
  records = ProfileChange, identities = AccountIdentity, startSession = () => mongoose.startSession(),
  findAccount = findUserById, deliver = sendEmail, checkEmail = availableEmail, now = Date.now,
} = {}) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  const hash = digest(token);
  const record = await records.findOne({ expiresAt: { $gt: new Date(now()) }, $or: [{ approvalHash: hash, stage: "owner" }, { newEmailHash: hash, stage: "new_email" }] });
  if (!record) throw invalid();
  const user = await findAccount(record.accountId);
  if (!user || user.id !== record.accountId || user.email !== record.oldEmail || digest(user.password) !== record.passwordDigest ||
      Number(user.sessionVersion ?? 0) !== record.sessionVersion) throw invalid();
  const awaitingNewEmail = record.stage === "owner" && !!record.newEmail;
  const nextToken = awaitingNewEmail ? random() : undefined;
  const query = { _id: record._id, generation: record.generation, stage: record.stage, expiresAt: { $gt: new Date(now()) },
    [record.stage === "owner" ? "approvalHash" : "newEmailHash"]: hash };
  const session = await startSession();
  let updated;
  try {
    await session.withTransaction(async () => {
      query.expiresAt = { $gt: new Date(now()) };
      await checkEmail(record.newEmail, user.id, session);
      if (awaitingNewEmail) {
        if (!await user.constructor.findOneAndUpdate(fence(user, record.sessionVersion), { $inc: { identityRevision: 1 } }, { new: true, session })) throw invalid();
        if (!await records.findOneAndUpdate(query, { $set: { stage: "new_email", newEmailHash: digest(nextToken) }, $unset: { approvalHash: 1 } }, { new: true, session })) throw invalid();
      } else {
        if (!await records.findOneAndDelete(query, { session })) throw invalid();
        updated = await user.constructor.findOneAndUpdate(fence(user, record.sessionVersion), {
          $set: { ...(record.newEmail ? { email: record.newEmail } : {}), ...(record.passwordHash ? { password: record.passwordHash } : {}) },
          $inc: { sessionVersion: 1, identityRevision: 1 },
        }, { new: true, session });
        if (!updated) throw invalid();
        // An old Google address must not remain a login method for a new email.
        if (record.newEmail) await identities.deleteMany({ accountId: user.id, provider: "google" }, { session });
      }
    });
  } finally { await session.endSession(); }
  if (awaitingNewEmail) {
    try { await deliver(profileChangeEmail(record, nextToken, "new_email")); }
    catch {
      await records.deleteOne({ _id: record._id, generation: record.generation });
      throw new HttpError("The new-address verification email could not be sent. Your sign-in details have not changed. Please request the change again.", 503);
    }
    return { state: "awaiting_new_email", message: "Change approved. Please confirm the email sent to your new address to finish. Your sign-in details have not changed yet." };
  }
  // Notification failures must not claim that an already-committed change failed.
  const notification = { from: { email: NO_REPLY_EMAIL, name: NO_REPLY_EMAIL_NAME },
    subject: "Your BGSNL sign-in details were changed", text: "Your confirmed profile change is complete. Previous sessions were signed out. If this was not you, contact BGSNL support immediately." };
  await Promise.all([...new Set([record.oldEmail, record.newEmail].filter(Boolean))].map((email) =>
    deliver({ ...notification, to: [{ email }] }).catch(() => { console.error("Profile change notification delivery failed"); })));
  return { state: "complete", user: updated, authTime: record.authTime, previousVersion: record.sessionVersion,
    message: `Your profile change is confirmed. Other sessions have been signed out.${record.newEmail ? " Reconnect Google in Settings if you want to use your new Google address." : ""}` };
}
