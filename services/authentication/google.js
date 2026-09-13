import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { verifyPassword } from "./passwords.js";
import { google } from "googleapis";
import HttpError from "../../models/Http-error.js";
import { embeddedIdentities as AccountIdentity } from "../../services/authentication/embedded-credentials.js";
import { lockAccountCredentials } from "./embedded-credentials.js";
import AuthChallenge from "../../models/AuthChallenge.js";
import { redisRateLimits as AuthRateLimit } from "../../services/storage/rate-limits.js";
import { findUserById } from "../main-services/user-service.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
export const CHALLENGE_LIFETIME_MS = 5 * 60000;

export const googleClientId = () => process.env.GOOGLE_SIGN_IN_CLIENT_ID?.trim() || null;
const normalizeEmail = (email) => typeof email === "string" ? email.trim().toLowerCase() : "";
// Match the actual address, not Gmail dot/plus aliases or Workspace domains.
export const isGoogleLinkEligible = (email) => /^[^\s@]+@gmail\.com$/.test(normalizeEmail(email));
export function requireMatchingGoogleEmail(user, identity) {
  if (!isGoogleLinkEligible(user?.email)) {
    throw new HttpError("Google connection is only available for BGSNL accounts with a Gmail address (@gmail.com). Please use your BGSNL password.", 403);
  }
  if (normalizeEmail(identity?.email) !== normalizeEmail(user.email)) {
    throw new HttpError("Use the Google account with the same email address as your BGSNL account. A different Google account cannot be connected.", 403);
  }
}

export function googleConnectionStatus(user, identity = null) {
  return { enabled: !!googleClientId(), eligible: isGoogleLinkEligible(user.email),
    accountEmail: user.email, connected: !!identity, email: identity?.email || null };
}

export function requireGoogleOrigin(req, _res, next) {
  const origin = req.headers.origin;
  const origins = ["https://bulgariansociety.nl", "https://www.bulgariansociety.nl"];
  if (process.env.NODE_ENV !== "production") for (const host of ["localhost", "127.0.0.1"]) {
    for (const port of [3000, 3001, 3002]) origins.push(`http://${host}:${port}`);
  }
  if (!origins.includes(origin) || !req.is("application/json")) return next(new HttpError("Invalid sign-in request origin or content type", 403));
  return next();
}

export async function limitGoogleRequests(key, maximum = 30, { limits = AuthRateLimit, now = Date.now() } = {}) {
  const windowMs = 15 * 60000;
  const bucket = Math.floor(now / windowMs);
  const id = `google:${digest(key)}:${bucket}`;
  let count;
  try {
    count = await limits.findOneAndUpdate({ _id: id }, {
      $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) },
    }, { upsert: true, new: true });
  } catch (error) {
    // Concurrent first requests can race the unique _id insert.
    if (error.code !== 11000) throw error;
    count = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true });
  }
  if (!count || count.count > maximum) throw new HttpError("Too many sign-in attempts. Please try again in 15 minutes.", 429);
}

export async function verifyCurrentPassword(user, password, compare = verifyPassword) {
  const validInput = typeof password === "string" && password.length > 0 && password.length <= 256;
  // Google/passkey reauthentication uses the same padded verifier, even when
  // the account has no usable password. Never skip work based on stored state.
  const matches = await compare(validInput ? password : undefined, user?.password);
  if (!validInput || !user?.password || !matches) {
    throw new HttpError("Please confirm your current BGSNL password.", 403);
  }
}

export async function createGoogleChallenge({ purpose, origin, proof, user, password }, { challenges = AuthChallenge, verifyPassword = verifyCurrentPassword } = {}) {
  const clientId = googleClientId();
  if (!clientId) throw new HttpError("Google sign-in has not been enabled yet. Please use your password.", 503);
  if (!["login", "link"].includes(purpose) || !/^[a-zA-Z0-9_-]{43,128}$/.test(proof || "")) throw new HttpError("Invalid sign-in challenge", 422);
  if (purpose === "link") {
    requireMatchingGoogleEmail(user, user);
    await verifyPassword(user, password);
  }
  const challenge = await challenges.create({
    _id: random(), nonce: random(), proofHash: digest(proof), origin, purpose,
    ...(purpose === "link" ? { accountId: user.id, accountEmail: normalizeEmail(user.email), passwordHash: digest(user.password), sessionVersion: Number(user.sessionVersion ?? 0) } : {}),
    expiresAt: new Date(Date.now() + CHALLENGE_LIFETIME_MS),
  });
  return { challengeId: challenge._id, nonce: challenge.nonce, clientId, expiresAt: challenge.expiresAt,
    ...(purpose === "link" ? { loginHint: challenge.accountEmail } : {}) };
}

