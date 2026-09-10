import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import RefreshSession from "../../models/RefreshSession.js";
import HttpError from "../../models/Http-error.js";
import { findUserById } from "../main-services/user-service.js";
import { signSessionToken, SESSION_LIFETIME_SECONDS, SESSION_IDLE_SECONDS } from "../../util/auth/session-token.js";

// Covers the BFF's 15s renewal + 60s resource response before cookies arrive.
// Keep this bounded: genuine older replay outside it revokes the login.
export const ROTATION_GRACE_MS = 120_000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const denied = () => new HttpError("Session expired or revoked. Please sign in again.", 401);
export const sessionDeadline = (authTime, lastActivity) => Math.max(authTime * 1000 + SESSION_LIFETIME_SECONDS * 1000, +new Date(lastActivity) + SESSION_IDLE_SECONDS * 1000);

// Domain-separated keyed derivation lets concurrent API instances return the
// SAME successor without storing plaintext/encrypted refresh tokens in Mongo.
function refreshValue(id, generation) {
  if (!process.env.JWT_STRING) throw new Error("Authentication signing key is missing");
  const value = `${id}.${generation}`;
  return `${value}.${createHmac("sha256", process.env.JWT_STRING).update(`bgsnl-refresh-v1:${value}`).digest("base64url")}`;
}
function parseRefresh(value) {
  if (typeof value !== "string" || !/^[\da-f-]{36}\.\d{1,10}\.[A-Za-z0-9_-]{43}$/.test(value)) throw denied();
  const [id, raw] = value.split(".");
  const generation = Number(raw);
  if (!equal(value, refreshValue(id, generation))) throw denied();
  return { id, generation };
}

export function createSessionService({ records = RefreshSession, findAccount = findUserById, now = Date.now } = {}) {
  const read = (id) => records.findById(id).select("+tokenHash").lean();
  const usable = (record) => record && !record.revokedAt && record.authVersion === Number(process.env.AUTH_VERSION ?? 1) &&
    +new Date(record.expiresAt) > now() && sessionDeadline(record.authTime, record.lastActivityAt) > now();
  const packet = (record, user) => ({
    token: signSessionToken(user, { sid: record._id, session: { token_use: "access", sid: record._id,
      auth_time: record.authTime, iat: Math.floor(now() / 1000), exp: Math.floor(now() / 1000) + 1,
      session_exp: Math.floor(+new Date(record.expiresAt) / 1000) },
      sessionExpiresAt: Math.floor(+new Date(record.expiresAt) / 1000), now: now() }),
    refreshToken: refreshValue(record._id, record.generation),
  });
  async function start(user) {
    const timestamp = Math.floor(now() / 1000), id = randomUUID();
    const record = { _id: id, accountId: user.id, sessionVersion: Number(user.sessionVersion ?? 0), authVersion: Number(process.env.AUTH_VERSION ?? 1), authTime: timestamp,
      lastActivityAt: new Date(timestamp * 1000), expiresAt: new Date((timestamp + SESSION_LIFETIME_SECONDS) * 1000),
      generation: 0, tokenHash: hash(refreshValue(id, 0)), rotatedAt: new Date(0), revokedAt: null };
    await records.create(record);
    return packet(record, user);
  }
  async function refresh(value, { activity = false } = {}) {
    const { id, generation } = parseRefresh(value);
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = await read(id);
      if (!usable(record)) throw denied();
      const user = await findAccount(record.accountId);
      if (!user || Number(user.sessionVersion ?? 0) !== record.sessionVersion) throw denied();
      const current = generation === record.generation && equal(record.tokenHash, hash(value));
      const inGrace = now() - +new Date(record.rotatedAt) < ROTATION_GRACE_MS;
      if (!current && !(generation === record.generation - 1 && inGrace)) {
        // A cryptographically genuine older credential outside concurrency grace
        // is replay: revoke this login only. Random/forged input cannot revoke it.
        if (generation < record.generation) await records.updateOne({ _id: id }, { $set: { revokedAt: new Date(now()), expiresAt: new Date(now()) } });
        throw denied();
      }
      const nextGeneration = current && !inGrace ? record.generation + 1 : record.generation;
      const updated = await records.findOneAndUpdate({ _id: id, generation: record.generation, revokedAt: null,
        expiresAt: { $gt: new Date(now()) } }, {
        $set: { generation: nextGeneration, tokenHash: hash(refreshValue(id, nextGeneration)),
          ...(nextGeneration !== record.generation ? { rotatedAt: new Date(now()) } : {}) },
        ...(activity ? { $max: { lastActivityAt: new Date(now()), expiresAt: new Date(sessionDeadline(record.authTime, now())) } } : {}),
      }, { new: true }).lean();
      if (updated) return packet(updated, user);
    }
    throw new HttpError("Session renewal is busy. Please try again.", 503);
  }
  async function validate(claims, user) {
    const record = await read(claims.sid);
    if (!usable(record) || record.authTime !== claims.auth_time || record.sessionVersion !== Number(user.sessionVersion ?? 0) ||
        (record.accountId !== user.id && !user.accountAliases?.includes(record.accountId))) throw denied();
    return record;
  }
  async function replace(user, { session }) {
    const record = await read(session.sid);
    if (!usable(record) || record.authTime !== session.auth_time || record.sessionVersion !== session.sessionVersion ||
        (record.accountId !== user.id && !user.accountAliases?.includes(record.accountId))) throw denied();
    // Current browser survives its confirmed credential change; all other
    // sessions fail the account's incremented sessionVersion immediately.
    const changed = Number(user.sessionVersion ?? 0) !== record.sessionVersion;
    const generation = record.generation + (changed ? 1 : 0);
    const updated = await records.findOneAndUpdate({ _id: record._id, generation: record.generation,
      sessionVersion: record.sessionVersion, revokedAt: null, expiresAt: { $gt: new Date(now()) } },
      { $set: { accountId: user.id, sessionVersion: Number(user.sessionVersion ?? 0), generation,
        tokenHash: hash(refreshValue(record._id, generation)),
        // No concurrency grace for credentials issued BEFORE a security change.
        ...(changed ? { rotatedAt: new Date(0) } : {}) } }, { new: true }).lean();
    if (!updated) throw denied();
    return packet(updated, user);
  }
  async function revoke(value) {
    let parsed;
    try { parsed = parseRefresh(value); } catch { return; }
    await records.updateOne({ _id: parsed.id }, { $set: { revokedAt: new Date(now()), expiresAt: new Date(now()) } });
  }
  return { start, refresh, validate, replace, revoke };
}
export const sessions = createSessionService();
