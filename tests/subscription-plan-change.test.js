import test from "node:test";
import assert from "node:assert/strict";
import { changePlanAtRenewal } from "../services/subscriptions/change-plan.js";
import { MEMBERSHIP_PLANS, subscriptionState } from "../util/subscriptions/policy.js";
import { syncScheduledChange } from "../services/subscriptions/scheduled-change.js";

function harness(from = MEMBERSHIP_PLANS[0]) {
  const now = Math.floor(Date.now() / 1000);
  const priceFor = plan => ({ id: plan.priceId, active: true, currency: "eur", unit_amount: 1000,
    recurring: { interval: plan.period === 12 ? "year" : "month", interval_count: plan.period === 12 ? 1 : plan.period } });
  const sub = { id: "sub_test", customer: "cus_test", status: "active", current_period_start: now - 3600,
    current_period_end: now + 90 * 86400, latest_invoice: { status: "paid" },
    items: { data: [{ id: "si_test", quantity: 1, price: priceFor(from) }] } };
  const user = { id: "user_test", status: "active", roles: [from.type],
    subscription: { id: sub.id, customerId: sub.customer } };
  const updates = [], syncs = [], schedules = [], scheduleUpdates = [], releases = [], record = { data: {} };
  let held = false;
  const stripe = {
    prices: { retrieve: async id => priceFor(MEMBERSHIP_PLANS.find(plan => plan.priceId === id)) },
    subscriptions: { update: async (id, params, options) => {
      assert.equal(held, true);
      assert.equal(id, sub.id);
      updates.push(structuredClone({ params, options }));
      sub.items.data[0].price = await stripe.prices.retrieve(params.items[0].price);
      if (params.trial_end) { sub.status = "trialing"; sub.trial_end = params.trial_end; sub.current_period_end = params.trial_end; }
      return sub;
    } },
    subscriptionSchedules: {
      create: async ({ from_subscription }, options) => {
        assert.equal(from_subscription, sub.id);
        const existing = schedules.find(schedule => schedule.key === options.idempotencyKey);
        if (existing) return existing;
        const schedule = { id: "sched_test", key: options.idempotencyKey, status: "active", subscription: sub.id, customer: sub.customer,
          current_phase: { start_date: sub.current_period_start },
          phases: [{ start_date: sub.current_period_start, end_date: sub.current_period_end,
            items: [{ price: sub.items.data[0].price.id, quantity: 1, tax_rates: ["txr_item"] }],
            coupon: "coupon_existing", default_tax_rates: ["txr_default"], metadata: { retained: "yes" },
            ...(sub.trial_end ? { trial_end: sub.trial_end } : {}),
          }] };
        schedules.push(schedule);
        sub.schedule = schedule.id;
        return schedule;
      },
      retrieve: async id => schedules.find(schedule => schedule.id === id),
      update: async (id, params, options) => {
        scheduleUpdates.push(structuredClone({ params, options }));
        Object.assign(schedules.find(schedule => schedule.id === id), structuredClone(params));
        return schedules.find(schedule => schedule.id === id);
      },
      release: async id => { releases.push(id); sub.schedule = null; return { status: "released" }; },
    },
  };
  const dependencies = {
    withLease: async (key, work) => {
      assert.equal(key, "subscription:netherlands:sub_test");
      assert.equal(held, false);
      held = true;
      try { return await work({ record, assertOwned: async () => assert.equal(held, true) }); }
      finally { held = false; }
    },
    readSubscription: async () => ({ sub, state: subscriptionState(sub) }),
    records: { updateOne: async (_query, update) => {
      if (update.$set["data.planChange"]) record.data.planChange = structuredClone(update.$set["data.planChange"]);
      if (update.$set["data.planChange.completed"]) record.data.planChange.completed = true;
      if (update.$set["data.downgrade"]) record.data.downgrade = structuredClone(update.$set["data.downgrade"]);
    } },
    reconcile: async () => {
      assert.equal(held, false, "reconciliation must not deadlock on its own lease");
      const state = subscriptionState(sub);
      Object.assign(user.subscription, { priceId: state.plan.priceId, period: state.plan.period, hasBenefits: state.hasBenefits });
      user.tier = state.plan.tier;
      syncs.push(state);
      return { user };
    },
  };
  return { sub, user, stripe, record, updates, syncs, schedules, scheduleUpdates, releases, dependencies,
    change: plan => changePlanAtRenewal(user, plan, { stripe, region: "netherlands", dependencies }) };
}

test("Member 6↔12 month changes update now, without charging or moving the next renewal", async () => {
  for (const [from, to] of [[0, 1], [1, 0]]) {
    const h = harness(MEMBERSHIP_PLANS[from]);
    const renewal = h.sub.current_period_end;
    assert.deepEqual(await h.change(MEMBERSHIP_PLANS[to]), { updated: true });
    assert.deepEqual(h.updates[0].params, { items: [{ id: "si_test", price: MEMBERSHIP_PLANS[to].priceId, quantity: 1 }],
      proration_behavior: "none", payment_behavior: "error_if_incomplete", trial_end: renewal });
    assert.equal(h.user.subscription.period, MEMBERSHIP_PLANS[to].period);
    assert.equal(h.user.subscription.hasBenefits, true);
    assert.equal(h.sub.current_period_end, renewal);
  }
});

