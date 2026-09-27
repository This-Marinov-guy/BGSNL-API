import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { validationResult } from "express-validator";
import { passkeyRelyingParty, requirePasskeyOrigin, preparePasskey, registerPasskey, authenticatePasskey, removePasskey, listPasskeys, limitPasskeyRequests, PASSKEY_LIMIT } from "../services/authentication/passkeys.js";
import { passkeyCredentialValidators, passkeyRegistrationOptionsValidators, passkeyRemoveValidators } from "../validation/passkey-auth-validators.js";
import mongoose from "mongoose";
import { passkeySchema } from "../models/AccountSecurityFields.js";
const PasskeyCredential = mongoose.model("PasskeySchemaFixture", passkeySchema);
import PasskeyChallenge from "../models/AuthChallenge.js";
import { redactSensitive } from "../middleware/axiom-logger.js";

const origin = "https://www.bulgariansociety.nl";
const rpId = "bulgariansociety.nl";
const proof = "P".repeat(43);
const hash = (value) => createHash("sha256").update(value).digest();
const encode = (value) => Buffer.from(value).toString("base64url");
const clientData = (purpose, challenge, overrides = {}) => encode(JSON.stringify({ type: `webauthn.${purpose}`, origin, challenge, crossOrigin: false, ...overrides }));

// Real P-256 signatures/CBOR authenticators, with in-memory transaction doubles.
// These tests never connect to Mongo, Stripe, Google or a real authenticator.
function harness() {
  const keys = new Map(), requests = new Map();
  const calls = { writes: 0, ends: 0, passwordChecks: 0 };
  const user = { id: "member_test", password: "test-hash", sessionVersion: 0, identityRevision: 0,
    email: "member@example.test", name: "Test", surname: "Member", status: "locked" };
  user.constructor = { findOneAndUpdate: async (query, update) => {
    if (query._id !== user.id || query.password !== user.password ||
      (query.sessionVersion ?? 0) !== user.sessionVersion || ["membership-migrated", "alumni-migrated"].includes(user.status)) return null;
    user.identityRevision++;
    if (update.$inc.sessionVersion) user.sessionVersion += update.$inc.sessionVersion;
    return { ...user };
  } };
  const matches = (item, query) => item && Object.entries(query).every(([key, value]) =>
    key === "expiresAt" ? item.expiresAt > value.$gt : item[key] === value);
  const challenges = {
    create: async (item) => { requests.set(item._id, item); return item; },
    findOne: async (query) => { const item = requests.get(query._id); return matches(item, query) ? item : null; },
    findOneAndDelete: async (query) => { const item = requests.get(query._id); if (!matches(item, query)) return null; requests.delete(query._id); return item; },
  };
  const credentials = {
    find: async (query) => [...keys.values()].filter((item) => matches(item, query)),
    findOne: async (query) => { const item = keys.get(query._id); return matches(item, query) ? { ...item } : null; },
    countDocuments: (query) => ({ session: async () => [...keys.values()].filter((item) => matches(item, query)).length }),
    create: async ([item]) => {
      if (keys.has(item._id)) throw Object.assign(new Error("Duplicate"), { code: 11000 });
      const stored = { ...item, revision: 0, createdAt: new Date() };
      const error = new PasskeyCredential(stored).validateSync(); if (error) throw error;
      keys.set(item._id, stored); calls.writes++;
    },
    findOneAndUpdate: async (query, update) => {
      const item = keys.get(query._id); if (!matches(item, query)) return null;
      Object.assign(item, update.$set); item.revision++; return item;
    },
    deleteOne: async (query) => { const item = keys.get(query._id); return { deletedCount: matches(item, query) && keys.delete(query._id) ? 1 : 0 }; },
  };
  let tail = Promise.resolve();
  const session = {
    withTransaction: async (run) => {
      const previous = tail; let release; tail = new Promise((resolve) => { release = resolve; });
      await previous;
      const keySnapshot = [...keys].map(([id, item]) => [id, { ...item }]);
      const requestSnapshot = [...requests]; const userSnapshot = { ...user };
      try { return await run(); }
      catch (error) {
        keys.clear(); for (const [id, item] of keySnapshot) keys.set(id, item);
        requests.clear(); for (const [id, item] of requestSnapshot) requests.set(id, item);
        Object.assign(user, userSnapshot); throw error;
      } finally { release(); }
    },
    endSession: async () => { calls.ends++; },
  };
  const dependencies = { lock: async () => {}, credentials, challenges, startSession: async () => session,
    verifyPassword: async (account, password) => { calls.passwordChecks++; assert.equal(account, user); if (password !== "correct-password") throw new Error("Wrong password"); },
    findAccount: async (id) => id === user.id ? user : null };
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  const publicKey = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]])));
  const credentialId = randomBytes(32);
  const registration = (challenge, { flags = 0x45, rp = rpId, client = {} } = {}) => {
    const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
    const data = Buffer.concat([hash(rp), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), length, credentialId, publicKey]);
    return { id: encode(credentialId), rawId: encode(credentialId), type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: clientData("create", challenge, client), transports: ["internal"],
      attestationObject: encode(isoCBOR.encode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(data)]]))),
    } };
  };
  const assertion = (challenge, { flags = 0x05, rp = rpId, counter = 1, client = {}, signature, handle } = {}) => {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    const data = Buffer.concat([hash(rp), Buffer.from([flags]), count]);
    const json = clientData("get", challenge, client);
    return { id: encode(credentialId), rawId: encode(credentialId), type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: json, authenticatorData: encode(data),
      signature: signature || encode(sign("sha256", Buffer.concat([data, hash(Buffer.from(json, "base64url"))]), keyPair.privateKey)),
      userHandle: handle ?? keys.get(encode(credentialId))?.userHandle,
    } };
  };
  const prepare = (purpose, more = {}) => preparePasskey({ purpose, origin, proof, user, password: "correct-password", name: "My phone", ...more }, dependencies);
  const enroll = async () => {
    const prepared = await prepare("register");
    await registerPasskey({ origin, proof, user, challengeId: prepared.challengeId, credential: registration(prepared.options.challenge) }, dependencies);
    return keys.get(encode(credentialId));
  };
  return { keys, requests, calls, user, dependencies, prepare, registration, assertion, enroll, credentialId };
}

