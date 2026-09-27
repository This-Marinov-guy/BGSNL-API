import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import { hashPassword as createPasswordHash } from "./passwords.js";
import PasswordResetChallenge from "../../models/PasswordResetChallenge.js";
import HttpError from "../../models/Http-error.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";

export const RESET_LIFETIME_MS = 15 * 60 * 1000;
export const RESET_ATTEMPTS = 5;
const invalid = () => new HttpError("Invalid or expired code. Please request a new password reset if needed.", 400);
const digest = (purpose, value) => {
  if (!process.env.JWT_STRING) throw new Error("Authentication secret is not configured");
  return createHmac("sha256", process.env.JWT_STRING).update(`password-reset:${purpose}:${value}`).digest("hex");
};
const accountFilter = (user) => ({
  _id: user.id, ...CURRENT_ACCOUNT_FILTER, password: user.password, email: user.email,
  ...(Number(user.sessionVersion ?? 0) === 0
    ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] }
    : { sessionVersion: Number(user.sessionVersion) }),
});
const challengeFilter = (user, now) => ({
  _id: user.id, passwordDigest: digest("password", user.password), email: user.email,
  expiresAt: { $gt: new Date(now()) },
});

export async function issuePasswordReset(user, {
  challenges = PasswordResetChallenge, startSession = () => mongoose.startSession(), now = Date.now,
} = {}) {
  const code = String(randomInt(100000, 1000000));
  const session = await startSession();
  try {
    await session.withTransaction(async () => {
      // Fence concurrent migration, password/identity changes and reset issuance.
      const account = await user.constructor.findOneAndUpdate(accountFilter(user),
        { $inc: { identityRevision: 1 } }, { new: true, session });
      if (!account) throw invalid();
      await challenges.findOneAndUpdate({ _id: user.id }, { $set: {
        generation: randomUUID(), codeHash: digest(user.id, code),
        passwordDigest: digest("password", user.password), email: user.email,
        attemptsLeft: RESET_ATTEMPTS, expiresAt: new Date(now() + RESET_LIFETIME_MS),
      } }, { upsert: true, new: true, session });
    });
  } finally { await session.endSession(); }
  return code;
}

async function attempt(user, code, challenges, now) {
  if (!user || !/^\d{6}$/.test(String(code ?? ""))) throw invalid();
  // Count attempts here, including requests sent directly to /change-password.
  const challenge = await challenges.findOneAndUpdate({ ...challengeFilter(user, now), attemptsLeft: { $gt: 0 } },
    { $inc: { attemptsLeft: -1 } }, { new: true });
  const expected = Buffer.from(challenge?.codeHash || "", "hex");
  const provided = Buffer.from(digest(user.id, String(code)), "hex");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw invalid();
  return challenge;
}

export async function verifyPasswordReset(user, code, { challenges = PasswordResetChallenge, now = Date.now } = {}) {
  await attempt(user, code, challenges, now);
}

export async function completePasswordReset(user, code, password, {
  challenges = PasswordResetChallenge, startSession = () => mongoose.startSession(),
  hashPassword = createPasswordHash, now = Date.now,
} = {}) {
  const challenge = await attempt(user, code, challenges, now);
  const hashedPassword = await hashPassword(password);
  const session = await startSession();
  try {
    await session.withTransaction(async () => {
      const consumed = await challenges.findOneAndDelete({ ...challengeFilter(user, now), generation: challenge.generation }, { session });
      if (!consumed) throw invalid();
      const account = await user.constructor.findOneAndUpdate(accountFilter(user), {
        $set: { password: hashedPassword }, $inc: { sessionVersion: 1, identityRevision: 1 },
      }, { new: true, session });
      if (!account) throw invalid();
    });
  } finally { await session.endSession(); }
}
