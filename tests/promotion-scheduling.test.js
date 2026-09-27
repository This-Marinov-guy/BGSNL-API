import test from "node:test";
import assert from "node:assert/strict";
import Event from "../models/Event.js";
import { resolveEventTicketPricing } from "../services/main-services/event-action-service.js";

const now = new Date("2026-09-24T12:00:00Z");
const past = "2026-09-23T12:00:00Z";
const future = "2026-09-25T12:00:00Z";

for (const audience of ["guest", "member"]) {
  for (const [description, dates, active] of [
    ["without dates", {}, true],
    ["with empty dates", { startTimer: "", endTimer: "" }, true],
    ["with cleared dates", { startTimer: null, endTimer: null }, true],
    ["with only an upcoming expiry", { endTimer: future }, true],
    ["with only an elapsed expiry", { endTimer: past }, false],
    ["with only a past start", { startTimer: past }, true],
    ["with only a future start", { startTimer: future }, false],
    ["at the start boundary", { startTimer: now.toISOString() }, true],
    ["at the end boundary", { endTimer: now.toISOString() }, false],
    ["with a bounded active window", { startTimer: past, endTimer: future }, true],
    ["with an invalid start", { startTimer: "invalid" }, false],
    ["with an invalid end", { endTimer: "invalid" }, false],
    ["when disabled", { isEnabled: false }, false],
  ]) {
    test(`${audience} promotion ${description}`, () => {
      const event = {
        product: { guest: { price: 20 }, member: { price: 10 } },
        promotion: { [audience]: { isEnabled: true, discount: 20, ...dates } },
      };
      const { tiers } = resolveEventTicketPricing(event, { now });
      assert.equal(tiers[audience].price, event.product[audience].price * (active ? 0.8 : 1));
      const other = audience === "guest" ? "member" : "guest";
      assert.equal(tiers[other].price, event.product[other].price);
    });
  }
}

test("stored event models preserve open-ended promotions when dates are cleared", () => {
  const event = new Event({
    product: { guest: { price: 20 }, member: { price: 10 } },
    promotion: {
      guest: { isEnabled: true, discount: 20, startTimer: "", endTimer: "" },
      member: { isEnabled: true, discount: 20 },
    },
  });
  assert.equal(event.promotion.guest.startTimer, null);
  assert.equal(event.promotion.guest.endTimer, null);
  const { tiers } = resolveEventTicketPricing(event.toObject(), { now });
  assert.equal(tiers.guest.price, 16);
  assert.equal(tiers.member.price, 8);
});