test("RP policy shares apex/www credentials but isolates localhost from production", () => {
  for (const site of [origin, "https://bulgariansociety.nl"]) assert.equal(passkeyRelyingParty(site, "production").rpId, rpId);
  assert.equal(passkeyRelyingParty("http://localhost:3000", "development").rpId, "localhost");
  for (const site of [undefined, "null", "http://www.bulgariansociety.nl", "https://bulgariansociety.nl.evil.test", "https://www.bulgariansociety.nl/", "http://localhost:3000"]) {
    assert.throws(() => passkeyRelyingParty(site, "production"), { statusCode: 403 });
  }
});
test("mutations reject form posts and missing/untrusted origins", () => {
  for (const [site, json] of [[origin, true], [origin, false], ["https://attacker.test", true], [undefined, true]]) {
    let error;
    requirePasskeyOrigin({ headers: { origin: site }, is: () => json }, {}, (value) => { error = value; });
    assert.equal(Boolean(error), site !== origin || !json);
  }
});
test("registration requires password confirmation, resident credentials and user verification", async () => {
  const h = harness();
  await assert.rejects(h.prepare("register", { password: "wrong" }), /Wrong password/);
  assert.equal(h.requests.size, 0);
  const response = await h.prepare("register");
  assert.equal(response.options.rp.id, rpId); assert.equal(response.options.attestation, "none");
  assert.equal(response.options.authenticatorSelection.residentKey, "required");
  assert.equal(response.options.authenticatorSelection.userVerification, "required");
  const stored = h.requests.get(response.challengeId);
  assert.notEqual(stored.proofHash, proof); assert.notEqual(stored.passwordHash, h.user.password);
  assert.equal(stored.password, undefined); assert.equal(stored.origin, origin);
});
test("login options are account-independent and never look up an email", async () => {
  const h = harness(); h.dependencies.credentials.find = () => { throw new Error("Account lookup"); };
  const response = await h.prepare("login", { user: undefined });
  assert.deepEqual(response.options.allowCredentials, []); assert.equal(response.options.userVerification, "required");
  assert.equal(response.options.rpId, rpId); assert.equal(h.calls.passwordChecks, 0);
  assert.equal(h.requests.get(response.challengeId).accountId, undefined);
});
test("real registration stores only a public credential and then signs in with a real P-256 signature", async () => {
  const h = harness(); const key = await h.enroll();
  assert.ok(Buffer.isBuffer(key.publicKey)); assert.equal(key.accountId, h.user.id); assert.equal(key.name, "My phone");
  assert.equal(key.privateKey, undefined); assert.equal(h.requests.size, 0);
  const response = await h.prepare("login");
  const account = await authenticatePasskey({ origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge) }, h.dependencies);
  assert.equal(account.id, h.user.id); assert.equal(account.status, "locked");
  assert.equal(key.counter, 1); assert.equal(key.revision, 1); assert.ok(key.lastUsedAt); assert.equal(h.requests.size, 0);
});
for (const [label, change] of [
  ["wrong origin", { client: { origin: "https://attacker.test" } }], ["wrong RP", { rp: "attacker.test" }],
  ["wrong challenge", { client: { challenge: "wrong" } }], ["missing verification", { flags: 0x41 }],
  ["cross-origin iframe", { client: { crossOrigin: true } }], ["unexpected top origin", { client: { topOrigin: origin } }],
]) {
  test(`registration rejects ${label} without storing a credential`, async () => {
    const h = harness(); const response = await h.prepare("register");
    await assert.rejects(registerPasskey({ origin, proof, user: h.user, challengeId: response.challengeId, credential: h.registration(response.options.challenge, change) }, h.dependencies), { statusCode: 401 });
    assert.equal(h.keys.size, 0);
  });
}
for (const [label, change] of [
  ["wrong origin", { client: { origin: "https://attacker.test" } }], ["wrong RP", { rp: "attacker.test" }],
  ["wrong challenge", { client: { challenge: "wrong" } }], ["missing verification", { flags: 1 }],
  ["missing user presence", { flags: 4 }], ["forged signature", { signature: encode(randomBytes(64)) }],
  ["wrong user handle", { handle: "another-account" }], ["cross-origin iframe", { client: { crossOrigin: true } }],
]) {
  test(`authentication rejects ${label}`, async () => {
    const h = harness(); await h.enroll(); const response = await h.prepare("login");
    await assert.rejects(authenticatePasskey({ origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge, change) }, h.dependencies), { statusCode: 401 });
    assert.equal([...h.keys.values()][0].counter, 0);
  });
}
test("a login challenge succeeds exactly once under simultaneous submissions", async () => {
  const h = harness(); await h.enroll(); const response = await h.prepare("login");
  const input = { origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge) };
  const results = await Promise.allSettled([authenticatePasskey(input, h.dependencies), authenticatePasskey(input, h.dependencies)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  await assert.rejects(authenticatePasskey(input, h.dependencies), { statusCode: 409 });
});
test("registration challenges cannot be reused to add a second key", async () => {
  const h = harness(); const response = await h.prepare("register");
  const input = { origin, proof, user: h.user, challengeId: response.challengeId, credential: h.registration(response.options.challenge) };
  await registerPasskey(input, h.dependencies);
  await assert.rejects(registerPasskey(input, h.dependencies), { statusCode: 409 });
});
for (const label of ["proof", "origin", "purpose", "expiry"]) {
  test(`login rejects a challenge with wrong ${label}`, async () => {
    const h = harness(); await h.enroll(); const response = await h.prepare("login");
    const stored = h.requests.get(response.challengeId);
    if (label === "purpose") stored.purpose = "register";
    if (label === "expiry") stored.expiresAt = new Date(0);
    await assert.rejects(authenticatePasskey({ origin: label === "origin" ? "https://bulgariansociety.nl" : origin,
      proof: label === "proof" ? "X".repeat(43) : proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge) }, h.dependencies), { statusCode: 409 });
  });
}
for (const field of ["id", "password", "sessionVersion"]) {
  test(`registration is invalid after account ${field} changes`, async () => {
    const h = harness(); const response = await h.prepare("register");
    h.user[field] = field === "sessionVersion" ? 1 : "changed";
    await assert.rejects(registerPasskey({ origin, proof, user: h.user, challengeId: response.challengeId, credential: h.registration(response.options.challenge) }, h.dependencies), { statusCode: 409 });
    assert.equal(h.keys.size, 0);
  });
}
test("a session revoked during cryptographic verification cannot authenticate", async () => {
  const h = harness(); await h.enroll(); const response = await h.prepare("login");
  h.dependencies.findAccount = async () => ({ ...h.user });
  h.dependencies.verify = async () => { h.user.sessionVersion++; return { verified: true, authenticationInfo: { newCounter: 1, credentialBackedUp: false } }; };
  await assert.rejects(authenticatePasskey({ origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge) }, h.dependencies), { statusCode: 409 });
});
test("removed credentials and missing accounts cannot sign in", async () => {
  const h = harness(); await h.enroll(); const response = await h.prepare("login");
  const input = { origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge) };
  h.dependencies.findAccount = async () => null;
  await assert.rejects(authenticatePasskey(input, h.dependencies), { statusCode: 401 });
  h.keys.clear(); await assert.rejects(authenticatePasskey(input, h.dependencies), { statusCode: 401 });
});
test("synced credentials support zero counters while still advancing revision", async () => {
  const h = harness(); const key = await h.enroll();
  for (let i = 0; i < 2; i++) {
    const response = await h.prepare("login");
    await authenticatePasskey({ origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge, { counter: 0 }) }, h.dependencies);
  }
  assert.equal(key.counter, 0); assert.equal(key.revision, 2);
});
test("non-increasing nonzero counters are rejected", async () => {
  const h = harness(); const key = await h.enroll(); key.counter = 3;
  const response = await h.prepare("login");
  await assert.rejects(authenticatePasskey({ origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge, { counter: 3 }) }, h.dependencies), { statusCode: 401 });
});
test("a deleted key cannot be resurrected between verification and transaction", async () => {
  const h = harness(); await h.enroll(); const response = await h.prepare("login");
  h.dependencies.verify = async () => { h.keys.clear(); return { verified: true, authenticationInfo: { newCounter: 1, credentialBackedUp: false } }; };
  await assert.rejects(authenticatePasskey({ origin, proof, challengeId: response.challengeId, credential: h.assertion(response.options.challenge) }, h.dependencies), { statusCode: 409 });
  assert.equal(h.keys.size, 0);
});
test("removal requires password and ownership, and revokes sessions only on success", async () => {
  const h = harness(); const key = await h.enroll();
  await assert.rejects(removePasskey({ user: h.user, password: "wrong", credentialId: key._id }, h.dependencies), /Wrong password/);
  await assert.rejects(removePasskey({ user: h.user, password: "correct-password", credentialId: "other-person-key" }, h.dependencies), { statusCode: 404 });
  assert.equal(h.user.sessionVersion, 0); assert.equal(h.keys.size, 1);
  const account = await removePasskey({ user: h.user, password: "correct-password", credentialId: key._id }, h.dependencies);
  assert.equal(account.sessionVersion, 1); assert.equal(h.keys.size, 0); assert.equal(h.user.password, "test-hash");
});
test("duplicate credential IDs cannot be claimed by another account", async () => {
  const h = harness(); const key = await h.enroll(); key.accountId = "another-owner";
  const response = await h.prepare("register");
  await assert.rejects(registerPasskey({ origin, proof, user: h.user, challengeId: response.challengeId, credential: h.registration(response.options.challenge) }, h.dependencies), { statusCode: 409 });
  assert.equal(h.keys.get(key._id).accountId, "another-owner");
});
test("maximum passkey count is enforced both before and inside the write transaction", async () => {
  const h = harness(); const response = await h.prepare("register");
  for (let i = 0; i < PASSKEY_LIMIT; i++) h.keys.set(String(i), { _id: String(i), accountId: h.user.id, rpId });
  await assert.rejects(h.prepare("register"), { statusCode: 409 });
  await assert.rejects(registerPasskey({ origin, proof, user: h.user, challengeId: response.challengeId, credential: h.registration(response.options.challenge) }, h.dependencies), { statusCode: 409 });
  assert.equal(h.keys.size, PASSKEY_LIMIT);
});
test("new passkeys preserve the original user handle after member/alumni migration", async () => {
  const h = harness(); const key = await h.enroll(); const originalHandle = key.userHandle;
  key.accountId = h.user.id = "alumni_migrated";
  const response = await h.prepare("register");
  assert.equal(response.options.user.id, originalHandle);
  assert.equal(response.options.excludeCredentials[0].id, key._id);
  const login = await h.prepare("login");
  const account = await authenticatePasskey({ origin, proof, challengeId: login.challengeId, credential: h.assertion(login.options.challenge) }, h.dependencies);
  assert.equal(account.id, "alumni_migrated");
});
test("settings expose only labels, dates and credential IDs, never public key material or user handles", async () => {
  const h = harness(); await h.enroll(); const listed = await listPasskeys(h.user, h.dependencies);
  assert.equal(listed.length, 1); assert.deepEqual(Object.keys(listed[0]).sort(), ["createdAt", "id", "lastUsedAt", "name", "rpId"]);
});
test("rate limits fail closed and recover safely from an upsert race", async () => {
  await assert.rejects(limitPasskeyRequests("ip:test", 5, { limits: { findOneAndUpdate: async () => ({ count: 6 }) } }), { statusCode: 429 });
  await assert.rejects(limitPasskeyRequests("ip:test", 5, { limits: { findOneAndUpdate: async () => null } }), { statusCode: 429 });
  let attempts = 0;
  await limitPasskeyRequests("account:test", 5, { limits: { findOneAndUpdate: async (query, _update, options) => {
    assert.ok(!query._id.includes("account:test")); attempts++;
    if (options.upsert) throw Object.assign(new Error("Duplicate"), { code: 11000 });
    return { count: 2 };
  } } });
  assert.equal(attempts, 2);
});
test("credential IDs are globally unique and expired challenges have TTL cleanup", () => {
  assert.equal(PasskeyCredential.schema.path("_id").instance, "String");
  assert.ok(PasskeyChallenge.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});
test("all WebAuthn challenge and response fields are redacted from API logs", () => {
  const fields = ["proof", "challengeId", "challenge", "credential", "publicKey", "userHandle", "clientDataJSON", "authenticatorData", "signature", "attestationObject"];
  const input = { options: Object.fromEntries(fields.map((field) => [field, "private-value"])) };
  assert.ok(Object.values(redactSensitive(input).options).every((value) => value === "<redacted>"));
});
test("validators accept library-shaped responses and reject objects, oversized data and missing user handles", async () => {
  const h = harness(); await h.enroll(); const prepared = await h.prepare("login");
  const credential = h.assertion(prepared.options.challenge);
  const valid = { proof, challengeId: prepared.challengeId, credential };
  const check = async (body, validators) => { const req = { body }; for (const validator of validators) await validator.run(req); return validationResult(req).isEmpty(); };
  assert.ok(await check(valid, passkeyCredentialValidators("login")));
  for (const changed of [null, { ...credential, id: { $ne: "" } }, { ...credential, rawId: "other" },
    { ...credential, response: { ...credential.response, signature: "A".repeat(2049) } },
    { ...credential, response: { ...credential.response, userHandle: null } }]) {
    assert.equal(await check({ ...valid, credential: changed }, passkeyCredentialValidators("login")), false);
  }
  assert.equal(await check({ password: "correct", credentialId: { $ne: null } }, passkeyRemoveValidators), false);
  assert.equal(await check({ proof, password: "correct", name: "a".repeat(61) }, passkeyRegistrationOptionsValidators), false);
});
