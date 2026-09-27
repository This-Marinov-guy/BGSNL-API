import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import HttpError from "../../models/Http-error.js";
import { embeddedPasskeys as PasskeyCredential, lockAccountCredentials } from "./embedded-credentials.js";
import PasskeyChallenge from "../../models/AuthChallenge.js";
import { redisRateLimits as AuthRateLimit } from "../../services/storage/rate-limits.js";
import { verifyCurrentPassword } from "./google.js";
import { findUserById } from "../main-services/user-service.js";
import { CURRENT_ACCOUNT_FILTER } from "../../util/subscriptions/policy.js";

export const PASSKEY_LIMIT = 10;
export const PASSKEY_CHALLENGE_MS = 5 * 60000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const validProof = (proof) => typeof proof === "string" && /^[a-zA-Z0-9_-]{43,128}$/.test(proof);
const changed = () => new HttpError("Your account or passkey changed. Please start again.", 409);
const invalid = () => new HttpError("The passkey could not be verified. Try again or use your BGSNL password.", 401);

function requireTopLevelCeremony(credential) {
  try {
    const data = JSON.parse(Buffer.from(credential.response.clientDataJSON, "base64url").toString("utf8"));
    if (data.crossOrigin || data.topOrigin) throw invalid();
  } catch { throw invalid(); }
}

// Never derive trusted RP IDs or expected origins from Host, forwarded headers,
// or caller-supplied options. Apex and www share production passkeys.
export function passkeyRelyingParty(origin, environment = process.env.NODE_ENV) {
  if (["https://bulgariansociety.nl", "https://www.bulgariansociety.nl"].includes(origin)) {
    return { rpId: "bulgariansociety.nl", origin };
  }
  if (environment !== "production" && /^http:\/\/localhost:300[012]$/.test(origin || "")) {
    return { rpId: "localhost", origin };
  }
  throw new HttpError("Passkeys are available on bulgariansociety.nl or localhost development. Open the website directly and try again.", 403);
}

export function requirePasskeyOrigin(req, _res, next) {
  try {
    passkeyRelyingParty(req.headers.origin);
    if (!req.is("application/json")) throw new HttpError("Passkey requests must use JSON.", 403);
    next();
  } catch (error) { next(error); }
}

export async function limitPasskeyRequests(key, maximum = 30, { limits = AuthRateLimit, now = Date.now() } = {}) {
  const windowMs = 15 * 60000;
  const bucket = Math.floor(now / windowMs);
  const id = `passkey:${digest(key)}:${bucket}`;
  let entry;
  try {
    entry = await limits.findOneAndUpdate({ _id: id }, {
      $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) },
    }, { upsert: true, new: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    entry = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true });
  }
  if (!entry || entry.count > maximum) throw new HttpError("Too many passkey attempts. Please try again in 15 minutes.", 429);
}

export async function listPasskeys(user, { credentials = PasskeyCredential } = {}) {
  const items = await credentials.find({ accountId: user.id });
  return items.map((item) => ({ id: item._id, name: item.name, rpId: item.rpId,
    createdAt: item.createdAt, lastUsedAt: item.lastUsedAt || null }));
}

export async function preparePasskey({ purpose, origin, proof, user, password, name }, {
  challenges = PasskeyChallenge, credentials = PasskeyCredential,
  verifyPassword = verifyCurrentPassword, registerOptions = generateRegistrationOptions,
  loginOptions = generateAuthenticationOptions, now = Date.now(),
} = {}) {
  const { rpId } = passkeyRelyingParty(origin);
  if (!validProof(proof) || !["register", "login"].includes(purpose)) throw new HttpError("Invalid passkey request.", 422);
  let options, security = {};
  if (purpose === "register") {
    await verifyPassword(user, password);
    if (typeof name !== "string" || !name.trim() || name.trim().length > 60 || [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new HttpError("Give your passkey a name of up to 60 characters.", 422);
    }
    const existing = await credentials.find({ accountId: user.id, rpId });
    if (existing.length >= PASSKEY_LIMIT) throw new HttpError("Remove an unused passkey before adding another (maximum 10 per website).", 409);
    // Reuse the original opaque handle across Member/Alumni migrations.
    const userHandle = existing[0]?.userHandle || createHash("sha256").update(`bgsnl-passkey:${user.id}`).digest("base64url");
    options = await registerOptions({ rpName: "Bulgarian Society Netherlands", rpID: rpId,
      userID: new Uint8Array(Buffer.from(userHandle, "base64url")), userName: user.email,
      userDisplayName: [user.name, user.surname].filter(Boolean).join(" ") || user.email,
      attestationType: "none", timeout: 60000,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: existing.map((item) => ({ id: item._id, transports: item.transports })),
    });
    security = { accountId: user.id, passwordHash: digest(user.password), sessionVersion: Number(user.sessionVersion ?? 0),
      userHandle, name: name.trim() };
  } else {
    // Discoverable login: no email lookup or account enumeration.
    options = await loginOptions({ rpID: rpId, userVerification: "required", timeout: 60000, allowCredentials: [] });
  }
  const challenge = await challenges.create({ _id: random(), kind: "passkey", purpose, origin, rpId,
    challenge: options.challenge, proofHash: digest(proof), ...security,
    expiresAt: new Date(now + PASSKEY_CHALLENGE_MS) });
  return { challengeId: challenge._id, options, expiresAt: challenge.expiresAt };
}

function challengeQuery({ purpose, origin, proof, challengeId }) {
  const { rpId } = passkeyRelyingParty(origin);
  if (!validProof(proof) || !validProof(challengeId)) throw new HttpError("Invalid passkey challenge.", 422);
  return { kind: "passkey", _id: challengeId, purpose, origin, rpId, proofHash: digest(proof), expiresAt: { $gt: new Date() } };
}

async function fenceAccount(user, session, revoke = false) {
  const version = Number(user.sessionVersion ?? 0);
  const versionFilter = version === 0 ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] } : { sessionVersion: version };
  const account = await user.constructor.findOneAndUpdate({ _id: user.id, password: user.password,
    ...CURRENT_ACCOUNT_FILTER, ...versionFilter }, {
    $inc: { identityRevision: 1, ...(revoke ? { sessionVersion: 1 } : {}) },
  }, { new: true, session });
  if (!account) throw changed();
  return account;
}

