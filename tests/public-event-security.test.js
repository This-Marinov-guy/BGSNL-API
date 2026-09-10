import assert from "node:assert/strict";
import test from "node:test";
import { eventSlugify, uniqueEventSlug } from "../services/public-content/event-slug.js";
import { serializePublicEvent } from "../services/public-content/event-publication.js";

test("event slug is stable, readable and collision-safe", async () => {
  assert.equal(eventSlugify("Bългарски & Dutch — 2026!"), "b-and-dutch-2026");
  const seen = new Set(["spring-dinner"]);
  const Event = { exists: async ({ slug }) => seen.has(slug) };
  assert.equal(await uniqueEventSlug(Event, "Spring dinner"), "spring-dinner-2");
});

test("the public event projection does not leak operational or attendee data", () => {
  const event = serializePublicEvent({
    _id: "507f1f77bcf86cd799439011",
    slug: "spring-dinner",
    region: "groningen",
    title: "Spring dinner",
    description: "Public description",
    text: "Public details",
    date: new Date("2026-04-01T18:00:00.000Z"),
    ticketTimer: new Date("2026-03-30T18:00:00.000Z"),
    ticketLimit: 10,
    guestList: [{ name: "Private attendee", email: "private@example.test" }],
    folder: "private-cloud-folder",
    sheetName: "private-sheet",
    googleEventId: "private-calendar-id",
    product: {
      guest: { price: 12, priceId: "price_private" },
      promoCodes: [{ code: "PRIVATE" }],
    },
    addOns: { isEnabled: true, items: [{ title: "Drink", price: 2, priceId: "price_addon_private" }] },
    ticketImg: "poster.png",
    ticketColor: "#fff",
    poster: "poster.png",
    bgImage: 1,
  }, { checkout: true });

  const serialized = JSON.stringify(event);
  assert.equal(event.ticketsRemaining, 9);
  for (const forbidden of ["Private attendee", "private@example.test", "private-cloud-folder", "private-sheet", "private-calendar-id", "price_private", "PRIVATE", "price_addon_private"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.equal(event.product.guest.price, 12);
  assert.equal(event.addOns.items[0].price, 2);
});
