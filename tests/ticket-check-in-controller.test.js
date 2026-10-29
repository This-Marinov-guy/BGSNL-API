import test from "node:test";
import assert from "node:assert/strict";
import Event from "../models/Event.js";
import ManagedNationalEvent from "../models/ManagedNationalEvent.js";
import { updatePresence, updateGuestPresence, updateGuestDetails, getEventGuestList } from "../controllers/Events/events-controllers.js";
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
test("managed national guest lists load for national staff without exposing legacy records", async () => {
  const originalRegional = Event.findById;
  const originalNational = ManagedNationalEvent.findOne;
  const nationalEvent = new ManagedNationalEvent({ _id: eventId, title: "National event", region: "netherlands",
    status: "opened", guestList: [{ _id: "b".repeat(24), code: 123, name: "Guest", email: "guest@example.com" }] });
  let nationalQuery;
  try {
    Event.findById = () => ({ select: async () => null });
    ManagedNationalEvent.findOne = query => {
      nationalQuery = query;
      return { select: async () => nationalEvent };
    };
    const read = async user => {
      let data, error;
      await getEventGuestList({ path: "/guest-list/test", params: { eventId }, user },
        { set() {}, status() { return this; }, json(value) { data = value; } }, value => { error = value; });
      return { data, error };
    };
    const allowed = await read({ roles: ["national_committee_member"], region: "netherlands" });
    assert.equal(allowed.error, undefined);
    assert.equal(allowed.data.guestList[0].name, "Guest");
    assert.deepEqual(nationalQuery, { _id: eventId, title: { $type: "string" } });
    assert.equal((await read({ roles: ["regional_board_member"], region: "groningen" })).error.code, 403);
    let preview, previewError;
    await updatePresence({ body: { eventId, code: 123, preview: true }, user: { roles: ["national_committee_member"], region: "netherlands" } },
      { set() {}, status() { return this; }, json(value) { preview = value; } }, value => { previewError = value; });
    assert.equal(previewError, undefined);
    assert.equal(preview.eventId, eventId);
    assert.equal(preview.guests[0].name, "Guest");
  } finally {
    Event.findById = originalRegional;
    ManagedNationalEvent.findOne = originalNational;
  }
});
test("national attendance and attendee edits target the managed collection", async () => {
  const originalRegional = Event.findById;
  const originalNational = ManagedNationalEvent.findOne;
  const originalUpdate = ManagedNationalEvent.updateOne;
  const guestId = "b".repeat(24);
  const nationalEvent = new ManagedNationalEvent({ _id: eventId, title: "National event", region: "netherlands",
    guestList: [{ _id: guestId, name: "Guest", email: "guest@example.com" }] });
  const writes = [];
  try {
    Event.findById = () => ({ select: async () => null });
    ManagedNationalEvent.findOne = () => ({ select: async () => nationalEvent });
    ManagedNationalEvent.updateOne = async filter => { writes.push(filter); return { matchedCount: 0 }; };
    const user = { roles: ["national_committee_member"], region: "netherlands" };
    let presenceError, editError;
    await updateGuestPresence({ body: { eventId, guestId, present: true }, user }, {}, value => { presenceError = value; });
    await updateGuestDetails({ params: { eventId, guestId }, body: { name: "Updated", email: "updated@example.com", phone: "" }, user },
      {}, value => { editError = value; });
    assert.equal(presenceError.code, 409);
    assert.equal(editError.code, 409);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].region, "netherlands");
    assert.equal(writes[1]["guestList._id"], guestId);
  } finally {
    Event.findById = originalRegional;
    ManagedNationalEvent.findOne = originalNational;
    ManagedNationalEvent.updateOne = originalUpdate;
  }
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
    event.cancellationRequestedAt = new Date();
    assert.equal((await run({ token })).code, 422);
    assert.equal(writes, 1);
    delete event.cancellationRequestedAt;
    event.guestList[0].refunded = true;
    assert.equal((await run({ token })).code, 422);
    assert.equal(writes, 1);
  } finally { Event.findById = originals.find; Event.updateOne = originals.update; Event.findOne = originals.one;
    delete event.guestList[0].refunded; delete event.cancellationRequestedAt; }
});

test("issued links use a short opaque token and duplicate purchase codes fail safely", async () => {
  const originalExists = Event.exists;
  const originalNationalExists = ManagedNationalEvent.exists;
  try {
    Event.exists = async () => null;
    ManagedNationalEvent.exists = async () => null;
    const issued = await reserveTicketToken({ _id: eventId, ticketQR: true }, 123);
    assert.match(issued, /^[A-Za-z0-9_-]{22}$/);
    const link = ticketQrLink(issued);
    assert.equal(link, `https://bulgariansociety.nl/t/${issued}`);
    assert.ok(link.length < 55);
    // An already-issued purchase code must never be aliased to a second token.
    Event.exists = async () => ({ _id: eventId });
    await assert.rejects(reserveTicketToken({ _id: eventId, ticketQR: true }, 123), /already issued/);
  } finally { Event.exists = originalExists; ManagedNationalEvent.exists = originalNationalExists; }
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

test("scanner responses include separate tickets with the scanned email", async () => {
  const originals = { find: Event.findById, one: Event.findOne };
  let data, error;
  try {
    const scanned = { ...event.guestList[0], email: "guest@example.com" };
    const second = { _id: "c".repeat(24), code: 456, name: "Test", email: "GUEST@example.com", status: 0 };
    const unrelated = { _id: "d".repeat(24), code: 789, name: "Other", email: "other@example.com", status: 0 };
    Event.findOne = () => ({ select: () => ({ lean: async () => ({ _id: eventId, guestList: [{ code: 123, ticketToken: token }] }) }) });
    Event.findById = () => ({ select: async () => ({ ...event, guestList: [scanned, second, unrelated] }) });
    const response = { set() {}, status() { return this; }, json(value) { data = value; } };
    await updatePresence({ body: { token, expectedEventId: eventId, includeDetails: true }, user: { roles: [], region: "groningen" } }, response, value => { error = value; });
    assert.equal(error, undefined);
    assert.equal(data.outcome, "choose_quantity");
    assert.equal(data.total, 2);
    assert.equal(data.remaining, 2);
    assert.deepEqual(data.guests.map(guest => guest.id), [scanned._id, second._id]);
    assert.deepEqual(data.ticketDetails.map(guest => guest.id), [scanned._id, second._id]);
    assert.equal(data.groupIds, undefined);
  } finally { Event.findById = originals.find; Event.findOne = originals.one; }
});

test("events without printed QR tickets still reserve unique tokens", async () => {
  const originalExists = Event.exists;
  const originalNationalExists = ManagedNationalEvent.exists;
  let queries = 0;
  try {
    Event.exists = async () => { queries++; return null; };
    ManagedNationalEvent.exists = async () => null;
    const first = await reserveTicketToken({ _id: eventId, ticketQR: false }, 123);
    const second = await reserveTicketToken({ _id: eventId }, 124);
    assert.match(first, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(first, second);
    assert.equal(queries, 6);
    // The identity contract still applies before the QR flag is consulted.
    await assert.rejects(reserveTicketToken({ ticketQR: true }, 123), /Missing ticket identity/);
    await assert.rejects(reserveTicketToken({ _id: eventId, ticketQR: true }, "abc"), /Missing ticket identity/);
  } finally { Event.exists = originalExists; ManagedNationalEvent.exists = originalNationalExists; }
});