export async function registerPasskey({ origin, proof, challengeId, credential, user }, {
  challenges = PasskeyChallenge, credentials = PasskeyCredential, verify = verifyRegistrationResponse,
  startSession = () => mongoose.startSession(), lock = lockAccountCredentials,
} = {}) {
  const query = challengeQuery({ origin, proof, challengeId, purpose: "register" });
  const challenge = await challenges.findOne(query);
  if (!challenge) throw new HttpError("This passkey request expired or was already used. Please start again.", 409);
  if (!user || challenge.accountId !== user.id || challenge.passwordHash !== digest(user.password) ||
      challenge.sessionVersion !== Number(user.sessionVersion ?? 0)) throw changed();
  let result;
  try {
    requireTopLevelCeremony(credential);
    result = await verify({ response: credential, expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin, expectedRPID: challenge.rpId, requireUserVerification: true });
  } catch { throw invalid(); }
  if (!result.verified || !result.registrationInfo?.credential) throw invalid();
  const { credential: verified, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  const session = await startSession();
  try {
    await session.withTransaction(async () => {
      await lock(session);
      await fenceAccount(user, session);
      if (!await challenges.findOneAndDelete(query, { session })) throw changed();
      if (await credentials.countDocuments({ accountId: user.id, rpId: challenge.rpId }).session(session) >= PASSKEY_LIMIT) {
        throw new HttpError("Remove an unused passkey before adding another (maximum 10 per website).", 409);
      }
      await credentials.create([{ _id: verified.id, accountId: user.id, rpId: challenge.rpId,
        name: challenge.name, userHandle: challenge.userHandle, publicKey: Buffer.from(verified.publicKey), counter: verified.counter,
        transports: verified.transports || [], deviceType: credentialDeviceType, backedUp: credentialBackedUp }], { session });
    });
  } catch (error) {
    if (error.code === 11000) throw new HttpError("This passkey is already registered. Choose another passkey or use the existing one.", 409);
    throw error;
  } finally { await session.endSession(); }
}

export async function authenticatePasskey({ origin, proof, challengeId, credential }, {
  challenges = PasskeyChallenge, credentials = PasskeyCredential, verify = verifyAuthenticationResponse,
  findAccount = findUserById, startSession = () => mongoose.startSession(),
} = {}) {
  const query = challengeQuery({ origin, proof, challengeId, purpose: "login" });
  const challenge = await challenges.findOne(query);
  if (!challenge) throw new HttpError("This passkey request expired or was already used. Please start again.", 409);
  if (typeof credential?.id !== "string") throw invalid();
  const passkey = await credentials.findOne({ _id: credential.id, rpId: challenge.rpId });
  if (!passkey || credential.response?.userHandle !== passkey.userHandle) throw invalid();
  const user = await findAccount(passkey.accountId);
  if (!user) throw invalid();
  let verification;
  try {
    requireTopLevelCeremony(credential);
    verification = await verify({ response: credential, expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin, expectedRPID: challenge.rpId, requireUserVerification: true,
      credential: { id: passkey._id, publicKey: new Uint8Array(passkey.publicKey), counter: passkey.counter, transports: passkey.transports },
    });
  } catch { throw invalid(); }
  if (!verification.verified || !verification.authenticationInfo) throw invalid();
  const session = await startSession();
  let account;
  try {
    await session.withTransaction(async () => {
      account = await fenceAccount(user, session);
      if (!await challenges.findOneAndDelete(query, { session })) throw changed();
      // The revision also fences synced passkeys whose signature counter is 0.
      const updated = await credentials.findOneAndUpdate({ _id: passkey._id, accountId: passkey.accountId,
        rpId: challenge.rpId, counter: passkey.counter, revision: passkey.revision }, {
        $set: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date(),
          backedUp: verification.authenticationInfo.credentialBackedUp }, $inc: { revision: 1 },
      }, { new: true, session });
      if (!updated) throw changed();
    });
  } finally { await session.endSession(); }
  return account;
}

export async function removePasskey({ user, password, credentialId }, {
  credentials = PasskeyCredential, verifyPassword = verifyCurrentPassword, startSession = () => mongoose.startSession(),
} = {}) {
  await verifyPassword(user, password);
  if (typeof credentialId !== "string") throw new HttpError("Choose a passkey to remove.", 422);
  const session = await startSession();
  let account;
  try {
    await session.withTransaction(async () => {
      account = await fenceAccount(user, session, true);
      const removed = await credentials.deleteOne({ _id: credentialId, accountId: user.id }, { session });
      if (removed.deletedCount !== 1) throw new HttpError("This passkey is no longer registered to your account.", 404);
    });
  } finally { await session.endSession(); }
  return account;
}
