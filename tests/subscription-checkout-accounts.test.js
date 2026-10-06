import test from "node:test";
import assert from "node:assert/strict";
import { resolveCheckoutAccount } from "../services/subscriptions/checkout-account.js";
import { completeMembershipCheckout } from "../services/subscriptions/checkout.js";
import { completeLegacyMembership } from "../controllers/Webhooks/stripe-wh-controllers.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import MemberUser from "../models/MemberUser.js";
import AlumniUser from "../models/AlumniUser.js";
import { findBillingAccount } from "../services/subscriptions/accounts.js";

const identity = { subscriptionId: "sub_new", customerId: "cus_owner", email: "owner@example.test" };
const memberPlan = MEMBERSHIP_PLANS.find((plan) => plan.type === "member");
const alumniPlan = MEMBERSHIP_PLANS.find((plan) => plan.type === "alumni");
const existing = (type) => ({ id: `${type}_owner`, roles: [type], status: "active", password: "existing-hash", subscription: { customerId: "cus_owner" } });
const lookup = (overrides = {}) => ({ findAccount: async () => null, findById: async () => null, findByEmail: async () => null, ...overrides });

test("checkout resolves replayed subscriptions before signup email, including after migration", async () => {
  const alumni = { ...existing("alumni"), subscription: { id: "sub_new", customerId: "cus_owner" } };
  const result = await resolveCheckoutAccount(identity, lookup({ findAccount: async (query) => query["subscription.id"] ? alumni : null,
    findByEmail: async () => { throw new Error("A replay must not use a stale signup email"); } }));
  assert.equal(result, alumni);
});

test("both programmes can reuse a verified customer or saved authenticated account", async () => {
  for (const type of ["member", "alumni"]) {
    const user = existing(type);
    assert.equal(await resolveCheckoutAccount(identity, lookup({ findAccount: async (query) => query["subscription.customerId"] ? user : null })), user);
    assert.equal(await resolveCheckoutAccount({ ...identity, userId: user.id }, lookup({ findById: async () => user })), user);
    assert.equal(await resolveCheckoutAccount(identity, lookup({ findByEmail: async () => user })), user);
  }
  assert.equal(await resolveCheckoutAccount(identity, lookup()), null);
});

test("email alone, missing authenticated accounts and conflicting owners fail closed", async () => {
  await assert.rejects(resolveCheckoutAccount({ ...identity, customerId: undefined }, lookup()), /missing its Stripe billing identity/);
  await assert.rejects(resolveCheckoutAccount(identity, lookup({ findByEmail: async () => ({ ...existing("member"), subscription: {} }) })), /sign in/);
  await assert.rejects(resolveCheckoutAccount({ ...identity, userId: "member_missing" }, lookup()), /no longer exists/);
  await assert.rejects(resolveCheckoutAccount(identity, lookup({ findAccount: async () => ({ subscription: { customerId: "cus_other" } }) })), /ownership mismatch/);
  await assert.rejects(resolveCheckoutAccount({ ...identity, userId: "member_other" }, lookup({
    findAccount: async () => existing("alumni"), findById: async () => existing("member"),
  })), /ownership mismatch/);
});

test("ambiguous current member and alumni matches never select one arbitrarily", async (t) => {
  for (const Model of [MemberUser, AlumniUser]) t.mock.method(Model, "findOne", () => ({ session: async () => existing(Model === MemberUser ? "member" : "alumni") }));
  await assert.rejects(findBillingAccount({ email: identity.email }), /Multiple current accounts/);
});

function completionHarness(plan, user) {
  let currentUser = user;
  const record = { data: { sessionId: "cs_checkout", customerId: "cus_owner", stripeRegion: "netherlands", priceId: plan.priceId,
    ...(user ? { userId: user.id } : { registration: { email: identity.email, name: "Test", surname: "Person", image: "avatar.png",
      phone: "+31600000000", university: "University", password: "$2b$12$" + "a".repeat(53) } }) } };
  const session = { id: "cs_checkout", mode: "subscription", status: "complete", subscription: "sub_new", customer: "cus_owner", metadata: { checkoutKey: "checkout_test" } };
  const calls = { created: [], updated: [], reconciled: [], notices: [] };
  const readSubscription = async () => ({ sub: { id: "sub_new", customer: "cus_owner", created: Date.parse("2026-10-03T11:39:12Z") / 1000 }, state: { plan, hasBenefits: true, periodEnd: 1900000000 } });
  const dependencies = {
    withLease: async (_key, run) => run({ record, assertOwned: async () => {} }),
    records: { updateOne: async () => { record.completedAt = new Date(); } },
    stripeClient: () => ({}), readSubscription, readRevenueAllocation: async () => null,
    resolveAccount: async () => currentUser,
    createAccount: async (account) => { calls.created.push(account); currentUser = account; return account; },
    persistAccount: async (account, fields) => { calls.updated.push({ account, fields }); account.subscription = fields.subscription; currentUser = account; return account; },
    reconcile: async (...args) => { calls.reconciled.push(args); return { user: currentUser }; },
    reconcileExisting: async () => ({ user, state: { ended: false } }),
    notifyMember: () => calls.notices.push("member"), notifyAlumni: () => calls.notices.push("alumni"),
  };
  return { calls, record, session, dependencies, complete: () => completeMembershipCheckout(session, "netherlands", dependencies) };
}

