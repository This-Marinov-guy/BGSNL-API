import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { signSessionToken } from "../util/auth/session-token.js";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";
import AccountIdentity from "../models/AccountIdentity.js";
import AuthChallenge from "../models/AuthChallenge.js";
import { createAuthMiddleware } from "../middleware/authorization.js";
import { refreshToken } from "../controllers/users-controllers.js";
import { redactSensitive } from "../middleware/axiom-logger.js";
import { buildLoginResponse } from "../services/authentication/login.js";
import {
  validateGooglePayload, requireGoogleOrigin, verifyCurrentPassword, createGoogleChallenge,
  consumeGoogleChallenge, findGoogleAccount, changeGoogleIdentity, limitGoogleRequests,
  isGoogleLinkEligible, requireMatchingGoogleEmail, googleConnectionStatus,
} from "../services/authentication/google.js";

const now = Date.now();
const origin = "https://www.bulgariansociety.nl";
const clientId = "test-only.apps.googleusercontent.com";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const payload = () => ({
  sub: "google-stable-subject", email: "owner@example.test", email_verified: true,
  iss: "https://accounts.google.com", aud: clientId, nonce: "random-server-nonce",
  iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300,
});

test("verified Google payloads are identified by subject, not email", () => {
  assert.deepEqual(validateGooglePayload(payload(), "random-server-nonce", clientId, now), {
    subject: "google-stable-subject", email: "owner@example.test",
  });
});
for (const [name, changes] of Object.entries({
  audience: { aud: "attacker.apps.googleusercontent.com" }, issuer: { iss: "https://evil.example" },
  authorizedParty: { azp: "attacker.apps.googleusercontent.com" }, nonce: { nonce: "replayed-nonce" },
  expired: { exp: Math.floor(now / 1000) - 1 }, future: { iat: Math.floor(now / 1000) + 120 },
  unverified: { email_verified: false }, missingSubject: { sub: "" },
})) test(`Google ${name} mismatch is rejected`, () => {
  assert.throws(() => validateGooglePayload({ ...payload(), ...changes }, "random-server-nonce", clientId, now), (error) => error.statusCode === 401);
});

test("Google mutations require an approved browser origin and JSON, not form posts", () => {
  for (const [requestOrigin, json, allowed] of [[origin, true, true], ["https://evil.example", true, false], [undefined, true, false], [origin, false, false]]) {
    let error;
    requireGoogleOrigin({ headers: { origin: requestOrigin }, is: () => json }, {}, (value) => { error = value; });
    assert.equal(!error, allowed);
  }
});
test("linking and disconnecting require the actual BGSNL password", async () => {
  const compare = async (provided, stored) => provided === "current-password" && stored === "password-hash";
  await verifyCurrentPassword({ password: "password-hash" }, "current-password", compare);
  await assert.rejects(verifyCurrentPassword({ password: "password-hash" }, "wrong-password", compare), (error) => error.statusCode === 403);
  await assert.rejects(verifyCurrentPassword({}, "current-password", compare));
});
test("link challenges bind password proof to the current account without storing a password", async (t) => {
  const previous = process.env.GOOGLE_SIGN_IN_CLIENT_ID;
  process.env.GOOGLE_SIGN_IN_CLIENT_ID = clientId;
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_SIGN_IN_CLIENT_ID; else process.env.GOOGLE_SIGN_IN_CLIENT_ID = previous; });
  let record, confirmed = false;
  const result = await createGoogleChallenge({ purpose: "link", origin, proof: "a".repeat(64), user: { id: "member_one", email: "Owner@Gmail.com", password: "stored-hash" }, password: "current-password" }, {
    challenges: { create: async (value) => { record = value; return value; } },
    verifyPassword: async () => { confirmed = true; },
  });
  assert.equal(confirmed, true); assert.equal(record.accountId, "member_one");
  assert.equal(record.passwordHash, hash("stored-hash")); assert.equal(record.password, undefined);
  assert.equal(record.proofHash, hash("a".repeat(64))); assert.notEqual(result.nonce, result.challengeId);
  assert.ok(record.expiresAt > new Date()); assert.equal(result.clientId, clientId);
  assert.equal(record.accountEmail, "owner@gmail.com"); assert.equal(result.loginHint, "owner@gmail.com");
});

