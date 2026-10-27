import assert from "node:assert/strict";
import test from "node:test";
import { syncEventPromoCodes } from "../controllers/Events/future-events-action-controller.js";

test("free event publication skips Stripe promotion sync without a product", async () => {
  let calls = 0;
  const providers = {
    create: async () => { calls += 1; },
    update: async () => { calls += 1; },
  };

  await syncEventPromoCodes({ isFree: true }, "netherlands", null, providers);
  await syncEventPromoCodes({ isFree: true, product: null }, "netherlands", null, providers);
  assert.equal(calls, 0);
});

test("paid event publication still creates or updates Stripe promotions", async () => {
  const calls = [];
  const providers = {
    create: async (...args) => { calls.push(["create", ...args]); return ["new-promo"]; },
    update: async (...args) => { calls.push(["update", ...args]); return ["updated-promo"]; },
  };
  const newEvent = { product: { id: "prod_new" } };
  const existingEvent = { product: { id: "prod_existing", promoCodes: ["old-promo"] } };

  await syncEventPromoCodes(newEvent, "netherlands", { codes: [] }, providers);
  await syncEventPromoCodes(existingEvent, "groningen", { codes: [] }, providers);

  assert.deepEqual(calls, [
    ["create", "netherlands", "prod_new", { codes: [] }],
    ["update", "groningen", "prod_existing", { codes: [] }, ["old-promo"]],
  ]);
  assert.deepEqual(newEvent.product.promoCodes, ["new-promo"]);
  assert.deepEqual(existingEvent.product.promoCodes, ["updated-promo"]);
});
