import assert from "node:assert/strict";
import test from "node:test";
import { MEMBERSHIP_PLANS, subscriptionState } from "../util/subscriptions/policy.js";
import { reconcileSubscription, readStripeSubscription } from "../services/subscriptions/reconcile.js";

const makeHarness = () => {
  const now = Math.floor(Date.now() / 1000);
  const account = { id: "member_owner", status: "active", roles: ["member"],
    subscription: { id: "sub_owner", customerId: "cus_owner" } };
  const attachSerializer = () => { account.subscription.toObject = function () { const { toObject, ...data } = this; return data; }; };
  attachSerializer();
  const live = { id: "sub_owner", customer: "cus_owner", status: "active", current_period_start: now, current_period_end: now + 600,
    latest_invoice: { id: "in_one", status: "paid" }, items: { data: [{ quantity: 1, price: { id: MEMBERSHIP_PLANS[0].priceId } }] } };
  const jobs = [];
  let invoices = [];
  const dependencies = {
    stripe: {}, onChanged: async () => {}, withLease: async (_key, run) => run({ assertOwned: async () => {} }),
    findAccount: async (query) => { assert.deepEqual(Object.keys(query), ["subscription.id"]); return query["subscription.id"] === account.subscription.id ? account : null; },
    readSubscription: async () => ({ sub: live, state: subscriptionState(live, invoices) }),
    persistAccount: async (_user, fields, plan) => {
      Object.assign(account, fields);
      if (plan) { account.roles = [plan.type]; account.tier = plan.tier; }
      attachSerializer();
      return account;
    },
    attention: {
      findOneAndUpdate: async (_query, update) => {
        const open = jobs.find((job) => !job.resolvedAt);
        if (open) return open;
        jobs.push({ ...update.$setOnInsert });
        return jobs.at(-1);
      },
      updateOne: async (query, update) => Object.assign(jobs.find((job) => job._id === query._id), update.$set),
    },
  };
  return { account, live, jobs, dependencies, setInvoices: (value) => { invoices = value; },
    sync: () => reconcileSubscription("sub_owner", "netherlands", { expectedCustomerId: "cus_owner", dependencies }) };
};

