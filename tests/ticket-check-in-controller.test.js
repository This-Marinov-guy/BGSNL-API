import test from "node:test";
import assert from "node:assert/strict";
import Event from "../models/Event.js";
import { updatePresence, getEventGuestList } from "../controllers/Events/events-controllers.js";
import { reserveTicketToken, ticketQrLink } from "../services/tickets/qr-link.js";

const eventId = "a".repeat(24), token = "abcdefghijklmnopqrstuv";
const event = { _id: eventId, id: eventId, title: "Test event", region: "groningen", guestList: [{ _id: "b".repeat(24), code: 123, name: "Test", status: 0 }] };
test("live guest-list reads preserve regional and read-only analytics scope", async () => {
  const original = Event.findById;
  let current = { ...event, status: "opened", guestList: event.guestList.map(guest => ({ ...guest, phone: "+31600000000", ticket: "https://example.com/ticket.png", transactionId: "pi_test_fixture" })) };
  Event.findById = () => ({ select: async () => current });
  try {
    async function read(region, path = "/guest-list/test") {
      let error, data; const headers = {};
      const response = { set(key, value) { headers[key] = value; }, status() { return this; }, json(value) { data = value; } };
      await getEventGuestList({ path, params: { eventId }, user: { roles: ["regional_committee_member"], region } }, response, value => { error = value; });
      return { error, data, headers };
    }
    const allowed = await read("groningen");
    assert.equal(allowed.data.guestList.length, 1);
    assert.equal(allowed.data.guestList[0].phone, "+31600000000");
    assert.equal(allowed.data.guestList[0].ticket, "https://example.com/ticket.png");
    assert.equal(allowed.data.guestList[0].transactionId, "pi_test_fixture");
    assert.equal(allowed.headers["Cache-Control"], "private, no-store");
    assert.equal((await read("amsterdam")).error.code, 403);
    assert.equal((await read("amsterdam", "/guest-list/test/stream")).error.code, 403);
    current = { ...event, status: "draft" };
    assert.equal((await read("groningen")).error.code, 403);
    assert.equal((await read("groningen", "/guest-list/test/stream")).error.code, 403);
  } finally { Event.findById = original; }
});
test("short QR resolves server-side and region, wrong-event, refund and conflict checks fail closed", async () => {
  const originals = { find: Event.findById, update: Event.updateOne, one: Event.findOne };
  let writes = 0;
  try {
    Event.findOne = () => ({ select: () => ({ lean: async () => ({ _id: eventId, guestList: [{ code: 123, ticketToken: token }] }) }) });
    Event.findById = () => ({ select: async () => event });
    Event.updateOne = async () => { writes++; return { modifiedCount: 0 }; };
    async function run(body, region = "groningen") {
      let error;
      await updatePresence({ body, user: { roles: [], region } }, {}, value => { error = value; });
      return error;
    }
    assert.equal((await run({ token }, "amsterdam")).code, 403);
    assert.equal(writes, 0);
    assert.equal((await run({ token, expectedEventId: "c".repeat(24) })).code, 422);
    assert.equal(writes, 0);
    assert.equal((await run({ token })).code, 409);
    assert.equal(writes, 1);
    event.guestList[0].refunded = true;
    assert.equal((await run({ token })).code, 422);
    assert.equal(writes, 1);
  } finally { Event.findById = originals.find; Event.updateOne = originals.update; Event.findOne = originals.one; delete event.guestList[0].refunded; }
});

test("issued links use a short opaque token and duplicate purchase codes fail safely", async () => {
  const originalExists = Event.exists;
  try {
    Event.exists = async () => null;
    const issued = await reserveTicketToken({ _id: eventId, ticketQR: true }, 123);
    assert.match(issued, /^[A-Za-z0-9_-]{22}$/);
    const link = ticketQrLink(issued);
    assert.equal(link, `https://bulgariansociety.nl/t/${issued}`);
    assert.ok(link.length < 55);
    // An already-issued purchase code must never be aliased to a second token.
    Event.exists = async () => ({ _id: eventId });
    await assert.rejects(reserveTicketToken({ _id: eventId, ticketQR: true }, 123), /already issued/);
  } finally { Event.exists = originalExists; }
});

test("manual scan previews never write attendance", async () => {
  const originals = { find: Event.findById, update: Event.updateOne, one: Event.findOne };
  let writes = 0, data, error;
  try {
    Event.findOne = () => ({ select: () => ({ lean: async () => ({ _id: eventId, guestList: [{ code: 123, ticketToken: token }] }) }) });
    Event.findById = () => ({ select: async () => event });
    Event.updateOne = async () => { writes++; return { modifiedCount: 1 }; };
    const response = { set() {}, status() { return this; }, json(value) { data = value; } };
    await updatePresence({ body: { token, expectedEventId: eventId, preview: true }, user: { roles: [], region: "groningen" } }, response, value => { error = value; });
    assert.equal(error, undefined);
    assert.equal(data.outcome, "confirm_required");
    assert.equal(data.name, "Test");
    assert.equal(data.remaining, 1);
    assert.deepEqual(data.guests, [{ id: "b".repeat(24), name: "Test", present: false }]);
    assert.equal(writes, 0);
    assert.equal(data.ticketDetails, undefined);
    await updatePresence({ body: { token, expectedEventId: eventId, includeDetails: true }, user: { roles: [], region: "groningen" } }, response, value => { error = value; });
    assert.equal(error, undefined);
    assert.equal(data.outcome, "confirm_required");
    assert.equal(data.ticketDetails.length, 1);
    assert.equal(data.ticketDetails[0].id, "b".repeat(24));
    assert.equal(data.ticketDetails[0].name, "Test");
    assert.equal(writes, 0);
  } finally { Event.findById = originals.find; Event.updateOne = originals.update; Event.findOne = originals.one; }
});

test("events without printed QR tickets still reserve unique tokens", async () => {
  const originalExists = Event.exists;
  let queries = 0;
  try {
    Event.exists = async () => { queries++; return null; };
    const first = await reserveTicketToken({ _id: eventId, ticketQR: false }, 123);
    const second = await reserveTicketToken({ _id: eventId }, 124);
    assert.match(first, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(first, second);
    assert.equal(queries, 4);
    // The identity contract still applies before the QR flag is consulted.
    await assert.rejects(reserveTicketToken({ ticketQR: true }, 123), /Missing ticket identity/);
    await assert.rejects(reserveTicketToken({ _id: eventId, ticketQR: true }, "abc"), /Missing ticket identity/);
  } finally { Event.exists = originalExists; }
});
