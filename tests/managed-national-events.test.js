import assert from "node:assert/strict";
import test from "node:test";
import Event from "../models/Event.js";
import ManagedNationalEvent from "../models/ManagedNationalEvent.js";
import NonSocietyEvent from "../models/NonSocietyEvent.js";
import {
  eventModelForId,
  eventModelForRegion,
  isNationalEventManager,
  managedNationalEventQuery,
  publicEventRegion,
} from "../services/events/managed-event-store.js";
import { serializePublicEvent } from "../services/public-content/event-publication.js";
import migration from "../migrations/022-managed-national-event-slugs.js";
import { postCheckoutFile } from "../controllers/payments-controllers.js";

test("national records reuse the event schema in the legacy special collection", () => {
  assert.equal(ManagedNationalEvent.collection.collectionName, NonSocietyEvent.collection.collectionName);
  assert.notEqual(ManagedNationalEvent.collection.collectionName, Event.collection.collectionName);
  assert.equal(ManagedNationalEvent.schema.path("guestList").instance, Event.schema.path("guestList").instance);
  assert.equal(eventModelForRegion("netherlands"), ManagedNationalEvent);
  assert.equal(eventModelForRegion("national"), ManagedNationalEvent);
  assert.equal(eventModelForRegion("groningen"), Event);
  assert.deepEqual(managedNationalEventQuery, { title: { $type: "string" } });
});

test("only admins and national roles can manage national events", () => {
  for (const role of ["super_admin", "admin", "national_board_member", "national_committee_member"]) {
    assert.equal(isNationalEventManager([role]), true);
  }
  for (const role of ["society_board_member", "regional_board_member", "regional_committee_member", "active_member"]) {
    assert.equal(isNationalEventManager([role]), false);
  }
});

test("national public records use the national URL segment", () => {
  const event = new ManagedNationalEvent({ title: "Düsseldorf guest lecture", region: "netherlands",
    date: new Date("2026-11-28T13:00:00Z"), ticketLimit: 50, isFree: true });
  const publicRecord = serializePublicEvent(event);
  assert.equal(publicRecord.region, "national");
  assert.equal(publicRecord.isFree, true);
  assert.equal(publicEventRegion("netherlands"), "national");
  assert.equal(serializePublicEvent(new Event({ title: "Regional event", region: "groningen" })).region, "groningen");
});

test("legacy special rows do not resolve as managed events", async () => {
  const id = "a".repeat(24);
  const oldRegionalExists = Event.exists;
  const oldNationalExists = ManagedNationalEvent.exists;
  try {
    Event.exists = async () => null;
    ManagedNationalEvent.exists = async query => {
      assert.deepEqual(query, { _id: id, ...managedNationalEventQuery });
      return null;
    };
    assert.equal(await eventModelForId(id), Event);
    ManagedNationalEvent.exists = async () => ({ _id: id });
    assert.equal(await eventModelForId(id), ManagedNationalEvent);
  } finally {
    Event.exists = oldRegionalExists;
    ManagedNationalEvent.exists = oldNationalExists;
  }
});

test("migration protects national slugs without indexing legacy registrations", async () => {
  let index;
  await migration.up({ collection(name) {
    assert.equal(name, "nonSocietyEvents");
    return { createIndex: async (keys, options) => { index = { keys, options }; } };
  } });
  assert.deepEqual(index.keys, { region: 1, slug: 1 });
  assert.equal(index.options.unique, true);
  assert.deepEqual(index.options.partialFilterExpression, { slug: { $type: "string" } });
});

test("free national registration issues a ticket and returns to the national page", async () => {
  const event = { _id: "a".repeat(24), title: "Düsseldorf guest lecture", region: "netherlands",
    date: new Date("2099-11-28T13:00:00Z"), ticketTimer: new Date("2099-11-28T13:00:00Z"),
    guestList: [], ticketLimit: 50, isFree: true, status: "opened", addOns: { items: [] } };
  const req = { body: { origin_url: "https://bulgariansociety.nl", eventId: event._id,
    method: "buy_guest_ticket", quantity: "1", addOns: "[]", guestName: "Guest" } };
  let issued, returned, response;
  await postCheckoutFile(req, { status() { return this; }, json(value) { response = value; } }, error => { throw error; }, {
    loadEvent: async () => event,
    reserveToken: async () => "abcdefghijklmnopqrstuv",
    generateTicket: async () => "https://tickets.example.test/ticket.png",
    fulfillGuest: async metadata => { issued = metadata; },
    freeReturn: async data => { returned = data; return "https://bulgariansociety.nl/payment/return/test"; },
  });
  assert.equal(issued.region, "netherlands");
  assert.equal(returned.region, "netherlands");
  assert.equal(returned.returnPath, `/national/event-details/${event._id}`);
  assert.equal(response.free, true);
});

test("paid national checkout selects the Netherlands Stripe account", async () => {
  const event = { _id: "b".repeat(24), title: "Paid national event", region: "netherlands",
    date: new Date("2099-11-28T13:00:00Z"), ticketTimer: new Date("2099-11-28T13:00:00Z"),
    guestList: [], ticketLimit: 50, isFree: false, status: "opened", addOns: { items: [] } };
  const req = { body: { origin_url: "https://bulgariansociety.nl", eventId: event._id,
    method: "buy_guest_ticket", quantity: "1", addOns: "[]", guestName: "Guest" } };
  let stripeRegion, checkout, response;
  await postCheckoutFile(req, { status() { return this; }, json(value) { response = value; } }, error => { throw error; }, {
    loadEvent: async () => event,
    reserveToken: async () => "abcdefghijklmnopqrstuv",
    generateTicket: async () => "https://tickets.example.test/ticket.png",
    resolveLineItem: async () => ({ price: "price_national", quantity: 1 }),
    stripeForRegion: region => { stripeRegion = region; return {}; },
    createCheckout: async data => { checkout = data; return { url: "https://checkout.stripe.test/session" }; },
  });
  assert.equal(stripeRegion, "netherlands");
  assert.equal(checkout.checkoutData.metadata.region, "netherlands");
  assert.equal(checkout.checkoutData.line_items[0].price, "price_national");
  assert.equal(response.url, "https://checkout.stripe.test/session");
});