test("failed payment immediately locks future-dated accounts and replay creates only one reminder episode", async () => {
  const h = makeHarness();
  h.live.status = "past_due";
  await h.sync();
  await h.sync();
  assert.equal(h.account.status, "locked");
  assert.equal(h.account.subscription.hasBenefits, false);
  assert.equal(h.jobs.length, 1);
});
test("reordered webhook delivery always reads current Stripe state, never restores an unpaid account", async () => {
  const h = makeHarness();
  h.live.status = "past_due";
  await h.sync(); // payment_failed
  await h.sync(); // an old invoice.paid arriving later
  assert.equal(h.account.status, "locked");
  h.live.status = "active";
  await h.sync(); // payment recovered
  await h.sync(); // an old payment_failed arriving last
  assert.equal(h.account.status, "active");
  assert.ok(h.jobs[0].resolvedAt);
  assert.equal(h.account.subscription.failureEpisode, undefined);
});
test("old subscription events cannot take over an account by matching the customer", async () => {
  const h = makeHarness();
  const result = await reconcileSubscription("sub_old", "netherlands", { expectedCustomerId: "cus_owner", dependencies: h.dependencies });
  assert.equal(result, null);
  assert.equal(h.account.subscription.id, "sub_owner");
});
test("customer mismatch rejects state updates", async () => {
  const h = makeHarness(); h.live.customer = "cus_someone_else";
  await assert.rejects(h.sync(), /ownership mismatch/);
  assert.equal(h.account.subscription.syncedAt, undefined);
});
test("member periods and alumni tiers are applied from paid Stripe items in both directions", async () => {
  const h = makeHarness();
  for (const plan of [...MEMBERSHIP_PLANS, MEMBERSHIP_PLANS[0]]) {
    h.live.items.data[0].price.id = plan.priceId;
    await h.sync();
    assert.equal(h.account.roles[0], plan.type);
    assert.equal(h.account.tier, plan.tier);
    assert.equal(h.account.subscription.period, plan.period);
    assert.equal(h.account.expireDate.getTime(), h.live.current_period_end * 1000);
  }
});
test("unpaid alumni upgrade does not apply alumni identity or tier", async () => {
  const h = makeHarness();
  h.live.items.data[0].price.id = MEMBERSHIP_PLANS.at(-1).priceId;
  h.live.status = "past_due";
  await h.sync();
  assert.deepEqual(h.account.roles, ["member"]);
  assert.equal(h.account.tier, undefined);
  assert.equal(h.account.status, "locked");
});
test("billing recovery never clears an administrative suspension", async () => {
  const h = makeHarness(); h.account.status = "frozen";
  await h.sync();
  assert.equal(h.account.status, "frozen");
});
test("cancellation stops reminders and removes benefits without extending expiry", async () => {
  const h = makeHarness(); h.live.status = "past_due";
  await h.sync();
  h.live.status = "canceled";
  await h.sync();
  assert.equal(h.account.status, "locked");
  assert.equal(h.account.subscription.lockReason, "subscription_ended");
  assert.ok(h.jobs[0].resolvedAt);
});
test("an in-flight recovery payment does not reset the two-email allowance", async () => {
  const h = makeHarness(); h.live.status = "past_due";
  await h.sync();
  const episode = h.account.subscription.failureEpisode;
  h.live.status = "active"; h.live.latest_invoice.status = "open";
  h.setInvoices([{ id: "in_one", subscription: "sub_owner", status: "open", attempted: true, amount_remaining: 600, payment_intent: { status: "processing" } }]);
  await h.sync();
  assert.equal(h.account.subscription.failureEpisode, episode);
  assert.equal(h.jobs[0].resolvedAt, null);
  h.live.status = "past_due";
  h.setInvoices([]);
  await h.sync();
  assert.equal(h.account.subscription.failureEpisode, episode);
  assert.equal(h.jobs.length, 1);
});
test("Stripe outage does not overwrite a known account state", async () => {
  const h = makeHarness(); h.dependencies.readSubscription = async () => { throw new Error("Stripe unavailable"); };
  await assert.rejects(h.sync(), /Stripe unavailable/);
  assert.equal(h.account.subscription.syncedAt, undefined);
});
test("choosing free alumni applies tier 0 only after cancellation actually ends the subscription", async () => {
  const h = makeHarness();
  h.account.subscription.freeAlumniRequested = true;
  h.live.cancel_at_period_end = true;
  await h.sync();
  assert.deepEqual(h.account.roles, ["member"]);
  assert.equal(h.account.status, "active");
  assert.equal(h.account.subscription.hasBenefits, true);
  h.live.status = "canceled";
  await h.sync();
  assert.deepEqual(h.account.roles, ["alumni"]);
  assert.equal(h.account.tier, 0);
  assert.equal(h.account.subscription.hasBenefits, false);
  assert.equal(h.account.subscription.lockReason, null);
});
test("invoice retrieval includes every page of open and uncollectible invoices", async () => {
  const h = makeHarness();
  const statuses = [];
  const stripe = { subscriptions: { retrieve: async () => h.live }, invoices: { list: ({ status, subscription }) => {
    assert.equal(subscription, "sub_owner"); statuses.push(status);
    return (async function* () { yield { id: status, subscription, status, amount_remaining: 600, attempted: true }; })();
  } } };
  const { state } = await readStripeSubscription(stripe, "sub_owner");
  assert.deepEqual(statuses, ["open", "uncollectible"]);
  assert.equal(state.hasBenefits, false);
});

test("voided upgrades search all invoice lines for evidence of the current paid period", async () => {
  const h = makeHarness();
  h.live.latest_invoice.status = "void"; h.live.items.data[0].id = "si_original";
  let linePagesRead = 0;
  const stripe = { subscriptions: { retrieve: async () => h.live }, invoices: {
    list: ({ status }) => (async function* () {
      if (status === "paid") yield { id: "in_original", subscription: "sub_owner", status: "paid", lines: { data: [], has_more: true } };
    })(),
    listLineItems: (id) => (async function* () {
      assert.equal(id, "in_original"); linePagesRead++;
      yield { subscription_item: "si_original", price: h.live.items.data[0].price, amount: 600,
        period: { start: h.live.current_period_start, end: h.live.current_period_end } };
    })(),
  } };
  const { state } = await readStripeSubscription(stripe, h.live.id);
  assert.equal(state.hasBenefits, true); assert.equal(linePagesRead, 1);
});
test("material changes refresh reporting once; duplicate webhooks do not enqueue exports", async () => {
  const h = makeHarness(); let refreshes = 0;
  h.dependencies.onChanged = async () => { refreshes++; };
  await h.sync(); await h.sync();
  assert.equal(refreshes, 1);
  h.live.status = "past_due";
  await h.sync(); await h.sync();
  assert.equal(refreshes, 2);
});
test("a recovered paid plan change clears an abandoned free-alumni request", async () => {
  const h = makeHarness();
  h.account.subscription.freeAlumniRequested = true;
  h.account.subscription.freeAlumniPriceId = MEMBERSHIP_PLANS[0].priceId;
  h.live.items.data[0].price.id = MEMBERSHIP_PLANS[1].priceId;
  h.live.status = "past_due";
  await h.sync();
  assert.equal(h.account.subscription.freeAlumniRequested, true);
  h.live.status = "active";
  await h.sync();
  assert.equal(h.account.subscription.freeAlumniRequested, false);
  h.live.status = "canceled";
  await h.sync();
  assert.deepEqual(h.account.roles, ["member"]);
});
