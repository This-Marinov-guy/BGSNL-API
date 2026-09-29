import assert from "node:assert/strict";
import test from "node:test";
import { assertTestEnvironment, repairTestCustomer } from "../scripts/repair-test-billing-customer.mjs";

const env = { APP_ENV: "dev", DB: "dev.example.test", STRIPE_NL_SECRET_KEY: "sk_test_fixture" };
const harness = () => {
  const calls = [];
  return { calls, env, account: { _id: "alumni_test", email: "test@example.test", status: "active", subscription: { customerId: "cus_old" } },
    stripe: { customers: {
      retrieve: async () => { throw Object.assign(new Error("Missing"), { code: "resource_missing", param: "id" }); },
      create: async (...args) => { calls.push(args); return { id: "cus_test", livemode: false }; },
    } }, collection: { updateOne: async (...args) => { calls.push(args); return { modifiedCount: 1 }; } } };
};
test("repair refuses production, live keys and non-development databases", () => {
  for (const patch of [{ APP_ENV: "prod" }, { NODE_ENV: "production" }, { DB: "production.example.test" }, { STRIPE_NL_SECRET_KEY: "sk_live_fixture" }]) {
    assert.throws(() => assertTestEnvironment({ ...env, ...patch }));
  }
});
test("dry run verifies missing customer without any writes", async () => {
  const h = harness();
  assert.equal((await repairTestCustomer(h)).repairable, true);
  assert.equal(h.calls.length, 0);
});
test("repair never replaces valid test customers or linked subscriptions", async () => {
  const h = harness();
  h.stripe.customers.retrieve = async () => ({ id: "cus_old", livemode: false });
  assert.equal((await repairTestCustomer({ ...h, apply: true })).changed, false);
  h.account.subscription.id = "sub_linked";
  await assert.rejects(repairTestCustomer({ ...h, apply: true }), /without a linked subscription/);
  assert.equal(h.calls.length, 0);
});
test("transient Stripe failures cannot trigger customer replacement", async () => {
  const h = harness();
  h.stripe.customers.retrieve = async () => { throw new Error("Network unavailable"); };
  await assert.rejects(repairTestCustomer({ ...h, apply: true }), /Network unavailable/);
  assert.equal(h.calls.length, 0);
});
test("repair preserves original reference in test metadata and only updates billing customer fields", async () => {
  const h = harness();
  assert.equal((await repairTestCustomer({ ...h, apply: true })).changed, true);
  assert.equal(h.calls[0][0].metadata.bgsnlPreviousCustomerId, "cus_old");
  assert.ok(h.calls[0][1].idempotencyKey);
  assert.equal(h.calls[1][0]["subscription.customerId"], "cus_old");
  assert.deepEqual(h.calls[1][1], { $set: { "subscription.customerId": "cus_test", "subscription.stripeRegion": "netherlands" } });
});
test("concurrent account changes cannot be overwritten", async () => {
  const h = harness();
  h.collection.updateOne = async () => ({ modifiedCount: 0 });
  await assert.rejects(repairTestCustomer({ ...h, apply: true }), /Account changed/);
});
