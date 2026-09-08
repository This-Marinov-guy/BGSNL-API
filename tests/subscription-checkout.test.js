import assert from "node:assert/strict";
import test from "node:test";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { reserveCheckout, startMembershipChange, membershipPrices } from "../services/subscriptions/checkout.js";

const checkoutHarness = () => {
  const record = { data: {} };
  const calls = [];
  let failOnce = false;
  let existingSubscriptions = [];
  const user = { id: "member_owner", email: "owner@example.test", subscription: {}, save: async () => {} };
  const stripe = {
    customers: { create: async () => ({ id: "cus_verified" }) },
    subscriptions: { list: () => (async function* () { for (const sub of existingSubscriptions) yield sub; })() },
    checkout: { sessions: {
      retrieve: async (id) => ({ id, status: "open", url: "https://checkout.stripe.com/test-session" }),
      create: async (data, options) => {
        calls.push(structuredClone({ data, options }));
        if (failOnce) { failOnce = false; throw new Error("Network interrupted after Stripe accepted the request"); }
        return { id: "cs_only_one", url: "https://checkout.stripe.com/test-session" };
      },
    } },
  };
  const records = { updateOne: async (_query, update) => {
    for (const [key, value] of Object.entries(update.$set || {})) {
      if (key === "data.sessionId") record.data.sessionId = value;
      else record[key] = value;
    }
    for (const key of Object.keys(update.$unset || {})) delete record[key];
  } };
  const dependencies = { stripe, records, withLease: async (_key, work) => work({ record, assertOwned: async () => {} }) };
  const options = { key: "account-checkout:member_owner", user, plan: MEMBERSHIP_PLANS[0], region: "netherlands", returnUrl: "https://bulgariansociety.nl", dependencies };
  return { record, calls, user, options, reserve: () => reserveCheckout(options), failNext: () => { failOnce = true; },
    setSubscriptions: (subs) => { existingSubscriptions = subs; } };
};

test("repeated checkout requests reuse the same open session and verified customer", async () => {
  const h = checkoutHarness();
  const first = await h.reserve(); const second = await h.reserve();
  assert.equal(first.id, second.id); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].data.customer, "cus_verified");
  assert.equal(h.user.subscription.customerId, "cus_verified");
  assert.deepEqual(h.calls[0].data.metadata, { method: "membership_checkout", checkoutKey: "account-checkout:member_owner" });
  assert.equal(h.calls[0].data.line_items[0].price, MEMBERSHIP_PLANS[0].priceId);
});
test("ambiguous network failures replay the identical Stripe idempotency key and request", async () => {
  const h = checkoutHarness(); h.failNext();
  await assert.rejects(h.reserve(), /Network interrupted/);
  await h.reserve();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0], h.calls[1]);
});
test("a second plan cannot replace an in-flight or open checkout", async () => {
  const h = checkoutHarness(); h.failNext();
  await assert.rejects(h.reserve());
  await assert.rejects(reserveCheckout({ ...h.options, plan: MEMBERSHIP_PLANS[1] }), (error) => error.statusCode === 409);
  await h.reserve();
  await assert.rejects(reserveCheckout({ ...h.options, plan: MEMBERSHIP_PLANS[1] }), (error) => error.statusCode === 409);
});
test("past-due, active, paused and incomplete subscriptions all prevent a second checkout", async () => {
  for (const status of ["past_due", "active", "paused", "incomplete", "unpaid"]) {
    const h = checkoutHarness(); h.setSubscriptions([{ id: "sub_existing", status }]);
    await assert.rejects(h.reserve(), (error) => error.statusCode === 409);
    assert.equal(h.calls.length, 0);
  }
});
test("all running-plan changes go to portal review and never create a new checkout", async () => {
  const user = { id: "member_owner", status: "active", subscription: { id: "sub_existing", status: "active", customerId: "cus_owner" } };
  const reviewed = [];
  const dependencies = { reconcile: async () => ({ user }),
    openPortal: async (owner, options) => { assert.equal(owner.subscription.id, "sub_existing"); reviewed.push(options); return { url: "https://billing.stripe.com/test" }; },
    checkout: async () => { throw new Error("A running subscription must not create another checkout"); },
  };
  for (const plan of MEMBERSHIP_PLANS) await startMembershipChange(user, { priceId: plan.priceId, returnUrl: "https://bulgariansociety.nl", dependencies });
  assert.equal(reviewed.length, MEMBERSHIP_PLANS.length);
  await startMembershipChange(user, { priceId: "alumni_free", dependencies });
  assert.equal(reviewed.at(-1).action, "cancel"); assert.equal(reviewed.at(-1).freeAlumni, true);
});
test("unsupported client prices fail before any billing operation", async () => {
  await assert.rejects(startMembershipChange({}, { priceId: "price_client_invented" }), (error) => error.statusCode === 422);
});

test("the Stripe catalog must use the configured recurring EUR periods", async () => {
  const retrieve = async (id) => {
    const plan = MEMBERSHIP_PLANS.find((item) => item.priceId === id);
    return { active: true, currency: "eur", unit_amount: 600, product: "prod_membership",
      recurring: { interval: plan.period === 12 ? "year" : "month", interval_count: plan.period === 12 ? 1 : plan.period } };
  };
  assert.equal((await membershipPrices({ prices: { retrieve } })).length, 6);
  for (const overrides of [{ currency: "usd" }, { active: false }, { recurring: { interval: "day", interval_count: 1 } }, { unit_amount: null }]) {
    await assert.rejects(membershipPrices({ prices: { retrieve: async (id) => ({ ...await retrieve(id), ...overrides }) } }));
  }
});
