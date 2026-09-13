import assert from "node:assert/strict";
import test from "node:test";
import { signSessionToken } from "../util/auth/session-token.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";
import TemporaryCode from "../models/TemporaryCode.js";
import { createAuthMiddleware, requireBenefits } from "../middleware/authorization.js";
import { persistSubscriptionAccount } from "../services/subscriptions/accounts.js";
import { withBillingLease } from "../services/subscriptions/lease.js";
import { findUserById } from "../services/main-services/user-service.js";

test("signed but outdated JWT roles, customer and status are replaced with current account data", async (t) => {
  const previous = process.env.JWT_STRING;
  process.env.JWT_STRING = "subscription-tests-only-not-a-real-secret";
  t.after(() => { if (previous === undefined) delete process.env.JWT_STRING; else process.env.JWT_STRING = previous; });
  const account = { id: "alumni_current", email: "owner@example.test", status: "locked", roles: ["alumni"], tier: 3, subscription: { customerId: "cus_current" } };
  const token = signSessionToken({ id: "member_old", roles: ["super_admin", "member"], status: "active", subscription: { customerId: "cus_forged" } });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const auth = createAuthMiddleware({ validateSession: async () => {}, findAccount: async (id) => { assert.equal(id, "member_old"); return account; } });
  let error;
  await auth(req, { set: () => {} }, (value) => { error = value; });
  assert.equal(error, undefined); // Login and billing are still accessible.
  assert.deepEqual(req.user.roles, ["alumni"]);
  assert.equal(req.user.userId, "alumni_current");
  assert.equal(req.user.customerId, "cus_current");
  assert.equal(req.user.status, "locked");
  assert.equal(req.user.hasBenefits, false);
  await requireBenefits()(req, {}, (value) => { error = value; });
  assert.equal(error.statusCode, 403);
});
test("forged tokens are rejected before any account lookup", async () => {
  let lookedUp = false, error;
  const auth = createAuthMiddleware({ findAccount: async () => { lookedUp = true; } });
  await auth({ headers: { authorization: "Bearer forged.payload.signature" } }, {}, (value) => { error = value; });
  assert.equal(error.statusCode, 401); assert.equal(lookedUp, false);
});
test("legacy account resolution cannot authenticate a different owner of a reused email", async (t) => {
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(User, "findById", async () => ({ id: "member_original", status: "alumni-migrated", email: "reused@example.test" }));
  t.mock.method(AlumniUser, "findOne", async (query) => {
    assert.equal(query.email, undefined);
    if (query._id) assert.equal(query._id, "alumni_original");
    return null;
  });
  assert.equal(await findUserById("member_original"), null);
});
test("legacy paired account IDs remain usable after an email change", async (t) => {
  const current = { id: "alumni_original", email: "updated@example.test" };
  t.mock.method(User, "findOne", async () => null);
  t.mock.method(User, "findById", async () => ({ status: "alumni-migrated", email: "old@example.test" }));
  t.mock.method(AlumniUser, "findOne", async (query) => query._id === current.id ? current : null);
  assert.equal(await findUserById("member_original"), current);
});
test("round-trip migration preserves profile, tickets, documents, aliases and Stripe identity", async (t) => {
  const documents = { User: new Map(), AlumniUser: new Map() };
  const session = { withTransaction: async (run) => run(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  session.inTransaction = () => true;
  t.mock.method(TemporaryCode.collection, "updateOne", async (_query, _update, options) => { assert.equal(options.session, session); });
  for (const Model of [User, AlumniUser]) {
    const store = documents[Model.modelName];
    t.mock.method(Model, "deleteOne", async ({ _id }) => ({ deletedCount: store.delete(String(_id)) ? 1 : 0 }));
    t.mock.method(Model, "findById", (id) => ({ select: () => ({ session: async () => store.get(String(id)) }) }));
    t.mock.method(Model, "findOne", (query) => ({ session: async () => [...store.values()].find((doc) =>
      query.$or.some((clause) => clause.email === doc.email || clause._id?.$in.includes(String(doc._id)) ||
        clause.accountAliases?.$in.some((id) => doc.accountAliases.includes(id)))) }));
    t.mock.method(Model.prototype, "save", async function (options) {
      assert.equal(options.session, session);
      const validation = this.validateSync();
      if (validation) throw validation;
      store.set(String(this._id), this);
      return this;
    });
  }
  const source = new User({ _id: "member_original", status: "active", roles: ["member", "admin"],
    name: "Test", surname: "Person", email: "test@example.test", password: "hashed-password",
    birth: new Date("2000-01-01"), phone: "+31600000000", university: "University", region: "groningen", profession: "Engineer",
    image: "avatar.png", expireDate: new Date("2030-01-01"), documents: [new mongoose.Types.ObjectId()],
    tickets: [{ event: "Saved event", image: "ticket.png" }], internshipApplications: [new mongoose.Types.ObjectId()],
    subscription: { id: "sub_same", customerId: "cus_same", stripeRegion: "netherlands", period: 6, connected: true },
  });
  documents.User.set(source.id, source);
  source.sessionVersion = 2;
  source.campaignsSeen = ["whats-new-2026-09"];
  source.identityRevision = 4;
  source.identities = [{ _id: "identity", provider: "google", subject: "google-one", email: "test@example.test" }];
  source.passkeys = [{ _id: "credential", rpId: "localhost", userHandle: "immutable", publicKey: Buffer.from([1, 2, 3]), counter: 3, revision: 4, name: "Phone", deviceType: "multiDevice", backedUp: true }];
  const archivedAlumni = new AlumniUser({ ...source.toObject(), _id: "alumni_archived", roles: ["alumni"], tier: 0, status: "membership-migrated", sessionVersion: 0 });
  documents.AlumniUser.set(archivedAlumni.id, archivedAlumni);
  archivedAlumni.campaignsSeen = ["previous-alumni-announcement"];
  const verifiedSessions = [];
  const owned = async (value) => verifiedSessions.push(value);
  const alumni = await persistSubscriptionAccount(source, { status: "active", subscription: source.subscription.toObject() }, { type: "alumni", tier: 4 }, owned);
  assert.equal(alumni.subscription.connected, false);
  assert.equal(alumni.constructor.modelName, "AlumniUser"); assert.equal(alumni.tier, 4);
  assert.equal(alumni.id, "alumni_archived"); assert.equal(documents.User.has(source.id), false);
  assert.equal(alumni.birth.toISOString(), "2000-01-01T00:00:00.000Z");
  assert.ok(alumni.roles.includes("admin")); assert.ok(alumni.accountAliases.includes(source.id));
  alumni.email = "updated@example.test";
  const member = await persistSubscriptionAccount(alumni, { status: "active", subscription: { ...alumni.subscription.toObject(), connected: true } }, { type: "member", period: 12 }, owned);
  assert.equal(member.constructor.modelName, "User"); assert.equal(member.id, "member_original");
  assert.equal(member.email, "updated@example.test");
  assert.equal(member.sessionVersion, 2);
  assert.equal(member.identityRevision, 4);
  assert.deepEqual([...member.campaignsSeen].sort(), ["previous-alumni-announcement", "whats-new-2026-09"]);
  assert.equal(member.identities[0].subject, "google-one");
  assert.equal(member.passkeys[0].userHandle, "immutable");
  assert.equal(member.passkeys[0].revision, 4);
  assert.equal(documents.AlumniUser.size, 0);
  assert.equal(member.subscription.connected, true);
  assert.equal(alumni.subscription.connected, false);
  assert.equal(member.subscription.id, "sub_same"); assert.equal(member.subscription.customerId, "cus_same");
  assert.equal(member.profession, "Engineer"); assert.equal(member.tickets.length, 1);
  assert.equal(member.documents.length, 1); assert.equal(member.internshipApplications.length, 1);
  assert.equal(verifiedSessions.length, 2); assert.ok(verifiedSessions.every((value) => value === session));
});
test("a lost lease prevents any account transaction writes", async (t) => {
  const session = { withTransaction: async (run) => run(), endSession: async () => {} };
  t.mock.method(mongoose, "startSession", async () => session);
  let reads = 0;
  t.mock.method(User, "findById", () => { reads++; throw new Error("Unexpected account read"); });
  await assert.rejects(persistSubscriptionAccount(new User(), {}, null, async () => { throw new Error("Lease lost"); }), /Lease lost/);
  assert.equal(reads, 0);
});
test("distributed billing lease blocks a concurrent worker and releases only its own lock", async () => {
  let owner;
  const client = {
    async set(_key, value) { if (owner) return null; owner = value; return "OK"; },
    async eval(script, { arguments: args }) { if (owner !== args[0]) return 0; if (script.includes("'DEL'")) owner = undefined; return 1; },
  };
  const dependencies = { clientFor: async () => client, records: { findById: async () => null }, fences: { updateOne: async () => ({ matchedCount: 1 }) } };
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withBillingLease("test-subscription", async ({ assertOwned }) => { entered(); await gate; await assertOwned(); }, dependencies);
  await started;
  await assert.rejects(withBillingLease("test-subscription", async () => {}, dependencies), { statusCode: 409 });
  release(); await first;
  assert.equal(owner, undefined);
});
