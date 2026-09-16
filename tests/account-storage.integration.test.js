import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { preparePasskey, authenticatePasskey } from "../services/authentication/passkeys.js";
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import MemberUser from "../models/MemberUser.js";
import AlumniUser from "../models/AlumniUser.js";
import TemporaryCode from "../models/TemporaryCode.js";
import AuthChallenge from "../models/AuthChallenge.js";
import ProfileChange from "../models/ProfileChange.js";
import PasswordResetChallenge from "../models/PasswordResetChallenge.js";
import { changeGoogleIdentity } from "../services/authentication/google.js";
import { embeddedIdentities, embeddedPasskeys, lockAccountCredentials } from "../services/authentication/embedded-credentials.js";
import { persistSubscriptionAccount } from "../services/subscriptions/accounts.js";

const uri = process.env.BGSNL_STORAGE_TEST_MONGO;
test("embedded credentials and shared temporary codes in an isolated Mongo replica set", { skip: !uri, timeout: 90000 }, async (t) => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:27028\/bgsnl_storage_test(?:\?|$)/);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  t.after(async () => { await mongoose.disconnect(); });
  // This test only writes its dedicated local database, never the configured app DB.
  assert.equal(mongoose.connection.name, "bgsnl_storage_test");
  await mongoose.connection.dropDatabase();
  for (const Model of [MemberUser, AlumniUser, TemporaryCode, AuthChallenge, ProfileChange, PasswordResetChallenge]) await Model.init();
  for (const Model of [MemberUser, AlumniUser]) await Model.createIndexes();
  await TemporaryCode.collection.updateOne({ _id: "coordination:account-credentials" }, { $set: { revision: 0 } }, { upsert: true });
  const seed = (Model, id) => Model.create({ _id: id, email: "storage-fixture@gmail.com", name: "Storage", surname: "Fixture", password: "fixture-hash",
    image: "fixture.png", expireDate: new Date("2099-01-01"), phone: "fixture", university: "fixture", roles: [Model === MemberUser ? "member" : "alumni"] });
  const member = await seed(MemberUser, "member_storage"), alumni = await seed(AlumniUser, "alumni_other");
  await t.test("simultaneous Google linking across collections permits exactly one owner", async () => {
    const results = await Promise.allSettled([member, alumni].map((user) => changeGoogleIdentity(user, { subject: "google-storage", email: user.email })));
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(await MemberUser.countDocuments({ "identities.subject": "google-storage" }) + await AlumniUser.countDocuments({ "identities.subject": "google-storage" }), 1);
    const identity = await embeddedIdentities.findOne({ provider: "google", subject: "google-storage" });
    assert.ok(identity.accountId);
    const Model = identity.accountId === member.id ? MemberUser : AlumniUser;
    assert.equal((await Model.findById(identity.accountId).lean()).identities, undefined);
    const selected = await Model.findById(identity.accountId).select("+identities");
    assert.equal(selected.toJSON().identities, undefined);
    await changeGoogleIdentity(await Model.findById(identity.accountId));
  });
  await t.test("credential IDs cannot be registered twice, even across account types", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const publicKey = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))], [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]])));
    const add = async (user) => {
      const session = await mongoose.startSession();
      try { await session.withTransaction(async () => {
        await lockAccountCredentials(session);
        await embeddedPasskeys.create([{ _id: "key-storage", accountId: user.id, rpId: "localhost", userHandle: "stable-handle", name: "Fixture", publicKey, counter: 0, deviceType: "multiDevice", backedUp: true }], { session });
      }); } finally { await session.endSession(); }
    };
    const results = await Promise.allSettled([add(member), add(alumni)]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    const key = await embeddedPasskeys.findOne({ _id: "key-storage" });
    assert.ok(Buffer.isBuffer(key.publicKey));
    const owner = await (key.accountId === member.id ? MemberUser : AlumniUser).findById(key.accountId);
    const session = await mongoose.startSession();
    try { await session.withTransaction(async () => {
      const filter = { _id: key._id, accountId: key.accountId, counter: 0, revision: 0 };
      assert.ok(await embeddedPasskeys.findOneAndUpdate(filter, { $set: { counter: 0 }, $inc: { revision: 1 } }, { session }));
      assert.equal(await embeddedPasskeys.findOneAndUpdate(filter, { $inc: { revision: 1 } }, { session }), null);
    }); } finally { await session.endSession(); }
    // Remove the unrelated fixture before moving the account into that collection.
    await (owner.constructor === MemberUser ? AlumniUser : MemberUser).deleteMany({ _id: { $ne: owner.id } });
    const destination = owner.constructor === MemberUser ? "alumni" : "member";
    const migrated = await persistSubscriptionAccount(owner, {}, { type: destination, tier: 0 }, async () => {});
    assert.equal(await owner.constructor.countDocuments({ _id: owner.id }), 0);
    assert.equal(migrated.passkeys[0].userHandle, "stable-handle");
    assert.equal(migrated.passkeys[0].revision, 1);
    assert.ok(migrated.accountAliases.includes(owner.id));
    assert.equal((await embeddedPasskeys.findOne({ _id: key._id })).accountId, migrated.id);
    const proof = "P".repeat(43), origin = "http://localhost:3000";
    const prepared = await preparePasskey({ purpose: "login", origin, proof });
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", origin, challenge: prepared.options.challenge, crossOrigin: false }));
    const counter = Buffer.alloc(4); counter.writeUInt32BE(2);
    const authData = Buffer.concat([createHash("sha256").update("localhost").digest(), Buffer.from([0x05]), counter]);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), pair.privateKey);
    const credential = { id: key._id, rawId: key._id, type: "public-key", clientExtensionResults: {}, response: {
      clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url"), userHandle: "stable-handle",
    } };
    const authenticated = await authenticatePasskey({ origin, proof, challengeId: prepared.challengeId, credential });
    assert.equal(authenticated.id, migrated.id);
    assert.equal((await embeddedPasskeys.findOne({ _id: key._id })).counter, 2);
    await assert.rejects(authenticatePasskey({ origin, proof, challengeId: prepared.challengeId, credential }), { statusCode: 409 });
  });
  await t.test("reset, profile and passkey challenges coexist with namespaced IDs and transactional consumption", async () => {
    const expiresAt = new Date(Date.now() + 60000);
    await PasswordResetChallenge.create({ _id: "same-owner", generation: "reset", codeHash: "hash", passwordDigest: "digest", email: "fixture@test.invalid", attemptsLeft: 5, expiresAt });
    await ProfileChange.create({ _id: "same-owner", generation: "profile", stage: "owner", expiresAt });
    await AuthChallenge.create({ _id: "same-owner", kind: "passkey", purpose: "login", challenge: "challenge", proofHash: "hash", origin: "http://localhost:3000", expiresAt });
    assert.equal((await PasswordResetChallenge.findById("same-owner")).generation, "reset");
    assert.equal((await ProfileChange.findById("same-owner")).generation, "profile");
    assert.equal((await AuthChallenge.findById("same-owner")).kind, "passkey");
    const session = await mongoose.startSession();
    try {
      await assert.rejects(session.withTransaction(async () => { await AuthChallenge.findOneAndDelete({ _id: "same-owner" }, { session }); throw new Error("rollback"); }), /rollback/);
      assert.ok(await AuthChallenge.findById("same-owner"));
    } finally { await session.endSession(); }
    const results = await Promise.all([AuthChallenge.findOneAndDelete({ _id: "same-owner" }), AuthChallenge.findOneAndDelete({ _id: "same-owner" })]);
    assert.equal(results.filter(Boolean).length, 1);
    const collections = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name);
    assert.ok(collections.includes("temporaryCodes"));
    for (const removed of ["accountidentities", "passkeycredentials", "passkeychallenges", "authchallenges", "profilechanges", "passwordresetchallenges"]) assert.equal(collections.includes(removed), false, removed);
  });
});