let verifier;
let verifierClientId;
export async function verifyGoogleCredential(credential, nonce) {
  const clientId = googleClientId();
  if (!clientId) throw new HttpError("Google sign-in has not been enabled yet.", 503);
  if (!verifier || verifierClientId !== clientId) {
    verifier = new google.auth.OAuth2({ clientId, transporterOptions: { timeout: 10000, retry: false } });
    verifierClientId = clientId;
  }
  let payload;
  try {
    const ticket = await verifier.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch (error) {
    if (["ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(error.code) || error.response?.status >= 500) {
      throw new HttpError("Google verification is temporarily unavailable. Please try again.", 503);
    }
    throw new HttpError("Google sign-in could not be verified. Please try again.", 401);
  }
  return validateGooglePayload(payload, nonce, clientId);
}

// Signature verification is performed by Google's library before this policy.
export function validateGooglePayload(payload, nonce, clientId, now = Date.now()) {
  if (!payload || payload.aud !== clientId || (payload.azp && payload.azp !== clientId) ||
      !["accounts.google.com", "https://accounts.google.com"].includes(payload.iss) ||
      typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255 ||
      payload.email_verified !== true || typeof payload.email !== "string" || !payload.email.includes("@") ||
      payload.nonce !== nonce || !nonce || !(payload.exp * 1000 > now) ||
      !(payload.iat * 1000 <= now + 30000)) throw new HttpError("Google sign-in could not be verified. Please try again.", 401);
  return { subject: payload.sub, email: payload.email };
}

export async function consumeGoogleChallenge({ challengeId, credential, proof, purpose, origin, user }, {
  challenges = AuthChallenge, verify = verifyGoogleCredential, findAccount = findUserById,
} = {}) {
  if (typeof proof !== "string" || !/^[a-zA-Z0-9_-]{43,128}$/.test(proof)) throw new HttpError("Invalid sign-in challenge", 422);
  const query = { kind: { $ne: "passkey" }, _id: challengeId, purpose, origin, proofHash: digest(proof), expiresAt: { $gt: new Date() } };
  const challenge = await challenges.findOne(query);
  if (!challenge) throw new HttpError("This Google sign-in request expired or was already used. Please start again.", 409);
  if (purpose === "link") {
    const owner = await findAccount(challenge.accountId);
    if (!user || owner?.id !== user.id || challenge.passwordHash !== digest(user.password) ||
        Number(challenge.sessionVersion ?? 0) !== Number(user.sessionVersion ?? 0) ||
        challenge.accountEmail !== normalizeEmail(owner.email) || challenge.accountEmail !== normalizeEmail(user.email)) {
      throw new HttpError("Your account changed. Please start linking again.", 409);
    }
    requireMatchingGoogleEmail(owner, user);
  }
  const identity = await verify(credential, challenge.nonce);
  if (!await challenges.findOneAndDelete(query)) throw new HttpError("This Google sign-in request was already used. Please start again.", 409);
  if (purpose === "link") requireMatchingGoogleEmail(user, identity);
  return identity;
}

export async function findGoogleAccount(verifiedIdentity, { identities = AccountIdentity, findAccount = findUserById } = {}) {
  const { subject } = verifiedIdentity;
  const identity = await identities.findOne({ provider: "google", subject });
  const user = identity ? await findAccount(identity.accountId) : null;
  // Never auto-link by email or create a member account from a Google token.
  if (!user) throw new HttpError("This Google account is not connected. Sign in with your BGSNL password and connect Google in Settings first.", 403);
  // Existing connections cannot bypass the same-address policy on later logins.
  requireMatchingGoogleEmail(user, verifiedIdentity);
  if (!await identities.exists({ _id: identity._id, provider: "google", subject })) {
    throw new HttpError("Google was disconnected during sign-in. Please use your BGSNL password.", 401);
  }
  return user;
}

export async function changeGoogleIdentity(user, identity = null, { identities = AccountIdentity, lock = lockAccountCredentials, startSession = () => mongoose.startSession() } = {}) {
  if (identity) requireMatchingGoogleEmail(user, identity);
  const session = await startSession();
  let account;
  try {
    await session.withTransaction(async () => {
      await lock(session);
      // Writing the source profile fences simultaneous member/alumni migration,
      // password changes and identity changes in the same database transaction.
      const sessionVersion = Number(user.sessionVersion ?? 0);
      const versionFilter = sessionVersion === 0 ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] } : { sessionVersion };
      account = await user.constructor.findOneAndUpdate({ _id: user.id, password: user.password, ...CURRENT_ACCOUNT_FILTER, ...versionFilter }, {
        $inc: { identityRevision: 1, ...(!identity ? { sessionVersion: 1 } : {}) },
      }, { new: true, session });
      if (!account) throw new HttpError("Your account changed. Please try again.", 409);
      // Check the fresh, transaction-fenced profile in case its email changed.
      if (identity) requireMatchingGoogleEmail(account, identity);
      const existing = await identities.findOne({ provider: "google", accountId: account.id }).session(session);
      if (!identity) {
        if (existing) await identities.deleteOne({ _id: existing._id, accountId: account.id }, { session });
        return;
      }
      if (existing && existing.subject !== identity.subject) throw new HttpError("Disconnect your current Google account before connecting a different one.", 409);
      const owner = await identities.findOne({ provider: "google", subject: identity.subject }).session(session);
      if (owner && owner.accountId !== account.id) throw new HttpError("This Google account is already connected to another BGSNL account.", 409);
      if (existing) await identities.updateOne({ _id: existing._id }, { $set: { email: identity.email } }, { session });
      else await identities.create([{ provider: "google", ...identity, accountId: account.id }], { session });
    });
  } catch (error) {
    if (error.code === 11000) throw new HttpError("This Google account is already connected. Please refresh your settings.", 409);
    throw error;
  } finally { await session.endSession(); }
  return account;
}
