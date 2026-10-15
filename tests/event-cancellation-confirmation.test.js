import test from "node:test";
import assert from "node:assert/strict";
import { beginEventCancellation, canCancelEventWithoutEmail, createEventCancellationConfirmationService, DEV_CANCELLATION_EMAIL } from "../services/events/event-cancellation-confirmation.js";
import { EVENT_CANCELLATION_CONFIRM_TEMPLATE } from "../util/config/defines.js";

const event = { _id: "a".repeat(24), title: "Autumn social", region: "groningen",
  date: new Date("2026-10-17T17:00:00Z"), guestList: [
    { type: "guest", transactionId: "pi_123" }, { type: "free member", transactionId: "-" },
  ] };

function fixture({ environment = "prod", sendFailure = false } = {}) {
  let timestamp = Date.parse("2026-10-14T12:00:00Z");
  const rows = new Map();
  const sent = [];
  const matches = (row, query) => row && Object.entries(query).every(([key, value]) => {
    if (key === "_id") return row._id === value;
    if (value?.$gt !== undefined) return row[key] > value.$gt;
    return row[key] === value;
  });
  const records = {
    findById: async id => rows.get(id) || null,
    findOneAndUpdate: async (query, update, options = {}) => {
      let row = rows.get(query._id);
      if (!matches(row, query)) {
        if (!options.upsert) return null;
        row = { _id: query._id };
      }
      Object.assign(row, update.$set || {});
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] += value;
      rows.set(query._id, row);
      return row;
    },
    findOneAndDelete: async query => {
      const row = rows.get(query._id);
      if (!matches(row, query)) return null;
      rows.delete(query._id);
      return row;
    },
    deleteOne: async query => {
      const row = rows.get(query._id);
      if (matches(row, query)) rows.delete(query._id);
    },
  };
  const service = createEventCancellationConfirmationService({
    records, lease: async (_key, work) => work(), now: () => new Date(timestamp),
    env: { APP_ENV: environment, JWT_STRING: "unit-test-secret" }, createCode: () => "01234567",
    loadContacts: async () => ({ groningen: "groningen@example.org" }),
    send: async (...args) => { sent.push(args); if (sendFailure) throw new Error("Mailer unavailable"); },
  });
  return { service, rows, sent, advance: ms => { timestamp += ms; } };
}

test("request stores a hashed, expiring code and sends the automation to the DB regional address", async () => {
  const f = fixture();
  assert.equal(await f.service.recipient(event), "groningen@example.org");
  assert.equal(f.rows.size, 0);
  assert.equal(f.sent.length, 0);
  const result = await f.service.request(event);
  assert.equal(result.sent, true);
  assert.equal(result.sentTo, "gr••••••@example.org");
  assert.equal(f.sent[0][0], EVENT_CANCELLATION_CONFIRM_TEMPLATE);
  assert.equal(f.sent[0][1], "groningen@example.org");
  assert.equal(f.sent[0][2].code, "01234567");
  assert.deepEqual([f.sent[0][2].ticketCount, f.sent[0][2].paidCount, f.sent[0][2].freeCount], [2, 1, 1]);
  assert.equal(f.rows.get(event._id).code, undefined);
  assert.notEqual(f.rows.get(event._id).codeHash, "01234567");
  assert.equal(f.rows.get(event._id).expiresAt.getTime() - f.rows.get(event._id).requestedAt.getTime(), 600_000);
  assert.equal((await f.service.pending(event._id)).sentTo, result.sentTo);
});

test("dev sends to the developer while still using the DB regional contact", async () => {
  const f = fixture({ environment: "dev" });
  assert.equal(await f.service.recipient(event), DEV_CANCELLATION_EMAIL);
  await f.service.request(event);
  assert.equal(f.sent[0][1], DEV_CANCELLATION_EMAIL);
  assert.equal(f.rows.get(event._id).recipient, DEV_CANCELLATION_EMAIL);
});

test("only admins and super admins bypass the cancellation email", () => {
  assert.equal(canCancelEventWithoutEmail(["admin"]), true);
  assert.equal(canCancelEventWithoutEmail(["regional_board_member", "super_admin"]), true);
  assert.equal(canCancelEventWithoutEmail(["national_board_member"]), false);
  assert.equal(canCancelEventWithoutEmail(["regional_board_member"]), false);
  assert.equal(canCancelEventWithoutEmail(undefined), false);
});

test("admin cancellation runs without sending a code; regional cancellation requests one", async () => {
  const f = fixture();
  let cancellations = 0;
  const admin = await beginEventCancellation({ roles: ["admin"], event,
    cancel: async () => { cancellations += 1; }, confirmationService: f.service });
  assert.deepEqual(admin, { confirmationRequired: false, cancellationQueued: true });
  assert.equal(cancellations, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.rows.size, 0);

  const regional = await beginEventCancellation({ roles: ["regional_board_member"], event,
    cancel: async () => { cancellations += 1; }, confirmationService: f.service });
  assert.equal(regional.confirmationRequired, true);
  assert.equal(regional.confirmation.sent, true);
  assert.equal(cancellations, 1);
  assert.equal(f.sent.length, 1);
});

test("confirmation is single use, limits guesses, and only then cancels", async () => {
  const f = fixture();
  let cancellations = 0;
  await f.service.request(event);
  await assert.rejects(f.service.confirm(event, "11111111", async () => { cancellations++; }), /incorrect/);
  assert.equal(f.rows.get(event._id).attemptsLeft, 4);
  assert.equal(cancellations, 0);
  await f.service.confirm(event, "01234567", async () => { cancellations++; });
  assert.equal(cancellations, 1);
  assert.equal(f.rows.size, 0);
  await assert.rejects(f.service.confirm(event, "01234567", async () => { cancellations++; }), /incorrect/);
  assert.equal(cancellations, 1);
});

test("resend is throttled, expiry rejects old codes, and a failed send removes its code", async () => {
  const f = fixture();
  await f.service.request(event);
  assert.equal((await f.service.request(event)).sent, false);
  assert.equal(f.sent.length, 1);
  f.advance(600_001);
  await assert.rejects(f.service.confirm(event, "01234567", async () => {}), /incorrect/);
  assert.equal(await f.service.pending(event._id), null);

  const failed = fixture({ sendFailure: true });
  await assert.rejects(failed.service.request(event), /could not send/);
  assert.equal(failed.rows.size, 0);
});

test("five wrong codes lock the request until the resend interval passes", async () => {
  const f = fixture();
  await f.service.request(event);
  for (let attempt = 0; attempt < 5; attempt++) {
    await assert.rejects(f.service.confirm(event, "11111111", async () => {}), /incorrect/);
  }
  await assert.rejects(f.service.request(event), /after one minute/);
  f.advance(60_001);
  assert.equal((await f.service.request(event)).sent, true);
  assert.equal(f.sent.length, 2);
});
