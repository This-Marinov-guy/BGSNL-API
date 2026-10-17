import test from "node:test";
import assert from "node:assert/strict";
import { createGuestDeliveryService } from "../services/tickets/guest-delivery.js";

const eventId = "a".repeat(24);
const firstId = "b".repeat(24);
const secondId = "c".repeat(24);
const ticket = (_id, changes = {}) => ({ _id, email: "guest@example.com", name: "Guest",
  phone: "+31612345678", type: "guest", code: 1234, ticketToken: "x".repeat(22),
  ticket: "https://example.com/ticket.png", transactionId: "pi_paid", refunded: false, ...changes });

const fixture = (changes = {}) => {
  const guests = [ticket(firstId), ticket(secondId)];
  guests.id = id => guests.find(guest => guest._id === id);
  const event = { _id: eventId, region: "eindhoven", status: "opened", title: "Event",
    date: new Date("2026-11-01T18:00:00Z"), poster: "https://example.com/poster.png", guestList: guests, ...changes };
  return { event, EventModel: { findById: () => ({ select: async () => event }) } };
};

test("manual ticket resend uses the existing template data and selected guest's purchase", async () => {
  const { EventModel } = fixture();
  const sent = [];
  const service = createGuestDeliveryService({ EventModel,
    deliverTicket: async message => sent.push(message) });
  const result = await service.sendTicket(eventId, firstId, "eindhoven");
  assert.equal(result.email, "guest@example.com");
  assert.equal(result.ticketCount, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tickets.length, 2);
  assert.equal(sent[0].receiver, "guest@example.com");
  assert.match(sent[0].walletUrl, /wallet\/ticket/);
});

test("manual delivery refuses another region, refunded guests, and missing ticket images", async () => {
  const { event, EventModel } = fixture();
  const service = createGuestDeliveryService({ EventModel, deliverTicket: async () => {} });
  await assert.rejects(service.sendTicket(eventId, firstId, "amsterdam"), /No access/);
  event.guestList[0].refunded = true;
  await assert.rejects(service.sendTicket(eventId, firstId, "eindhoven"), /refunded/);
  event.guestList[0].refunded = false;
  event.guestList[0].ticket = "";
  await assert.rejects(service.sendTicket(eventId, firstId, "eindhoven"), /no ticket image/);
});

test("receipt updates only the original charge when its email is different", async () => {
  const { EventModel } = fixture();
  const calls = [];
  const stripe = {
    paymentIntents: { retrieve: async (id) => {
      calls.push(["retrieve", id]);
      return { id, status: "succeeded", latest_charge: { id: "ch_paid", payment_intent: id,
        paid: true, refunded: false, amount: 1000, amount_refunded: 0 } };
    } },
    charges: { update: async (id, values) => { calls.push(["update", id, values]); return { id }; } },
  };
  const service = createGuestDeliveryService({ EventModel, stripeForRegion: region => {
    assert.equal(region, "eindhoven"); return stripe;
  } });
  assert.deepEqual(await service.sendReceipt(eventId, firstId, "eindhoven"),
    { email: "guest@example.com", method: "stripe-email" });
  assert.deepEqual(calls, [["retrieve", "pi_paid"], ["update", "ch_paid", { receipt_email: "guest@example.com" }]]);
});

test("receipt resends the Stripe-hosted link when Stripe already has the same email", async () => {
  const { EventModel } = fixture();
  const delivered = [];
  const receiptUrl = "https://pay.stripe.com/receipts/payment/example";
  const stripe = { paymentIntents: { retrieve: async () => ({ id: "pi_paid", status: "succeeded",
    latest_charge: { id: "ch_paid", paid: true, amount: 1000, amount_refunded: 0,
      receipt_email: "guest@example.com", receipt_url: receiptUrl } }) },
    charges: { update: async () => { throw new Error("Same-address updates are not a resend path"); } } };
  const service = createGuestDeliveryService({ EventModel, stripeForRegion: () => stripe,
    deliverReceiptLink: async message => delivered.push(message) });
  assert.deepEqual(await service.sendReceipt(eventId, firstId, "eindhoven"),
    { email: "guest@example.com", method: "receipt-link" });
  assert.deepEqual(delivered, [{ email: "guest@example.com", receiptUrl, eventName: "Event" }]);
});

test("receipt cannot be requested for free or fully refunded payments", async () => {
  const { event, EventModel } = fixture();
  let updates = 0;
  const stripe = { paymentIntents: { retrieve: async () => ({ id: "pi_paid", status: "succeeded",
    latest_charge: { id: "ch_paid", paid: true, amount: 1000, amount_refunded: 1000 } }) },
    charges: { update: async () => { updates++; } } };
  const service = createGuestDeliveryService({ EventModel, stripeForRegion: () => stripe });
  event.guestList[0].transactionId = "free_123";
  await assert.rejects(service.sendReceipt(eventId, firstId, "eindhoven"), /no Stripe payment receipt/);
  event.guestList[0].transactionId = "pi_paid";
  await assert.rejects(service.sendReceipt(eventId, firstId, "eindhoven"), /no active Stripe receipt/);
  assert.equal(updates, 0);
});

test("receipt rejects a mismatched payment and an untrusted receipt link", async () => {
  const { EventModel } = fixture();
  let intent = { id: "pi_paid", status: "succeeded", metadata: { eventId: "d".repeat(24) },
    latest_charge: { id: "ch_paid", paid: true, amount: 1000, amount_refunded: 0 } };
  const stripe = { paymentIntents: { retrieve: async () => intent },
    charges: { update: async () => { throw new Error("Should not update an unverified charge"); } } };
  const service = createGuestDeliveryService({ EventModel, stripeForRegion: () => stripe,
    deliverReceiptLink: async () => { throw new Error("Should not send an untrusted link"); } });
  await assert.rejects(service.sendReceipt(eventId, firstId, "eindhoven"), /another event/);
  intent = { ...intent, metadata: { eventId }, latest_charge: { ...intent.latest_charge,
    receipt_email: "guest@example.com", receipt_url: "https://example.com/receipts/payment/fake" } };
  await assert.rejects(service.sendReceipt(eventId, firstId, "eindhoven"), /no Stripe receipt link/);
});
