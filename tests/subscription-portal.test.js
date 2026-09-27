import test from "node:test";
import assert from "node:assert/strict";
import { createMembershipPortal, portalConfiguration } from "../services/subscriptions/checkout.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";

function harness({ locked = false } = {}) {
  const configurations = [];
  const sessions = [];
  const prices = [];
  const user = { id: "member_test", roles: ["member"], status: locked ? "locked" : "active", expireDate: new Date("2099-01-01"),
    subscription: { id: "sub_test", customerId: "cus_test", status: "active", hasBenefits: !locked, syncedAt: new Date() } };
  const sub = { id: "sub_test", status: "active", items: { data: [{ id: "si_test", price: { id: MEMBERSHIP_PLANS[0].priceId }, quantity: 1 }] } };
  const stripe = {
    prices: { retrieve: async id => {
      prices.push(id);
      const plan = MEMBERSHIP_PLANS.find(plan => plan.priceId === id);
      return { active: true, currency: "eur", unit_amount: 1000, product: `prod_${plan.type}`,
        recurring: { interval: "month", interval_count: plan.period } };
    } },
    billingPortal: {
      configurations: {
        list: () => (async function* () { yield* configurations; })(),
        retrieve: async id => configurations.find(configuration => configuration.id === id),
        create: async (data, options) => {
          const configuration = { ...structuredClone(data), id: `bpc_${configurations.length}`, active: true, options };
          configurations.push(configuration);
          return configuration;
        },
      },
      sessions: { create: async (data, options) => {
        sessions.push(structuredClone({ data, options }));
        return { url: "https://billing.stripe.com/p/session/test" };
      } },
    },
  };
  const withLease = async (_key, work) => work({ record: {}, assertOwned: async () => {} });
  const dependencies = { withLease, reconcile: async () => ({ user, sub, region: "netherlands", stripe }) };
  return { user, sub, stripe, configurations, sessions, prices, withLease, open: options => createMembershipPortal(user, { ...options, dependencies }) };
}

test("Payments sessions cannot switch plans and do not depend on the Stripe price catalog", async () => {
  const h = harness();
  await h.open();
  assert.equal(h.configurations[0].features.subscription_update.enabled, false);
  assert.equal(h.configurations[0].features.invoice_history.enabled, true);
  assert.equal(h.configurations[0].features.payment_method_update.enabled, true);
  assert.equal(h.sessions[0].data.flow_data, undefined);
  assert.equal(h.sessions[0].data.customer, "cus_test");
  assert.deepEqual(h.prices, []);
  await h.open();
  assert.equal(h.configurations.length, 1);
});

test("Switch uses a separate confirmation-only session for the selected plan and same subscription item", async () => {
  const h = harness();
  await h.open();
  await h.open({ priceId: MEMBERSHIP_PLANS[2].priceId });
  assert.notEqual(h.sessions[0].data.configuration, h.sessions[1].data.configuration);
  assert.equal(h.configurations[1].features.subscription_update.enabled, true);
  assert.equal(h.configurations[1].features.subscription_update.proration_behavior, "always_invoice");
  assert.deepEqual(h.configurations[1].features.subscription_update.default_allowed_updates, ["price"]);
  assert.deepEqual(h.sessions[1].data.flow_data, {
    type: "subscription_update_confirm",
    subscription_update_confirm: { subscription: "sub_test", items: [{ id: "si_test", price: MEMBERSHIP_PLANS[2].priceId, quantity: 1 }] },
    after_completion: { type: "redirect", redirect: { return_url: "https://bulgariansociety.nl/user#settings" } },
  });
  await h.open();
  assert.equal(h.sessions[2].data.configuration, h.sessions[0].data.configuration);
});

test("cancellation and payment-method flows never expose plan switching", async () => {
  for (const locked of [false, true]) for (const action of ["cancel", "payment_method"]) {
    const h = harness({ locked });
    await h.open({ action });
    assert.equal(h.configurations[0].features.subscription_update.enabled, false);
    assert.equal(h.sessions[0].data.flow_data.type, action === "cancel" ? "subscription_cancel" : "payment_method_update");
    assert.equal(h.configurations[0].features.subscription_cancel.mode, locked ? "immediately" : "at_period_end");
  }
});

test("Alumni upgrades use immediate Stripe invoicing, but downgrades cannot use that flow", async () => {
  for (const from of MEMBERSHIP_PLANS.filter(plan => plan.type === "alumni")) {
    for (const to of MEMBERSHIP_PLANS.filter(plan => plan.type === "alumni" && plan !== from)) {
      const h = harness();
      h.sub.items.data[0].price.id = from.priceId;
      if (to.tier > from.tier) {
        await h.open({ priceId: to.priceId });
        assert.equal(h.configurations[0].features.subscription_update.proration_behavior, "always_invoice");
        assert.equal(h.sessions[0].data.flow_data.subscription_update_confirm.items[0].price, to.priceId);
      } else {
        await assert.rejects(h.open({ priceId: to.priceId }), error => error.statusCode === 409);
        assert.equal(h.sessions.length, 0);
      }
    }
  }
});

test("locked, pending and cancellation-scheduled subscriptions cannot request plan confirmation", async () => {
  for (const condition of ["locked", "pending_update", "schedule", "cancel_at_period_end"]) {
    const h = harness({ locked: condition === "locked" });
    if (condition !== "locked") h.sub[condition] = true;
    await assert.rejects(h.open({ priceId: MEMBERSHIP_PLANS[1].priceId }), error => error.statusCode === 409);
    assert.equal(h.sessions.length, 0);
    assert.equal(h.configurations.length, 0);
  }
});

test("unsupported actions, unknown plans and the current plan fail before creating a portal session", async () => {
  const h = harness();
  await assert.rejects(h.open({ action: "subscription_update" }), error => error.statusCode === 422);
  await assert.rejects(h.open({ priceId: "price_unapproved" }), error => error.statusCode === 422);
  await assert.rejects(h.open({ priceId: MEMBERSHIP_PLANS[0].priceId }), error => error.statusCode === 409);
  await assert.rejects(h.open({ priceId: MEMBERSHIP_PLANS[1].priceId }), error => error.statusCode === 409);
  assert.equal(h.sessions.length, 0);
  assert.equal(h.configurations.length, 0);
});

test("v1 portals are never reused for Payments; modified v2 configurations fail closed", async () => {
  const h = harness();
  h.configurations.push({ id: "bpc_legacy", active: true, metadata: { bgsnlConfigurationKey: "portal-config:v1:netherlands:old" },
    features: { subscription_update: { enabled: true } } });
  await h.open();
  assert.notEqual(h.sessions[0].data.configuration, "bpc_legacy");
  h.configurations[1].features.subscription_update.enabled = true;
  await assert.rejects(h.open(), error => error.statusCode === 503);
  await assert.rejects(portalConfiguration(h.stripe, "netherlands", false, {
    withLease: async (_key, work) => work({ record: { data: { configurationId: h.configurations[1].id } } }),
  }), error => error.statusCode === 503);
  assert.equal(h.sessions.length, 1);
});