test("stale checkout completion does not hide a paid replacement subscription", async () => {
  const user = existing("member");
  user.subscription.id = "sub_canceled";
  const h = completionHarness(memberPlan, user);
  h.record.completedAt = new Date("2026-10-03T11:38:50Z");
  h.dependencies.reconcileExisting = async () => ({ user, state: { ended: true } });
  await h.complete();
  assert.equal(h.calls.updated.length, 1);
  assert.equal(h.calls.updated[0].fields.subscription.id, "sub_new");
  assert.deepEqual(h.calls.reconciled[0], ["sub_new", "netherlands", { expectedCustomerId: "cus_owner" }]);
});

test("checkout completion fails closed when reconciliation cannot find the paid account", async () => {
  const h = completionHarness(memberPlan, existing("member"));
  h.dependencies.reconcile = async () => null;
  await assert.rejects(h.complete(), /not linked to its account/);
});

test("membership checkout without a usable subscription cannot be marked fulfilled", async () => {
  const h = completionHarness(memberPlan, existing("member"));
  h.session.subscription = null;
  await assert.rejects(h.complete(), /Invalid membership checkout completion/);
  assert.equal(h.calls.updated.length, 0);
});

test("replayed older checkout cannot replace a later subscription", async () => {
  const user = existing("member");
  user.subscription.id = "sub_later_canceled";
  const h = completionHarness(memberPlan, user);
  h.record.completedAt = new Date("2026-10-03T11:40:00Z");
  h.dependencies.reconcileExisting = async () => ({ user, state: { ended: true } });
  await assert.rejects(h.complete(), /manual review required/);
  assert.equal(h.calls.updated.length, 0);
});

test("new checkout accounts are created in the chosen programme and replays do not duplicate them", async () => {
  for (const plan of [memberPlan, alumniPlan]) {
    const h = completionHarness(plan, null);
    await h.complete(); await h.complete();
    assert.equal(h.calls.created.length, 1);
    assert.equal(h.calls.created[0].constructor.modelName, plan.type === "alumni" ? "AlumniUser" : "MemberUser");
    assert.equal(h.calls.created[0].status, "payment_awaiting");
    assert.deepEqual(h.calls.notices, [plan.type]);
    assert.equal(h.calls.reconciled.length, 2);
  }
});

test("same-type and cross-type checkout reuse the account and reconcile instead of creating duplicates", async () => {
  for (const type of ["member", "alumni"]) for (const plan of [memberPlan, alumniPlan]) {
    const user = existing(type), h = completionHarness(plan, user);
    await h.complete();
    assert.equal(h.calls.created.length, 0);
    assert.equal(h.calls.updated[0].account, user);
    assert.equal(h.calls.updated[0].fields.subscription.id, "sub_new");
    assert.equal(user.password, "existing-hash");
    assert.equal(h.calls.notices.length, 0);
    assert.deepEqual(h.calls.reconciled[0], ["sub_new", "netherlands", { expectedCustomerId: "cus_owner" }]);
  }
});

test("checkout never replaces a running subscription and only rebinds an ended one", async () => {
  const user = existing("member"); user.subscription.id = "sub_old";
  const h = completionHarness(alumniPlan, user);
  await assert.rejects(h.complete(), /existing subscription/);
  assert.equal(h.calls.updated.length, 0);
  h.dependencies.reconcileExisting = async () => ({ user, state: { ended: true } });
  await h.complete();
  assert.equal(h.calls.updated.length, 1);
});

test("legacy signup checkout updates an existing account, or creates only in the paid plan's table", async () => {
  for (const plan of [memberPlan, alumniPlan]) for (const type of [null, "member", "alumni"]) {
    const user = type ? existing(type) : null;
    const h = completionHarness(plan, user);
    let createdType;
    await completeLegacyMembership({ ...h.session, metadata: { method: "signup", email: identity.email } }, "netherlands", {
      ...h.dependencies,
      signupMember: async () => { createdType = "member"; },
      signupAlumni: async () => { createdType = "alumni"; },
    });
    assert.equal(createdType, user ? undefined : plan.type);
    assert.equal(h.calls.updated.length, user ? 1 : 0);
    assert.equal(h.calls.reconciled.length, 1);
  }
});
