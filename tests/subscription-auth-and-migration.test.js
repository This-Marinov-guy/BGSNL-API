import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";
import BillingRecord from "../models/BillingRecord.js";
import AccountIdentity from "../models/AccountIdentity.js";
import { createAuthMiddleware, requireBenefits } from "../middleware/authorization.js";
import { persistSubscriptionAccount } from "../services/subscriptions/accounts.js";
import { withBillingLease } from "../services/subscriptions/lease.js";
import { findUserById } from "../services/main-services/user-service.js";

test("signed but outdated JWT roles, customer and status are replaced with current account data", async (t) => {
  const previous = process.env.JWT_STRING;
  process.env.JWT_STRING = "subscription-tests-only-not-a-real-secret";
  t.after(() => { if (previous === undefined) delete process.env.JWT_STRING; else process.env.JWT_STRING = previous; });
  const account = { id: "alumni_current", email: "owner@example.test", status: "locked", roles: ["alumni"], tier: 3, subscription: { customerId: "cus_current" } };
  const token = jwt.sign({ userId: "member_old", version: Number(process.env.AUTH_VERSION ?? 1), roles: ["super_admin", "member"], status: "active", customerId: "cus_forged" }, process.env.JWT_STRING);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const auth = createAuthMiddleware({ findAccount: async (id) => { assert.equal(id, "member_old"); return account; } });
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
  const identityOwners = [];
  t.mock.method(AccountIdentity, "updateMany", async (query, update, options) => {
    assert.ok(query.accountId.$in.includes("member_original"));
    identityOwners.push(update.$set.accountId);
    assert.equal(options.session, session);
  });
  for (const Model of [User, AlumniUser]) {
    const store = documents[Model.modelName];
    t.mock.method(Model, "findById", (id) => ({ session: async () => store.get(String(id)) }));
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
    subscription: { id: "sub_same", customerId: "cus_same", stripeRegion: "netherlands", period: 6 },
  });
  documents.User.set(source.id, source);
  source.sessionVersion = 2;
  source.identityRevision = 4;
  const archivedAlumni = new AlumniUser({ ...source.toObject(), _id: "alumni_archived", roles: ["alumni"], tier: 0, status: "membership-migrated", sessionVersion: 0 });
  documents.AlumniUser.set(archivedAlumni.id, archivedAlumni);
  const verifiedSessions = [];
  const owned = async (value) => verifiedSessions.push(value);
  const alumni = await persistSubscriptionAccount(source, { status: "active", subscription: source.subscription.toObject() }, { type: "alumni", tier: 4 }, owned);
  assert.equal(alumni.constructor.modelName, "AlumniUser"); assert.equal(alumni.tier, 4);
  assert.equal(alumni.id, "alumni_archived"); assert.equal(source.status, "membership-migrated");
  assert.equal(alumni.birth.toISOString(), "2000-01-01T00:00:00.000Z");
  assert.ok(alumni.roles.includes("admin")); assert.ok(alumni.accountAliases.includes(source.id));
  alumni.email = "updated@example.test";
  const member = await persistSubscriptionAccount(alumni, { status: "active", subscription: alumni.subscription.toObject() }, { type: "member", period: 12 }, owned);
  assert.equal(member.constructor.modelName, "User"); assert.equal(member.id, "member_original");
  assert.equal(member.email, "updated@example.test");
  assert.equal(member.sessionVersion, 2);
  assert.equal(member.identityRevision, 4);
  assert.deepEqual(identityOwners, ["alumni_archived", "member_original"]);
  assert.equal(alumni.status, "membership-migrated");
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
test("distributed billing lease blocks a concurrent worker and releases only its own lock", async (t) => {
  const state = { leaseUntil: new Date(0) };
  t.mock.method(BillingRecord, "updateOne", async (query, update) => {
    if (query.owner && query.owner !== state.owner) return { matchedCount: 0 };
    if (query.leaseUntil?.$gt && state.leaseUntil <= query.leaseUntil.$gt) return { matchedCount: 0 };
    Object.assign(state, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete state[key];
    return { matchedCount: 1 };
  });
  t.mock.method(BillingRecord, "findOneAndUpdate", async (_query, update) => {
    if (state.leaseUntil > new Date()) return null;
    Object.assign(state, update.$set); return { ...state };
  });
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withBillingLease("test-subscription", async ({ assertOwned }) => { entered(); await gate; await assertOwned(); });
  await started;
  await assert.rejects(withBillingLease("test-subscription", async () => {}), (error) => error.statusCode === 409);
  release(); await first;
  assert.equal(state.owner, undefined); assert.equal(state.leaseUntil.getTime(), 0);
});