test("Google connection eligibility uses the account's exact Gmail domain", () => {
  for (const email of ["owner@gmail.com", " Owner@GMAIL.com "]) assert.equal(isGoogleLinkEligible(email), true);
  for (const email of [null, undefined, "", "owner@example.test", "owner@workspace.test", "owner@gmail.com.evil.test", "owner@notgmail.com", "@gmail.com", "owner@@gmail.com", "a b@gmail.com"]) {
    assert.equal(isGoogleLinkEligible(email), false);
  }
});
test("Google connections require the same address, not dot or plus aliases", () => {
  requireMatchingGoogleEmail({ email: " Owner@GMAIL.com " }, { email: "owner@gmail.com" });
  for (const email of ["different@gmail.com", "o.wner@gmail.com", "owner+tag@gmail.com", "owner@googlemail.com", "owner@example.test", undefined]) {
    assert.throws(() => requireMatchingGoogleEmail({ email: "owner@gmail.com" }, { email }), (error) => error.statusCode === 403);
  }
  assert.throws(() => requireMatchingGoogleEmail({ email: "owner@example.test" }, { email: "owner@example.test" }), (error) => error.statusCode === 403);
});
test("non-Gmail accounts cannot obtain a link challenge even by calling the API directly", async (t) => {
  const previous = process.env.GOOGLE_SIGN_IN_CLIENT_ID;
  process.env.GOOGLE_SIGN_IN_CLIENT_ID = clientId;
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_SIGN_IN_CLIENT_ID; else process.env.GOOGLE_SIGN_IN_CLIENT_ID = previous; });
  let created = false;
  await assert.rejects(createGoogleChallenge({ purpose: "link", origin, proof: "a".repeat(64),
    user: { id: "member_one", email: "owner@example.test", password: "hash" }, password: "current-password" }, {
    challenges: { create: async () => { created = true; } }, verifyPassword: async () => {},
  }), (error) => error.statusCode === 403);
  assert.equal(created, false);
});
test("connection status publishes server-derived eligibility and the account email", () => {
  assert.deepEqual(googleConnectionStatus({ email: "owner@gmail.com" }), {
    enabled: !!process.env.GOOGLE_SIGN_IN_CLIENT_ID?.trim(), eligible: true, accountEmail: "owner@gmail.com", connected: false, email: null,
  });
  const status = googleConnectionStatus({ email: "owner@example.test" }, { email: "legacy@gmail.com" });
  assert.equal(status.eligible, false); assert.equal(status.connected, true); assert.equal(status.email, "legacy@gmail.com");
});

