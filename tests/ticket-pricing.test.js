import assert from "node:assert/strict";
import test from "node:test";
import { resolveTicketLineItem } from "../controllers/payments-controllers.js";
import {
  checkDiscountsOnEvents,
  resolveEventTicketPricing,
} from "../services/main-services/event-action-service.js";

const NOW = new Date("2026-09-15T12:00:00Z");

const makeEvent = (patch = {}) => ({
  _id: "a".repeat(24),
  title: "Pricing Night",
  region: "groningen",
  guestList: [],
  product: {
    id: "prod_event",
    guest: { price: 20, priceId: "price_guest_regular" },
    member: { price: 10, priceId: "price_member_regular" },
  },
  earlyBird: {
    isEnabled: true,
    price: 14,
    priceId: "price_guest_early",
    memberPrice: 7,
    memberPriceId: "price_member_early",
    ticketTimer: new Date("2026-09-20T12:00:00Z"),
    excludeMembers: false,
  },
  lateBird: {
    isEnabled: false,
  },
  promotion: {
    guest: { isEnabled: false },
    member: { isEnabled: false },
  },
  ...patch,
});

test("late bird price wins once its start condition is met", () => {
  const event = makeEvent({
    lateBird: {
      isEnabled: true,
      price: 24,
      priceId: "price_guest_late",
      memberPrice: 12,
      memberPriceId: "price_member_late",
      startTimer: new Date("2026-09-14T12:00:00Z"),
    },
  });

  const priced = checkDiscountsOnEvents(structuredClone(event), { now: NOW });

  assert.equal(priced.product.earlyBird, false);
  assert.equal(priced.product.lateBird, true);
  assert.equal(priced.product.guest.price, 24);
  assert.equal(priced.product.guest.priceId, "price_guest_late");
  assert.equal(priced.product.member.price, 12);
  assert.equal(priced.product.member.priceId, "price_member_late");
});

test("guest and member promotions apply to the active bird-stage price", () => {
  const event = makeEvent({
    lateBird: {
      isEnabled: true,
      price: 24,
      priceId: "price_guest_late",
      memberPrice: 12,
      memberPriceId: "price_member_late",
      startTimer: new Date("2026-09-14T12:00:00Z"),
    },
    promotion: {
      guest: {
        isEnabled: true,
        discount: 50,
        priceId: "price_guest_regular_promo",
        startTimer: new Date("2026-09-10T12:00:00Z"),
        endTimer: new Date("2026-09-20T12:00:00Z"),
      },
      member: {
        isEnabled: true,
        discount: 25,
        priceId: "price_member_regular_promo",
        startTimer: new Date("2026-09-10T12:00:00Z"),
        endTimer: new Date("2026-09-20T12:00:00Z"),
      },
    },
  });

  const priced = checkDiscountsOnEvents(structuredClone(event), { now: NOW });

  assert.equal(priced.product.lateBird, true);
  assert.equal(priced.product.guest.originalPrice, 24);
  assert.equal(priced.product.guest.price, 12);
  assert.equal(priced.product.guest.discount, 50);
  assert.equal(priced.product.guest.priceId, undefined);
  assert.equal(priced.product.member.originalPrice, 12);
  assert.equal(priced.product.member.price, 9);
  assert.equal(priced.product.member.discount, 25);
  assert.equal(priced.product.member.priceId, undefined);
});

test("regular-period promotions keep their stored Stripe price ID", () => {
  const event = makeEvent({
    earlyBird: { isEnabled: false },
    promotion: {
      guest: {
        isEnabled: true,
        discount: 50,
        priceId: "price_guest_regular_promo",
        startTimer: new Date("2026-09-10T12:00:00Z"),
        endTimer: new Date("2026-09-20T12:00:00Z"),
      },
      member: { isEnabled: false },
    },
  });

  const priced = checkDiscountsOnEvents(structuredClone(event), { now: NOW });

  assert.equal(priced.product.earlyBird, false);
  assert.equal(priced.product.lateBird, false);
  assert.equal(priced.product.guest.originalPrice, 20);
  assert.equal(priced.product.guest.price, 10);
  assert.equal(priced.product.guest.priceId, "price_guest_regular_promo");
});

test("pricing resolver keeps the stored product object unchanged", () => {
  const event = makeEvent({
    lateBird: {
      isEnabled: true,
      price: 24,
      priceId: "price_guest_late",
      memberPrice: 12,
      memberPriceId: "price_member_late",
      startTimer: new Date("2026-09-14T12:00:00Z"),
    },
    promotion: {
      guest: {
        isEnabled: true,
        discount: 50,
        priceId: "price_guest_regular_promo",
        startTimer: new Date("2026-09-10T12:00:00Z"),
        endTimer: new Date("2026-09-20T12:00:00Z"),
      },
      member: { isEnabled: false },
    },
  });
  const storedProduct = structuredClone(event.product);

  const pricing = resolveEventTicketPricing(event, { now: NOW });

  assert.deepEqual(event.product, storedProduct);
  assert.equal(pricing.stage, "lateBird");
  assert.equal(pricing.tiers.guest.originalPrice, 24);
  assert.equal(pricing.tiers.guest.price, 12);
  assert.equal(pricing.tiers.guest.priceId, undefined);
});

test("checkout uses dynamic price data for combined bird-stage promotion prices", async () => {
  const event = makeEvent({
    lateBird: {
      isEnabled: true,
      price: 24,
      priceId: "price_guest_late",
      memberPrice: 12,
      memberPriceId: "price_member_late",
      startTimer: new Date("2026-09-14T12:00:00Z"),
    },
    promotion: {
      guest: {
        isEnabled: true,
        discount: 50,
        priceId: "price_guest_regular_promo",
        startTimer: new Date("2026-09-10T12:00:00Z"),
        endTimer: new Date("2099-09-20T12:00:00Z"),
      },
      member: { isEnabled: false },
    },
  });

  const lineItem = await resolveTicketLineItem(structuredClone(event), "guest", "", false, 2);

  assert.deepEqual(lineItem, {
    price_data: {
      currency: "eur",
      product: "prod_event",
      unit_amount: 1200,
    },
    quantity: 2,
  });
});
