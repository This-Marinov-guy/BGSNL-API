import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { signSessionToken, verifySessionToken, SESSION_LIFETIME_SECONDS, ACCESS_LIFETIME_SECONDS } from "../util/auth/session-token.js";
import { createSessionService, ROTATION_GRACE_MS } from "../services/authentication/sessions.js";
import { createAuthMiddleware } from "../middleware/authorization.js";
import { memorySessionStore } from "./fixtures/session-store.mjs";
import RefreshSession from "../models/RefreshSession.js";
import { sessionAction } from "../controllers/session-controller.js";

process.env.JWT_STRING = "isolated-session-tests-only-strong-placeholder";
process.env.AUTH_VERSION = "1";
const start = 1800000000000, day = 86400000, hour = 3600000;
const account = { id: "member_fixture", roles: ["member"], status: "locked", sessionVersion: 2 };
const denied = (error) => error.statusCode === 401;
function harness() {
  let time = start, user = { ...account };
  const records = memorySessionStore();
  const service = createSessionService({ records, findAccount: async () => user, now: () => time });
  return { records, service, at(value) { time = value; }, user(value) { user = value; }, claims: (packet) => verifySessionToken(packet.token, { now: time }) };
}
test("access JWTs last 15 minutes; refresh grants expire with an indexed TTL and store only a hash", async () => {
  const h = harness(), packet = await h.service.start(account), claims = h.claims(packet);
  assert.equal(claims.userId, account.id); assert.deepEqual(claims.roles, account.roles);
  assert.equal(claims.auth_time, start / 1000); assert.equal(claims.exp - claims.iat, ACCESS_LIFETIME_SECONDS);
  assert.equal(claims.session_exp - claims.auth_time, SESSION_LIFETIME_SECONDS);
  assert.equal(claims.token_use, "access"); assert.equal(claims.sessionVersion, 2);
  const row = h.records.rows.get(claims.sid);
  assert.equal(row.tokenHash.length, 64); assert.ok(!JSON.stringify(row).includes(packet.refreshToken));
  assert.ok(RefreshSession.schema.indexes().some(([keys, options]) => keys.expiresAt === 1 && options.expireAfterSeconds === 0));
  assert.ok(verifySessionToken(packet.token, { now: start + ACCESS_LIFETIME_SECONDS * 1000 - 1 }));
  assert.throws(() => verifySessionToken(packet.token, { now: start + ACCESS_LIFETIME_SECONDS * 1000 }));
});
test("rotation recovers expired access without restarting the original 30-day clock", async () => {
  const h = harness(), initial = await h.service.start(account);
  h.at(start + 29 * day);
  const rotated = await h.service.refresh(initial.refreshToken);
  assert.notEqual(rotated.refreshToken, initial.refreshToken);
  assert.equal(h.claims(rotated).auth_time, start / 1000);
  assert.equal(h.claims(rotated).session_exp, start / 1000 + SESSION_LIFETIME_SECONDS);
  assert.equal(+h.records.rows.get(h.claims(rotated).sid).lastActivityAt, start);
});
test("day 30 does not interrupt use; only one hour of inactivity ends the extended login", async () => {
  const h = harness(); let packet = await h.service.start(account);
  h.at(start + 30 * day - 10 * 60000);
  packet = await h.service.refresh(packet.refreshToken, { activity: true });
  h.at(start + 30 * day + 40 * 60000);
  packet = await h.service.refresh(packet.refreshToken, { activity: true });
  assert.equal(h.claims(packet).auth_time, start / 1000);
  assert.equal(h.claims(packet).session_exp * 1000, start + 30 * day + 100 * 60000);
  h.at(start + 30 * day + 99 * 60000);
  packet = await h.service.refresh(packet.refreshToken); // background renewal does NOT touch activity
  h.at(start + 30 * day + 100 * 60000);
  await assert.rejects(h.service.refresh(packet.refreshToken), denied);
  await assert.rejects(h.service.refresh(packet.refreshToken, { activity: true }), denied); // cannot revive
});
test("inactivity alone before 30 days does not end a login; idle at day 30 does", async () => {
  const h = harness(); let packet = await h.service.start(account);
  h.at(start + 20 * day); packet = await h.service.refresh(packet.refreshToken);
  h.at(start + 30 * day - 1); packet = await h.service.refresh(packet.refreshToken);
  h.at(start + 30 * day); await assert.rejects(h.service.refresh(packet.refreshToken, { activity: true }), denied);
});
test("an active login can continue beyond 30 days without rolling auth_time", async () => {
  const h = harness(); let packet = await h.service.start(account);
  for (let elapsed = 30 * day - hour; elapsed < 33 * day; elapsed += 30 * 60000) {
    h.at(start + elapsed); packet = await h.service.refresh(packet.refreshToken, { activity: true });
    assert.equal(h.claims(packet).auth_time, start / 1000);
  }
});
test("concurrent refreshes return one successor; stale genuine replay revokes that login only", async () => {
  const h = harness(), initial = await h.service.start(account), other = await h.service.start(account);
  const packets = await Promise.all(Array.from({ length: 12 }, () => h.service.refresh(initial.refreshToken)));
  assert.equal(new Set(packets.map((p) => p.refreshToken)).size, 1);
  assert.equal((await h.service.refresh(packets[0].refreshToken)).refreshToken, packets[0].refreshToken);
  h.at(start + ROTATION_GRACE_MS);
  await assert.rejects(h.service.refresh(initial.refreshToken), denied);
  await assert.rejects(h.service.refresh(packets[0].refreshToken), denied);
  assert.ok(await h.service.refresh(other.refreshToken));
});
test("forged refresh values cannot revoke or access a real login", async () => {
  const h = harness(), packet = await h.service.start(account);
  for (const value of [null, "not-a-token", packet.refreshToken.replace(/.$/, "!"), packet.refreshToken.replace(".0.", ".500.")]) {
    await assert.rejects(h.service.refresh(value), denied); await h.service.revoke(value);
  }
  assert.ok(await h.service.refresh(packet.refreshToken));
});
test("logout, removed accounts and credential revocation invalidate access immediately", async () => {
  for (const action of ["logout", "removed", "version"]) {
    const h = harness(), packet = await h.service.start(account), claims = h.claims(packet);
    if (action === "logout") await h.service.revoke(packet.refreshToken);
    if (action === "removed") h.user(null);
    if (action === "version") h.user({ ...account, sessionVersion: 3 });
    await assert.rejects(h.service.refresh(packet.refreshToken), denied);
    if (action === "logout") await assert.rejects(h.service.validate(claims, account), denied);
  }
});
test("confirmed security changes replace current credentials and revoke other devices", async () => {
  const h = harness(), packet = await h.service.start(account), other = await h.service.start(account);
  const updated = { ...account, sessionVersion: 3 }; h.user(updated);
  const replacement = await h.service.replace(updated, { session: h.claims(packet) });
  assert.equal(h.claims(replacement).auth_time, start / 1000);
  assert.equal(h.claims(replacement).sessionVersion, 3);
  assert.notEqual(replacement.refreshToken, packet.refreshToken);
  await assert.rejects(h.service.refresh(other.refreshToken), denied);
  assert.ok(await h.service.refresh(replacement.refreshToken));
});
test("the old current-browser refresh token is invalid after a credential change", async () => {
  const h = harness(), packet = await h.service.start(account), updated = { ...account, sessionVersion: 3 };
  h.user(updated); await h.service.replace(updated, { session: h.claims(packet) });
  await assert.rejects(h.service.refresh(packet.refreshToken), denied);
});
test("global auth-version changes also revoke refresh grants", async (t) => {
  const h = harness(), packet = await h.service.start(account);
  process.env.AUTH_VERSION = "2";
  t.after(() => { process.env.AUTH_VERSION = "1"; });
  await assert.rejects(h.service.refresh(packet.refreshToken), denied);
});
test("migration aliases preserve the login but unrelated accounts cannot adopt it", async () => {
  const h = harness(), packet = await h.service.start(account);
  await h.service.validate(h.claims(packet), { ...account, id: "alumni_fixture", accountAliases: [account.id] });
  await assert.rejects(h.service.validate(h.claims(packet), { ...account, id: "member_other" }), denied);
});
test("malformed, forged, legacy and invalid-purpose JWTs fail closed", () => {
  const claims = jwt.decode(signSessionToken(account, { now: start }));
  for (const token of [null, "not-a-jwt", jwt.sign({ userId: account.id, roles: account.roles }, process.env.JWT_STRING), jwt.sign(claims, "another-secret")]) {
    assert.throws(() => verifySessionToken(token, { now: start }));
  }
  for (const change of [{ iss: "other" }, { aud: "other" }, { version: 0 }, { sessionVersion: -1 }, { roles: "admin" }, { userId: null },
    { exp: claims.exp + 1 }, { auth_time: null }, { token_use: "refresh" }, { sid: null }, { session_exp: claims.session_exp + 1 }]) {
    assert.throws(() => verifySessionToken(jwt.sign({ ...claims, ...change }, process.env.JWT_STRING), { now: start }));
  }
});
test("expired access is a recognizable 401 before DB or the business handler, never 422", async (t) => {
  t.mock.method(Date, "now", () => start + ACCESS_LIFETIME_SECONDS * 1000);
  let reached = false;
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await createAuthMiddleware({ findAccount: async () => { reached = true; } })({ headers: { authorization: `Bearer ${signSessionToken(account, { now: start })}` } }, res, () => { reached = true; });
  assert.equal(res.code, 401); assert.equal(res.body.code, "ACCESS_TOKEN_EXPIRED"); assert.equal(reached, false);
});
test("renewal is server-key protected and activity never trusts a client timestamp or lifetime", async (t) => {
  const previous = process.env.SSR_SERVER_KEY;
  process.env.SSR_SERVER_KEY = "isolated-server-key-for-lifecycle-tests";
  t.after(() => { if (previous === undefined) delete process.env.SSR_SERVER_KEY; else process.env.SSR_SERVER_KEY = previous; });
  let calls = 0, error;
  const service = { refresh: async (value, options) => { calls++; assert.equal(value, "fixture"); assert.deepEqual(options, { activity: true }); return { token: "server-only" }; } };
  const handler = sessionAction("activity", { service, limit: async (_key, max) => assert.equal(max, 600) });
  const res = { set() {}, json(value) { this.body = value; } };
  await handler({ headers: { "x-bgsnl-server-key": "forged" } }, res, (value) => { error = value; });
  assert.equal(error.statusCode, 403); assert.equal(calls, 0);
  await handler({ headers: { "x-bgsnl-server-key": process.env.SSR_SERVER_KEY }, body: { refreshToken: "fixture", auth_time: 1, expiresAt: "2099-01-01", activityAt: "2099-01-01" } }, res, (value) => { throw value; });
  assert.equal(calls, 1); assert.equal(res.body.token, "server-only");
});
