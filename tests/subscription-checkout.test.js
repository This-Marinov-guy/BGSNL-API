import assert from "node:assert/strict";
import test from "node:test";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { reserveCheckout, startMembershipChange, membershipPrices, membershipCheckoutRegion } from "../services/subscriptions/checkout.js";
import { STRIPE_KEYS } from "../util/config/stripe.js";

const checkoutHarness = () => {
  const record = { data: {} };
  const calls = [];
  const customerCreations = [];
  let failOnce = false;
  let existingSubscriptions = [];
  const user = { id: "member_owner", email: "owner@example.test", subscription: {}, save: async () => {} };
  const stripe = {
    customers: { create: async data => { customerCreations.push(data); return { id: "cus_verified" }; } },
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
  const dependencies = { stripe, records, withLease: async (_key, work) => work({ record, assertOwned: async () => {} }),
    prepareReturn: async ({ token, origin }) => ({ id: "verified_receipt", success_url: `${origin}/payment/return?token=${token}`,
      cancel_url: `${origin}/payment/return?token=${token}`, bind: async () => {} }) };
  const options = { key: "account-checkout:member_owner", user, plan: MEMBERSHIP_PLANS[0], region: "netherlands", returnUrl: "https://bulgariansociety.nl", dependencies };
  return { record, calls, customerCreations, user, options, reserve: () => reserveCheckout(options), failNext: () => { failOnce = true; },
    setSubscriptions: (subs) => { existingSubscriptions = subs; } };
};

test("repeated checkout requests reuse the same open session and verified customer", async () => {
  const h = checkoutHarness();
  const first = await h.reserve(); const second = await h.reserve();
  assert.equal(first.id, second.id); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].data.customer, "cus_verified");
  assert.equal(h.user.subscription.customerId, "cus_verified");
  assert.deepEqual(h.calls[0].data.metadata, { method: "membership_checkout", checkoutKey: "account-checkout:member_owner", paymentReturnId: "verified_receipt" });
  assert.equal(h.calls[0].data.line_items[0].price, MEMBERSHIP_PLANS[0].priceId);
});
test("checkout initializes a missing subscription without granting benefits before payment", async () => {
  for (const subscription of [undefined, null]) {
    const h = checkoutHarness();
    h.user.subscription = subscription;
    await h.reserve();
    assert.equal(h.user.subscription.customerId, "cus_verified");
    assert.equal(h.user.subscription.id, undefined);
    assert.equal(h.user.subscription.hasBenefits, undefined);
    assert.equal(h.calls[0].data.mode, "subscription");
    assert.deepEqual(h.calls[0].data.line_items, [{ price: MEMBERSHIP_PLANS[0].priceId, quantity: 1 }]);
    assert.match(h.calls[0].data.success_url, /^https:\/\/bulgariansociety.nl\/payment\/return\?token=[a-f0-9]{64}$/);
    assert.equal(h.calls[0].data.cancel_url, h.calls[0].data.success_url);
  }
});
test("accounts without a subscription can start every allowlisted Member period and Alumni tier", async () => {
  for (const subscription of [undefined, null, {}, { customerId: "cus_existing" }]) {
    for (const plan of MEMBERSHIP_PLANS) {
      const user = { id: "verified_owner", status: "active", subscription };
      const calls = [];
      const result = await startMembershipChange(user, {
        priceId: plan.priceId,
        returnUrl: "https://bulgariansociety.nl",
        dependencies: {
          reconcile: async () => ({ user }),
          openPortal: async () => { throw new Error("New subscriptions should use Checkout"); },
          checkout: async (options) => { calls.push(options); return { url: "https://checkout.stripe.com/test-session" }; },
        },
      });
      assert.equal(result.url, "https://checkout.stripe.com/test-session");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].user, user);
      assert.equal(calls[0].key, "account-checkout:verified_owner");
      assert.deepEqual(calls[0].plan, plan);
    }
  }
});
test("a missing subscription cannot bypass frozen or suspended account restrictions", async () => {
  for (const status of ["frozen", "suspended"]) {
    const user = { id: "restricted_owner", status };
    await assert.rejects(startMembershipChange(user, {
      priceId: MEMBERSHIP_PLANS[0].priceId,
      dependencies: {
        reconcile: async () => ({ user }),
        checkout: async () => { throw new Error("Restricted accounts must not create checkout sessions"); },
      },
    }), (error) => error.statusCode === 403);
  }
});

