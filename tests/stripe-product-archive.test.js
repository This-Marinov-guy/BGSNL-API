import test from "node:test";
import assert from "node:assert/strict";
import { archiveProduct } from "../services/side-services/stripe.js";

test("Stripe archival deactivates every price page and preserves the product", async () => {
  const calls = [];
  const stripeClient = {
    prices: {
      list: async ({ product, active, limit, starting_after: after }) => {
        assert.equal(product, "prod_event");
        assert.equal(active, true);
        assert.equal(limit, 100);
        calls.push(["list", after]);
        return after
          ? { data: [{ id: "price_3" }], has_more: false }
          : { data: [{ id: "price_1" }, { id: "price_2" }], has_more: true };
      },
      update: async (id, patch) => { calls.push(["price", id, patch]); },
    },
    products: { update: async (id, patch) => { calls.push(["product", id, patch]); } },
  };
  assert.equal(await archiveProduct("groningen", "prod_event", { stripeClient }), true);
  assert.deepEqual(calls, [
    ["list", undefined], ["list", "price_2"],
    ["price", "price_1", { active: false }],
    ["price", "price_2", { active: false }],
    ["price", "price_3", { active: false }],
    ["product", "prod_event", { active: false }],
  ]);
});

test("Stripe archival rejects a price failure so pending cleanup can retry", async () => {
  let productUpdated = false;
  const stripeClient = {
    prices: {
      list: async () => ({ data: [{ id: "price_1" }], has_more: false }),
      update: async () => { throw new Error("Stripe unavailable"); },
    },
    products: { update: async () => { productUpdated = true; } },
  };
  await assert.rejects(archiveProduct("groningen", "prod_event", { stripeClient }), /Stripe unavailable/);
  assert.equal(productUpdated, false);
});

test("Stripe archival finishes a retry when prices are already inactive", async () => {
  const updates = [];
  const stripeClient = {
    prices: { list: async () => ({ data: [], has_more: false }), update: async () => assert.fail("No active prices") },
    products: { update: async (id, patch) => { updates.push([id, patch]); } },
  };
  assert.equal(await archiveProduct("groningen", "prod_event", { stripeClient }), true);
  assert.deepEqual(updates, [["prod_event", { active: false }]]);
});