test("every paid Alumni downgrade schedules tier and price together for renewal, retaining benefits today", async () => {
  const alumni = MEMBERSHIP_PLANS.filter(plan => plan.type === "alumni");
  for (const from of alumni) for (const to of alumni.filter(plan => plan.tier < from.tier)) {
    const h = harness(from);
    await h.change(to);
    assert.equal(h.user.tier, from.tier);
    assert.equal(h.user.subscription.hasBenefits, true);
    assert.equal(h.updates.length, 0);
    const params = h.scheduleUpdates[0].params;
    assert.equal(params.proration_behavior, "none");
    assert.equal(params.end_behavior, "release");
    assert.equal(params.phases[0].items[0].price, from.priceId);
    assert.equal(params.phases[0].end_date, h.sub.current_period_end);
    assert.equal(params.phases[1].start_date, h.sub.current_period_end);
    assert.equal(params.phases[1].items[0].price, to.priceId);
    for (const phase of params.phases) {
      assert.equal(phase.proration_behavior, "none");
      assert.equal(phase.coupon, "coupon_existing");
      assert.deepEqual(phase.default_tax_rates, ["txr_default"]);
      assert.deepEqual(phase.items[0].tax_rates, ["txr_item"]);
      assert.deepEqual(phase.metadata, { retained: "yes" });
    }
    await h.change(to);
    assert.equal(h.schedules.length, 1);
    assert.equal(h.scheduleUpdates.length, 1);
  }
});

test("repeated interval switches never extend paid-through time and use new operation IDs", async () => {
  const h = harness();
  const renewal = h.sub.current_period_end;
  for (const index of [1, 0, 1]) await h.change(MEMBERSHIP_PLANS[index]);
  assert.equal(new Set(h.updates.map(update => update.options.idempotencyKey)).size, 3);
  assert.ok(h.updates.every(update => update.params.trial_end === renewal));
  await h.change(MEMBERSHIP_PLANS[1]);
  assert.equal(h.updates.length, 3, "same-plan retries only reconcile");
  assert.equal(h.syncs.length, 4);
});

test("a network retry uses the same durable operation, and cannot replace an uncertain change", async () => {
  const h = harness();
  const update = h.stripe.subscriptions.update;
  const attempts = [];
  h.stripe.subscriptions.update = async (id, params, options) => {
    attempts.push(options.idempotencyKey);
    if (attempts.length === 1) throw new Error("Network unavailable");
    return update(id, params, options);
  };
  await assert.rejects(h.change(MEMBERSHIP_PLANS[1]), /Network unavailable/);
  assert.equal(h.syncs.length, 0);
  await h.change(MEMBERSHIP_PLANS[1]);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(h.record.data.planChange.completed, true);

  const alumni = harness(MEMBERSHIP_PLANS[5]);
  alumni.stripe.subscriptionSchedules.update = async () => { throw new Error("Network unavailable"); };
  await assert.rejects(alumni.change(MEMBERSHIP_PLANS[3]));
  await assert.rejects(alumni.change(MEMBERSHIP_PLANS[4]), error => error.statusCode === 409);
});

test("a successful Stripe update followed by a lost response is reconciled without another mutation", async () => {
  const h = harness();
  const update = h.stripe.subscriptions.update;
  h.stripe.subscriptions.update = async (...args) => { await update(...args); throw new Error("Lost response"); };
  await assert.rejects(h.change(MEMBERSHIP_PLANS[1]), /Lost response/);
  await h.change(MEMBERSHIP_PLANS[1]);
  assert.equal(h.updates.length, 1);
  assert.equal(h.user.subscription.period, MEMBERSHIP_PLANS[1].period);
});

test("unsafe subscription states, wrong customer and cross-programme changes cannot use deferred billing", async () => {
  for (const mutate of [
    h => { h.user.status = "frozen"; },
    h => { h.sub.customer = "cus_other"; },
    h => { h.sub.id = "sub_other"; },
    h => { h.sub.status = "past_due"; },
    h => { h.sub.status = "canceled"; },
    h => { h.sub.current_period_end = 1; },
    h => { h.sub.pending_update = {}; },
    h => { h.sub.schedule = "sub_sched"; },
    h => { h.sub.cancel_at_period_end = true; },
    h => { h.sub.cancel_at = h.sub.current_period_end; },
    h => { h.sub.pause_collection = {}; },
    h => { h.sub.items.data[0].quantity = 2; },
    h => { h.sub.items.data.push(h.sub.items.data[0]); },
  ]) {
    const h = harness(); mutate(h);
    await assert.rejects(h.change(MEMBERSHIP_PLANS[1]), error => error.statusCode === 409);
    assert.equal(h.updates.length, 0);
  }
  const h = harness();
  await assert.rejects(h.change(MEMBERSHIP_PLANS[2]), error => error.statusCode === 409);
  await assert.rejects(h.change({ priceId: "price_invented" }), error => error.statusCode === 409);
  assert.equal(h.updates.length, 0);
  const alumni = harness(MEMBERSHIP_PLANS[2]);
  await assert.rejects(alumni.change(MEMBERSHIP_PLANS[3]), error => error.statusCode === 409);
  assert.equal(alumni.updates.length, 0);
  assert.equal(alumni.schedules.length, 0);
});