test("new subscriptions reuse the existing customer after cancellation and without a previous subscription", async () => {
  for (const subscription of [{ customerId: "cus_existing" }, { id: "sub_ended", status: "canceled", customerId: "cus_existing", stripeRegion: "netherlands" }]) {
    const h = checkoutHarness();
    h.user.subscription = subscription;
    h.setSubscriptions([{ id: "sub_ended", status: "canceled" }]);
    await h.reserve();
    assert.equal(h.customerCreations.length, 0);
    assert.equal(h.calls[0].data.customer, "cus_existing");
    assert.equal(h.record.data.customerId, "cus_existing");
  }
});

test("Stripe reconciliation, not stale local state, decides whether a new subscription can start", async () => {
  const stale = { id: "member_owner", status: "active", subscription: { id: "sub_old", status: "active", customerId: "cus_existing" } };
  const ended = { ...stale, status: "locked", subscription: { ...stale.subscription, status: "canceled" } };
  const calls = [];
  await startMembershipChange(stale, { priceId: MEMBERSHIP_PLANS[0].priceId, dependencies: {
    reconcile: async () => ({ user: ended, region: "netherlands" }),
    checkout: async options => { calls.push(options); return {}; },
    openPortal: async () => { throw new Error("Ended subscription should restart"); },
  } });
  assert.equal(calls[0].user.subscription.customerId, "cus_existing");
  assert.equal(calls[0].region, "netherlands");
  await startMembershipChange(ended, { priceId: MEMBERSHIP_PLANS[1].priceId, dependencies: {
    reconcile: async () => ({ user: stale, sub: { items: { data: [{ price: MEMBERSHIP_PLANS[2].priceId }] } } }),
    checkout: async () => { throw new Error("Stripe says the subscription is still running"); },
    openPortal: async () => ({}),
  } });
  await assert.rejects(startMembershipChange(ended, { priceId: MEMBERSHIP_PLANS[0].priceId, dependencies: {
    reconcile: async () => { throw new Error("Stripe unavailable"); },
    checkout: async () => { throw new Error("Must not reach checkout"); },
  } }), /Stripe unavailable/);
});

