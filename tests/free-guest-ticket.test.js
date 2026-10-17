import test from "node:test";
import assert from "node:assert/strict";
import { createFreeGuestTicketDeletion, isFreeGuestTicket } from "../services/tickets/free-guest-ticket.js";

const eventId = "a".repeat(24);
const firstId = "b".repeat(24);
const secondId = "c".repeat(24);
const ticket = (_id, changes = {}) => ({ _id, name: "A Guest", email: "guest@example.com",
  type: "guest", transactionId: "free_123", ticket: "ticket.webp", ...changes });

const fixture = (entries) => {
  const guestList = [...entries];
  guestList.id = id => guestList.find(guest => guest._id === id);
  const event = { _id: eventId, region: "eindhoven", guestList };
  const updates = [];
  const EventModel = {
    findById: () => ({ select: () => ({ session: async () => event }) }),
    updateOne: async (...args) => { updates.push(["event", ...args]); return { modifiedCount: 1 }; },
  };
  const MemberModel = { updateMany: async (...args) => { updates.push(["member", ...args]); } };
  const AlumniModel = { updateMany: async (...args) => { updates.push(["alumni", ...args]); } };
  const remove = createFreeGuestTicketDeletion({ EventModel, MemberModel, AlumniModel,
    transaction: async work => work({ fixture: true }) });
  return { remove, updates };
};

test("free ticket classification excludes paid add-on purchases and paid legacy rows", () => {
  assert.equal(isFreeGuestTicket(ticket(firstId)), true);
  assert.equal(isFreeGuestTicket(ticket(firstId, { transactionId: "-", type: "free member" })), true);
  assert.equal(isFreeGuestTicket(ticket(firstId, { transactionId: "pi_paid" })), false);
  assert.equal(isFreeGuestTicket(ticket(firstId, { transactionId: "pi_paid", type: "free guest" })), false);
  assert.equal(isFreeGuestTicket(ticket(firstId, { transactionId: "-", type: "guest" })), false);
});

test("deleting a free row targets only that row and preserves a shared QR ticket", async () => {
  const { remove, updates } = fixture([ticket(firstId), ticket(secondId)]);
  assert.deepEqual(await remove(eventId, firstId, event => event.region === "eindhoven"),
    { id: firstId, name: "A Guest" });
  assert.equal(updates.length, 1);
  assert.equal(updates[0][2].$pull.guestList._id, firstId);
});

test("member ticket deletion removes the exact ticket image from both account collections", async () => {
  const { remove, updates } = fixture([ticket(firstId, { type: "free member", transactionId: "-", userId: "member_1" })]);
  await remove(eventId, firstId, () => true);
  assert.deepEqual(updates.map(call => call[0]), ["event", "member", "alumni"]);
  assert.deepEqual(updates[1][2], { $pull: { tickets: { image: "ticket.webp" } } });
});

test("a free guest-priced ticket linked to a member account also clears the account copy", async () => {
  const { remove, updates } = fixture([ticket(firstId, { type: "guest", userId: "member_1" })]);
  await remove(eventId, firstId, () => true);
  assert.deepEqual(updates.map(call => call[0]), ["event", "member", "alumni"]);
});

test("paid tickets and another region cannot be deleted", async () => {
  const { remove, updates } = fixture([ticket(firstId, { transactionId: "pi_paid" })]);
  await assert.rejects(remove(eventId, firstId, () => true), /Only free tickets/);
  await assert.rejects(remove(eventId, firstId, () => false), /No access/);
  assert.equal(updates.length, 0);
});