test("the scheduled lower tier is applied only at renewal; completed owned schedules release safely", async () => {
  const h = harness(MEMBERSHIP_PLANS[5]);
  await h.change(MEMBERSHIP_PLANS[2]);
  const sync = () => syncScheduledChange(h.stripe, h.sub, subscriptionState(h.sub), async () => {});
  assert.equal((await sync()).tier, MEMBERSHIP_PLANS[2].tier);
  assert.equal(h.releases.length, 0);
  h.sub.items.data[0].price = await h.stripe.prices.retrieve(MEMBERSHIP_PLANS[2].priceId);
  h.schedules[0].current_phase.start_date = h.sub.current_period_end;
  assert.equal(await sync(), null);
  assert.equal(h.sub.schedule, null);
  assert.deepEqual(h.releases, ["sched_test"]);
  await h.dependencies.reconcile();
  assert.equal(h.user.tier, MEMBERSHIP_PLANS[2].tier);
});

test("schedule retries recover a lost create or update response without duplicate schedules", async () => {
  for (const method of ["create", "update"]) {
    const h = harness(MEMBERSHIP_PLANS[5]);
    const original = h.stripe.subscriptionSchedules[method];
    let failed = false;
    h.stripe.subscriptionSchedules[method] = async (...args) => {
      const result = await original(...args);
      if (!failed) { failed = true; throw new Error("Lost response"); }
      return result;
    };
    await assert.rejects(h.change(MEMBERSHIP_PLANS[2]), /Lost response/);
    await h.change(MEMBERSHIP_PLANS[2]);
    assert.equal(h.schedules.length, 1);
    assert.equal(h.scheduleUpdates.length, 1);
    assert.equal(h.user.tier, MEMBERSHIP_PLANS[5].tier);
  }
});

test("reconciliation repairs an interrupted downgrade setup without changing today's tier", async () => {
  const h = harness(MEMBERSHIP_PLANS[5]);
  const original = h.stripe.subscriptionSchedules.update;
  h.stripe.subscriptionSchedules.update = async () => { throw new Error("Offline"); };
  await assert.rejects(h.change(MEMBERSHIP_PLANS[2]), /Offline/);
  h.stripe.subscriptionSchedules.update = original;
  const scheduled = await syncScheduledChange(h.stripe, h.sub, subscriptionState(h.sub), async () => {}, {
    record: h.record, key: "subscription:netherlands:sub_test", records: h.dependencies.records,
  });
  assert.equal(scheduled.tier, MEMBERSHIP_PLANS[2].tier);
  assert.equal(h.sub.items.data[0].price.id, MEMBERSHIP_PLANS[5].priceId);
  assert.equal(h.schedules.length, 1);
  assert.equal(h.scheduleUpdates.length, 1);
});

test("external schedules are not released or overwritten, and schedule ownership is checked", async () => {
  const h = harness(MEMBERSHIP_PLANS[5]);
  await h.change(MEMBERSHIP_PLANS[2]);
  h.schedules[0].metadata = {};
  assert.equal(await syncScheduledChange(h.stripe, h.sub, subscriptionState(h.sub), async () => {}), null);
  assert.equal(h.releases.length, 0);
  h.schedules[0].customer = "cus_other";
  await assert.rejects(syncScheduledChange(h.stripe, h.sub, subscriptionState(h.sub), async () => {}), /ownership mismatch/);
});

test("invalid prices and verification outages fail before updating Stripe", async () => {
  for (const override of [{ active: false }, { currency: "usd" }, { unit_amount: 0 }, { recurring: { interval: "week", interval_count: 1 } }]) {
    const h = harness();
    const retrieve = h.stripe.prices.retrieve;
    h.stripe.prices.retrieve = async id => ({ ...await retrieve(id), ...override });
    await assert.rejects(h.change(MEMBERSHIP_PLANS[1]), /unavailable/);
    assert.equal(h.updates.length, 0);
  }
  const h = harness();
  h.dependencies.readSubscription = async () => { throw new Error("Stripe unavailable"); };
  await assert.rejects(h.change(MEMBERSHIP_PLANS[1]), /Stripe unavailable/);
  assert.equal(h.updates.length, 0);
});