test("customer reuse stays in its Stripe account, including regional aliases, without silently creating another customer", async () => {
  const original = { netherlands: STRIPE_KEYS.netherlands, amsterdam: STRIPE_KEYS.amsterdam, eindhoven: STRIPE_KEYS.eindhoven };
  STRIPE_KEYS.netherlands = { secretKey: "test-central" };
  STRIPE_KEYS.eindhoven = { secretKey: "test-central" };
  STRIPE_KEYS.amsterdam = { secretKey: "test-regional" };
  try {
    const h = checkoutHarness();
    h.user.subscription = { customerId: "cus_existing", stripeRegion: "eindhoven" };
    assert.equal(membershipCheckoutRegion(h.user), "netherlands");
    await h.reserve();
    assert.equal(h.customerCreations.length, 0);
    assert.equal(h.calls[0].data.customer, "cus_existing");
    const other = checkoutHarness();
    other.user.subscription = { customerId: "cus_regional", stripeRegion: "amsterdam" };
    assert.equal(membershipCheckoutRegion(other.user), "amsterdam");
    await assert.rejects(other.reserve(), error => error.statusCode === 409);
    assert.equal(other.customerCreations.length, 0);
    assert.equal(other.calls.length, 0);
    other.options.region = "amsterdam";
    await other.reserve();
    assert.equal(other.calls[0].data.customer, "cus_regional");
    assert.equal(other.customerCreations.length, 0);
  } finally { Object.assign(STRIPE_KEYS, original); }
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
test("running-plan changes route same-programme updates to renewal and conversions to Stripe, never a new checkout", async () => {
  const user = { id: "member_owner", status: "active", subscription: { id: "sub_existing", status: "active", customerId: "cus_owner" } };
  const reviewed = [];
  const deferred = [];
  const dependencies = { reconcile: async () => ({ user, sub: { items: { data: [{ price: MEMBERSHIP_PLANS[0].priceId }] } } }),
    changeAtRenewal: async (owner, plan) => { assert.equal(owner.subscription.id, "sub_existing"); deferred.push(plan); return { updated: true }; },
    openPortal: async (owner, options) => { assert.equal(owner.subscription.id, "sub_existing"); reviewed.push(options); return { url: "https://billing.stripe.com/test" }; },
    checkout: async () => { throw new Error("A running subscription must not create another checkout"); },
  };
  for (const plan of MEMBERSHIP_PLANS) await startMembershipChange(user, { priceId: plan.priceId, returnUrl: "https://bulgariansociety.nl", dependencies });
  assert.equal(reviewed.length, MEMBERSHIP_PLANS.filter(plan => plan.type === "alumni").length);
  assert.equal(deferred.length, MEMBERSHIP_PLANS.filter(plan => plan.type === "member").length);
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

test("new regional Member checkouts keep central prices and persist allocation across ambiguous retries", async () => {
  const prior = process.env.MEMBER_REVENUE_SHARING_ENABLED;
  process.env.MEMBER_REVENUE_SHARING_ENABLED = "true";
  try {
    const h = checkoutHarness(); h.user.region = "amsterdam"; h.failNext();
    await assert.rejects(h.reserve(), /Network interrupted/);
    h.user.region = "rotterdam";
    await h.reserve();
    assert.deepEqual(h.calls[0], h.calls[1]);
    assert.equal(h.record.data.revenueAllocation.region, "amsterdam");
    assert.equal(h.calls[0].data.line_items[0].price, MEMBERSHIP_PLANS[0].priceId);
    assert.equal(h.calls[0].data.subscription_data.metadata.bgsnlRevenueOperation, h.record.data.operationId);
    assert.equal(h.calls[0].data.subscription_data.transfer_data, undefined);
    const alumni = checkoutHarness(); alumni.user.region = "amsterdam";
    alumni.options.plan = MEMBERSHIP_PLANS.find(p => p.type === "alumni");
    await alumni.reserve();
    assert.equal(alumni.record.data.revenueAllocation, null);
    assert.equal(alumni.calls[0].data.subscription_data.metadata.bgsnlRevenueOperation, undefined);
  } finally {
    if (prior === undefined) delete process.env.MEMBER_REVENUE_SHARING_ENABLED;
    else process.env.MEMBER_REVENUE_SHARING_ENABLED = prior;
  }
});

test("enabling revenue sharing does not retroactively enrol an in-flight checkout", async () => {
  const prior = process.env.MEMBER_REVENUE_SHARING_ENABLED;
  try {
    process.env.MEMBER_REVENUE_SHARING_ENABLED = "false";
    const h = checkoutHarness(); h.user.region = "amsterdam"; h.failNext();
    await assert.rejects(h.reserve(), /Network interrupted/);
    process.env.MEMBER_REVENUE_SHARING_ENABLED = "true";
    await h.reserve();
    assert.deepEqual(h.calls[0], h.calls[1]);
    assert.equal(h.record.data.revenueAllocation, null);
  } finally {
    if (prior === undefined) delete process.env.MEMBER_REVENUE_SHARING_ENABLED;
    else process.env.MEMBER_REVENUE_SHARING_ENABLED = prior;
  }
});
