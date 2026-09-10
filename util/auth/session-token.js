import "dotenv/config";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const ACCESS_LIFETIME_SECONDS = 15 * 60;
export const SESSION_IDLE_SECONDS = 60 * 60;
export const SESSION_ISSUER = "bgsnl-api";
export const SESSION_AUDIENCE = "bgsnl-website";

function requireSessionWindow(claims, now) {
  if (!Number.isSafeInteger(claims?.auth_time) || claims.auth_time <= 0 ||
      !Number.isSafeInteger(claims.iat) || claims.iat < claims.auth_time || claims.iat > now + 30 ||
      claims.token_use !== "access" || typeof claims.sid !== "string" || !/^[\da-f-]{36}$/.test(claims.sid) ||
      !Number.isSafeInteger(claims.session_exp) || claims.session_exp < claims.auth_time + SESSION_LIFETIME_SECONDS ||
      claims.session_exp > Math.max(claims.auth_time + SESSION_LIFETIME_SECONDS, claims.iat + SESSION_IDLE_SECONDS) ||
      !Number.isSafeInteger(claims.exp) || claims.exp > claims.iat + ACCESS_LIFETIME_SECONDS ||
      claims.exp > claims.session_exp || claims.exp <= claims.iat ||
      claims.auth_time > now) {
    throw new jwt.JsonWebTokenError("Session expired or invalid. Please sign in again.");
  }
}

// Signing alone never creates a refresh grant. Login/rotation persist that grant
// in authentication/sessions.js. The API also checks it on every protected call.
export function signSessionToken(user, { session, sid = session?.sid || randomUUID(),
  sessionExpiresAt, now = Date.now() } = {}) {
  const timestamp = Math.floor(now / 1000);
  if (session !== undefined) requireSessionWindow(session, timestamp);
  const authTime = session?.auth_time ?? timestamp;
  const sessionExpiry = sessionExpiresAt ?? session?.session_exp ?? authTime + SESSION_LIFETIME_SECONDS;
  if (sessionExpiry <= timestamp) throw new jwt.JsonWebTokenError("Session expired");
  return jwt.sign({
    token_use: "access", sid,
    version: Number(process.env.AUTH_VERSION ?? 1),
    sessionVersion: Number(user.sessionVersion ?? 0),
    userId: user.id,
    roles: user.roles,
    status: user.status,
    image: user.image,
    name: user.name,
    surname: user.surname,
    email: user.email,
    region: user.region,
    customerId: user.subscription?.customerId ?? "",
    auth_time: authTime,
    iat: timestamp,
    session_exp: sessionExpiry,
    exp: Math.min(timestamp + ACCESS_LIFETIME_SECONDS, sessionExpiry),
  }, process.env.JWT_STRING, {
    algorithm: "HS256", issuer: SESSION_ISSUER, audience: SESSION_AUDIENCE,
  });
}

export function verifySessionToken(token, { now = Date.now() } = {}) {
  const timestamp = Math.floor(now / 1000);
  const claims = jwt.verify(token, process.env.JWT_STRING, {
    algorithms: ["HS256"], issuer: SESSION_ISSUER, audience: SESSION_AUDIENCE,
    clockTimestamp: timestamp,
  });
  requireSessionWindow(claims, timestamp);
  if (claims.version !== Number(process.env.AUTH_VERSION ?? 1) ||
      !Number.isSafeInteger(claims.sessionVersion) || claims.sessionVersion < 0 ||
      typeof claims.userId !== "string" || !claims.userId || claims.userId.length > 256 ||
      !Array.isArray(claims.roles) || !claims.roles.every((role) => typeof role === "string")) {
    throw new jwt.JsonWebTokenError("Invalid session claims");
  }
  return claims;
}