function challengeHarness(purpose = "login") {
  const proof = "a".repeat(64);
  const user = { id: "member_owner", email: "owner@gmail.com", password: "stored-password-hash" };
  let record = { _id: "challenge", purpose, origin, nonce: "signed-google-nonce", proofHash: hash(proof),
    accountId: user.id, accountEmail: user.email, passwordHash: hash(user.password), expiresAt: new Date(Date.now() + 300000) };
  const matches = (query) => record && record._id === query._id && record.purpose === query.purpose && record.origin === query.origin &&
    record.proofHash === query.proofHash && record.expiresAt > query.expiresAt.$gt;
  const dependencies = {
    challenges: { findOne: async (query) => matches(query) ? { ...record } : null,
      findOneAndDelete: async (query) => { if (!matches(query)) return null; const old = record; record = null; return old; } },
    verify: async (_credential, nonce) => { assert.equal(nonce, "signed-google-nonce"); return { subject: "verified-google-sub", email: "owner@gmail.com" }; },
    findAccount: async () => user,
  };
  const options = { challengeId: "challenge", credential: "signed-token", proof, purpose, origin, user };
  return { options, dependencies, user, expire: () => { record.expiresAt = new Date(0); }, consume: () => consumeGoogleChallenge(options, dependencies) };
}
test("a valid Google challenge is consumable exactly once under concurrent callbacks", async () => {
  const h = challengeHarness();
  const results = await Promise.allSettled([h.consume(), h.consume(), h.consume()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
});
test("wrong browser proof, purpose and origin cannot consume a sign-in challenge", async () => {
  for (const changes of [{ proof: "b".repeat(64) }, { purpose: "link" }, { origin: "https://evil.example" }]) {
    const h = challengeHarness();
    await assert.rejects(consumeGoogleChallenge({ ...h.options, ...changes }, h.dependencies), (error) => error.statusCode === 409);
    assert.ok(await h.consume());
  }
});
test("expired and signature-invalid credentials cannot authenticate", async () => {
  const expired = challengeHarness(); expired.expire(); await assert.rejects(expired.consume());
  const invalid = challengeHarness(); invalid.dependencies.verify = async () => { throw new Error("Signature verification failed"); };
  await assert.rejects(invalid.consume(), /Signature verification failed/);
});
test("linking cannot use a challenge from another account or before a password change", async () => {
  const other = challengeHarness("link");
  await assert.rejects(consumeGoogleChallenge({ ...other.options, user: { id: "another_account", password: other.user.password } }, other.dependencies));
  const changed = challengeHarness("link"); changed.user.password = "new-password-hash";
  await assert.rejects(changed.consume(), (error) => error.statusCode === 409);
});
test("an account migration can resolve a pending link challenge through verified aliases", async () => {
  const h = challengeHarness("link"); h.user.id = "alumni_current";
  assert.equal((await h.consume()).subject, "verified-google-sub");
});
test("disconnecting invalidates link challenges from the previous session version", async () => {
  const h = challengeHarness("link"); h.user.sessionVersion = 1;
  await assert.rejects(h.consume(), (error) => error.statusCode === 409);
});
test("a different verified Google address is rejected and cannot reuse the challenge", async () => {
  const h = challengeHarness("link");
  h.dependencies.verify = async () => ({ subject: "wrong-google", email: "other@gmail.com" });
  await assert.rejects(h.consume(), (error) => error.statusCode === 403);
  await assert.rejects(h.consume(), (error) => error.statusCode === 409);
});
test("email changes after password confirmation invalidate linking", async () => {
  const h = challengeHarness("link"); h.user.email = "updated@gmail.com";
  await assert.rejects(h.consume(), (error) => error.statusCode === 409);
  const fresh = challengeHarness("link");
  fresh.dependencies.findAccount = async () => ({ ...fresh.user, email: "updated@gmail.com" });
  await assert.rejects(fresh.consume(), (error) => error.statusCode === 409);
});
test("Google login never auto-links accounts by matching email", async () => {
  let lookedUp = false;
  await assert.rejects(findGoogleAccount({ subject: "unknown-subject", email: "owner@gmail.com" }, {
    identities: { findOne: async (query) => { assert.deepEqual(query, { provider: "google", subject: "unknown-subject" }); return null; } },
    findAccount: async () => { lookedUp = true; },
  }), (error) => error.statusCode === 403);
  assert.equal(lookedUp, false);
});
test("linked Google login resolves the saved account, including a migrated account ID", async () => {
  const user = { id: "alumni_current", email: "owner@gmail.com" };
  const result = await findGoogleAccount({ subject: "google-stable-subject", email: "owner@gmail.com" }, {
    identities: { findOne: async () => ({ _id: "identity", accountId: "member_old" }), exists: async () => true },
    findAccount: async (id) => { assert.equal(id, "member_old"); return user; },
  });
  assert.equal(result, user);
});
test("disconnecting during account lookup cannot issue a Google login", async () => {
  await assert.rejects(findGoogleAccount({ subject: "google-one", email: "owner@gmail.com" }, {
    identities: { findOne: async () => ({ _id: "identity", accountId: "member_owner" }), exists: async () => false },
    findAccount: async () => ({ id: "member_owner", email: "owner@gmail.com", sessionVersion: 1 }),
  }), (error) => error.statusCode === 401);
});
test("legacy mismatched and non-Gmail connections cannot bypass the policy during login", async () => {
  for (const email of ["different@gmail.com", "owner@example.test"]) {
    await assert.rejects(findGoogleAccount({ subject: "google-one", email: "owner@gmail.com" }, {
      identities: { findOne: async () => ({ _id: "identity", accountId: "member_owner" }), exists: async () => true },
      findAccount: async () => ({ id: "member_owner", email }),
    }), (error) => error.statusCode === 403);
  }
});

function identityHarness() {
  const user = { id: "member_owner", email: "owner@gmail.com", password: "stored-hash", sessionVersion: 0, identityRevision: 0 };
  let rows = [], live = { ...user };
  const session = { withTransaction: async (run) => {
    const oldRows = structuredClone(rows), oldUser = { ...live };
    try { await run(); } catch (error) { rows = oldRows; live = oldUser; throw error; }
  }, endSession: async () => {} };
  user.constructor = { findOneAndUpdate: async (query, update, options) => {
    assert.equal(options.session, session); assert.equal(query._id, user.id); assert.equal(query.password, user.password);
    if (live.password !== query.password || live.sessionVersion !== Number(query.sessionVersion ?? 0)) return null;
    for (const [key, value] of Object.entries(update.$inc)) live[key] += value;
    return { ...live };
  } };
  const identities = {
    findOne: (query) => ({ session: async (value) => {
      assert.equal(value, session);
      return rows.find((row) => Object.entries(query).every(([key, expected]) => row[key] === expected));
    } }),
    create: async (items, options) => { assert.equal(options.session, session); rows.push(...items.map((item) => ({ ...item, _id: "identity" }))); },
    deleteOne: async (query, options) => { assert.equal(options.session, session); rows = rows.filter((row) => row._id !== query._id); },
    updateOne: async (query, update) => Object.assign(rows.find((row) => row._id === query._id), update.$set),
  };
  return { user, dependencies: { identities, startSession: async () => session }, rows: () => rows,
    add: (row) => rows.push({ provider: "google", _id: "existing", ...row }), changePassword: () => { live.password = "changed"; },
    changeEmail: (email) => { live.email = email; }, live: () => live, revoke: () => { live.sessionVersion++; } };
}
test("linking stores only the verified identity and leaves the password and subscription intact", async () => {
  const h = identityHarness();
  const saved = await changeGoogleIdentity(h.user, { subject: "google-one", email: "owner@gmail.com" }, h.dependencies);
  assert.equal(h.rows()[0].accountId, "member_owner"); assert.equal(h.rows()[0].subject, "google-one");
  assert.equal(saved.password, "stored-hash"); assert.equal(saved.sessionVersion, 0); assert.equal(saved.identityRevision, 1);
});
test("Google subjects cannot be attached to a second BGSNL account", async () => {
  const h = identityHarness(); h.add({ accountId: "other-owner", subject: "google-one" });
  await assert.rejects(changeGoogleIdentity(h.user, { subject: "google-one", email: "owner@gmail.com" }, h.dependencies), (error) => error.statusCode === 409);
  assert.equal(h.rows().length, 1); assert.equal(h.rows()[0].accountId, "other-owner");
});
test("an existing Google connection cannot be silently replaced", async () => {
  const h = identityHarness(); h.add({ accountId: h.user.id, subject: "already-connected" });
  await assert.rejects(changeGoogleIdentity(h.user, { subject: "different-google", email: "owner@gmail.com" }, h.dependencies), (error) => error.statusCode === 409);
  assert.equal(h.rows()[0].subject, "already-connected");
});
test("disconnecting deletes the identity and advances the session version", async () => {
  const h = identityHarness(); h.add({ accountId: h.user.id, subject: "google-one" });
  const saved = await changeGoogleIdentity(h.user, null, h.dependencies);
  assert.equal(h.rows().length, 0); assert.equal(saved.sessionVersion, 1); assert.equal(saved.password, "stored-hash");
});
test("a password changed during identity mutation prevents any account linking", async () => {
  const h = identityHarness(); h.changePassword();
  await assert.rejects(changeGoogleIdentity(h.user, { subject: "google-one", email: "owner@gmail.com" }, h.dependencies));
  assert.equal(h.rows().length, 0);
});
test("a revoked session cannot finish linking even when it already passed authentication", async () => {
  const h = identityHarness(); h.revoke();
  await assert.rejects(changeGoogleIdentity(h.user, { subject: "google-one", email: "owner@gmail.com" }, h.dependencies), (error) => error.statusCode === 409);
  assert.equal(h.rows().length, 0);
});
test("the identity write itself rejects a different Google address", async () => {
  const h = identityHarness();
  await assert.rejects(changeGoogleIdentity(h.user, { subject: "google-one", email: "different@gmail.com" }, h.dependencies), (error) => error.statusCode === 403);
  assert.equal(h.rows().length, 0); assert.equal(h.live().identityRevision, 0);
});
test("the transaction rechecks the latest profile email before saving a connection", async () => {
  for (const email of ["updated@gmail.com", "owner@example.test"]) {
    const h = identityHarness(); h.changeEmail(email);
    await assert.rejects(changeGoogleIdentity(h.user, { subject: "google-one", email: "owner@gmail.com" }, h.dependencies), (error) => error.statusCode === 403);
    assert.equal(h.rows().length, 0); assert.equal(h.live().identityRevision, 0);
  }
});
test("an ineligible account can still disconnect an old Google identity", async () => {
  const h = identityHarness(); h.user.email = "owner@example.test"; h.changeEmail(h.user.email);
  h.add({ accountId: h.user.id, subject: "google-one", email: "different@gmail.com" });
  await changeGoogleIdentity(h.user, null, h.dependencies);
  assert.equal(h.rows().length, 0); assert.equal(h.live().sessionVersion, 1);
});
test("database indexes enforce global identity ownership and challenge expiry", () => {
  const unique = AccountIdentity.schema.indexes().filter(([, options]) => options.unique).map(([index]) => index);
  assert.deepEqual(unique, [{ provider: 1, subject: 1 }, { provider: 1, accountId: 1 }]);
  assert.ok(AuthChallenge.schema.indexes().some(([index, options]) => index.expiresAt && options.expireAfterSeconds === 0));
});

test("Google and password logins share billing verification without unlocking frozen accounts", async () => {
  const user = { id: "member_owner", status: "frozen", roles: ["member"], password: "hash", expireDate: new Date(0) };
  const response = await buildLoginResponse(user, { reconcile: async () => { throw new Error("Stripe unavailable"); }, sign: async () => "safe-session-token" });
  assert.equal(response.token, "safe-session-token"); assert.equal(response.status, "frozen");
  assert.equal(response.hasBenefits, false); assert.equal(response.billingVerificationUnavailable, true);
});
test("billing reconciliation cannot upgrade an in-flight revoked login to a fresh session", async () => {
  const user = { id: "member_owner", sessionVersion: 0, password: "hash", subscription: { id: "sub_one" } };
  let signed = false;
  await assert.rejects(buildLoginResponse(user, {
    reconcile: async () => ({ user: { ...user, sessionVersion: 1 } }), sign: async () => { signed = true; },
  }), (error) => error.statusCode === 401);
  assert.equal(signed, false);
});
test("revoked sessions fail authorization and access-token-only refresh is retired", async (t) => {
  const previous = process.env.JWT_STRING;
  process.env.JWT_STRING = "test-only-session-secret";
  t.after(() => { if (previous === undefined) delete process.env.JWT_STRING; else process.env.JWT_STRING = previous; });
  const token = signSessionToken({ id: "member_owner", sessionVersion: 0, roles: ["member"] });
  const user = { id: "member_owner", sessionVersion: 1, roles: ["member"] };
  const req = { headers: { authorization: `Bearer ${token}` } };
  let error;
  await createAuthMiddleware({ findAccount: async () => user })(req, {}, (value) => { error = value; });
  assert.equal(error.statusCode, 401);
  t.mock.method(User, "findOne", async () => user);
  t.mock.method(AlumniUser, "findOne", async () => null);
  let status, body;
  await refreshToken(req, { status: (value) => { status = value; return { json: (value) => { body = value; } }; } }, () => {});
  assert.equal(status, 410); assert.equal(body.token, undefined); assert.equal(body.refreshToken, undefined);
});
test("Google credentials and challenge secrets are redacted from request/response logs", () => {
  assert.deepEqual(redactSensitive({ credential: "google-token", nonce: "nonce", proof: "proof", challengeId: "id", password: "password", nested: { Authorization: "Bearer token" } }), {
    credential: "<redacted>", nonce: "<redacted>", proof: "<redacted>", challengeId: "<redacted>", password: "<redacted>", nested: { Authorization: "<redacted>" },
  });
});
test("Google reauthentication attempts have a durable per-account cap", async () => {
  let count = 0;
  const limits = { findOneAndUpdate: async () => ({ count: ++count }) };
  for (let i = 0; i < 5; i++) await limitGoogleRequests("account:owner", 5, { limits, now });
  await assert.rejects(limitGoogleRequests("account:owner", 5, { limits, now }), (error) => error.statusCode === 429);
});
