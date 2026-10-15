import test from "node:test";
import assert from "node:assert/strict";
import { ACCESS_3 } from "../util/config/defines.js";
import { archiveEvent } from "../services/events/archive-event.js";
import { cancellationCounts, createEventCancellationService, eventCancellationMessage } from "../services/events/event-cancellation.js";
import { refundEventTickets } from "../services/main-services/event-action-service.js";
import { refundStripePayment } from "../services/side-services/stripe.js";

const eventId = "a".repeat(24);
const ticket = (id, type, email, transactionId = "pi_group") => ({
  _id: { toString: () => id }, type, email, transactionId, name: email, refunded: false,
});

test("cancellation email shows the event poster and emphasizes cancelled", () => {
  const message = eventCancellationMessage({ title: "Autumn & <Social>", date: new Date("2026-10-17T17:00:00Z"),
    poster: "https://res.cloudinary.com/bgsnl/image/upload/poster.jpg?x=1&y=2", region: "groningen" }, "groningen@example.org");
  assert.match(message.html, /We are sorry to announce that this event is <strong style="color:#b42318;font-weight:700;">cancelled<\/strong>/);
  assert.match(message.html, /font-size:16px;line-height:1\.6;font-weight:400;">We are sorry/);
  assert.match(message.text, /^We are sorry to announce that this event is cancelled\./);
  assert.match(message.html, /class="bgsnl-event-preview"/);
  assert.match(message.html, />Groningen<\/span>/);
  assert.match(message.html, /bgcolor="#add8e6"/);
  assert.match(message.html, /border-radius:12px/);
  assert.doesNotMatch(message.html, /border-green/);
  assert.match(message.html, /Autumn &amp; &lt;Social&gt;/);
  assert.match(message.html, /17\.10 \| 19:00/);
  assert.match(message.html, /src="https:\/\/res\.cloudinary\.com\/bgsnl\/image\/upload\/poster\.jpg\?x=1&amp;y=2"/);
  assert.match(message.html, /alt="Autumn &amp; &lt;Social&gt; poster"/);
  assert.match(message.html, /A refund will be issued by the event organizer automatically/);
  assert.match(message.html, /mailto:groningen@example\.org\?subject=Question%20about%20cancelled%20event%3A%20Autumn%20%26%20%3CSocial%3E/);
  assert.doesNotMatch(eventCancellationMessage({ title: "Event", poster: "javascript:alert(1)" }, "groningen@example.org").html, /javascript:alert|alt="Event poster"/);
});

test("free ticket cancellation email does not promise a refund", () => {
  const event = { title: "Free social", isFree: true, date: new Date("2026-10-17T17:00:00Z"), region: "groningen" };
  const message = eventCancellationMessage(event, "groningen@example.org", [ticket("1", "free guest", "guest@example.org", "-")]);
  assert.match(message.text, /Your free ticket has been cancelled/);
  assert.doesNotMatch(message.text, /A refund will be issued/);
  assert.match(eventCancellationMessage(event, "groningen@example.org",
    [ticket("2", "guest", "paid@example.org")]).text, /A refund will be issued/);
});

test("only regional board and higher roles qualify for cancellation", () => {
  for (const role of ["regional_board_member", "board_member", "national_board_member", "society_board_member", "admin", "super_admin"]) {
    assert.ok(ACCESS_3.includes(role), role);
  }
  for (const role of ["active_member", "regional_committee_member", "committee_member", "national_committee_member", "member", "alumni"]) {
    assert.ok(!ACCESS_3.includes(role), role);
  }
});

test("cancellation archives and closes sales while recording durable work", async () => {
  const event = { _id: eventId, status: "opened", date: new Date(), region: "eindhoven", guestList: [],
    save: async () => {} };
  await archiveEvent(eventId, { cancel: true, deferCleanup: true, dependencies: {
    load: async () => event, lease: async (_key, work) => work({ assertOwned: async () => {} }),
    transaction: work => work({}), statistics: async () => {}, averages: async () => {}, dataPool: () => {},
    removeProduct: async () => {}, removeGuestTickets: async () => {}, refresh: () => {},
  } });
  assert.equal(event.status, "archived");
  assert.equal(event.isSaleClosed, true);
  assert.ok(event.cancellationRequestedAt instanceof Date);
  assert.equal(event.archiveCleanupPending, true);
});

test("one group purchase makes one full Stripe refund for all ticket rows", async () => {
  const event = { title: "Test event", date: new Date(), region: "eindhoven",
    guestList: [ticket("1", "guest", "a@example.org"), ticket("2", "guest", "b@example.org")],
    save: async () => {} };
  const calls = [];
  const result = await refundEventTickets(eventId, "event cancellation", "eindhoven", null, {
    mode: "full", idempotencyPrefix: `event-cancellation:${eventId}`,
    dependencies: { EventModel: { findById: async () => event }, refundPayment: async (...args) => {
      calls.push(args); return { success: true, refundId: "re_1" };
    } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "pi_group");
  assert.equal(calls[0][3].mode, "full");
  assert.equal(result.summary.refunded, 2);
  assert.ok(event.guestList.every(item => item.refunded && item.refundReason === "event cancellation"));
});

test("selecting one group ticket for a full refund also voids its siblings", async () => {
  const event = { title: "Test event", date: new Date(), region: "eindhoven",
    guestList: [ticket("1", "guest", "a@example.org"), ticket("2", "guest", "b@example.org")],
    save: async () => {} };
  let calls = 0;
  const result = await refundEventTickets(eventId, "event cancellation", "eindhoven", ["1"], {
    mode: "full", dependencies: { EventModel: { findById: async () => event },
      refundPayment: async () => { calls++; return { success: true, refundId: "re_1" }; } },
  });
  assert.equal(calls, 1);
  assert.equal(result.summary.refunded, 2);
  assert.ok(event.guestList.every(item => item.refunded));
});

test("event cancellation refunds the balance after an earlier fee-excluded refund", async () => {
  const guest = ticket("1", "guest", "a@example.org");
  guest.refunded = true;
  guest.refundAmountCents = 930;
  guest.refundIds = ["re_manual"];
  const event = { title: "Test event", date: new Date(), region: "eindhoven", guestList: [guest], save: async () => {} };
  let calls = 0;
  const result = await refundEventTickets(eventId, "event cancellation", "eindhoven", null, {
    mode: "full", refundRemainingPayments: true,
    dependencies: { EventModel: { findById: async () => event }, refundPayment: async () => {
      calls++; return { success: true, refundId: "re_balance", amountCents: 70 };
    } },
  });
  assert.equal(calls, 1);
  assert.equal(result.summary.refunded, 1);
  assert.equal(guest.refundAmountCents, 1000);
  assert.deepEqual(guest.refundIds, ["re_manual", "re_balance"]);
});

test("Stripe refund modes use charge totals, fee, and the supplied partial amount", async () => {
  const created = [];
  const stripeClient = {
    paymentIntents: { retrieve: async () => ({ latest_charge: { amount: 1000, amount_refunded: 0,
      balance_transaction: { fee: 75 } } }) },
    refunds: { create: async (data, request) => { created.push({ data, request }); return { id: "re_1", status: "pending" }; } },
  };
  for (const [mode, amountCents, expected] of [["full", undefined, 1000], ["partial", 400, 400], ["less_fees", undefined, 925]]) {
    const result = await refundStripePayment("eindhoven", "pi_1", "event cancellation",
      { mode, amountCents, idempotencyKey: `test:${mode}`, dependencies: { stripeClient } });
    assert.equal(result.success, true);
    assert.equal(created.at(-1).data.amount, expected);
    assert.equal(created.at(-1).request.idempotencyKey, `test:${mode}`);
  }
});

test("cancellation waits for refunds and emails each normalized address once", async () => {
  const event = { _id: eventId, title: "Society evening", region: "eindhoven", cancellationRequestedAt: new Date(),
    archiveCleanupPending: false, guestList: [ticket("1", "guest", " Person@Example.org "),
      ticket("2", "member", "person@example.org"), ticket("3", "guest", "other@example.org", "-")] };
  assert.deepEqual(cancellationCounts(event), {
    guest: 1, member: 1, paid: 2, free: 1,
    total: 3, guestTotal: 2, memberTotal: 1, guestFree: 1, memberFree: 0,
  });
  const sent = [];
  let failRefund = true;
  const service = createEventCancellationService({
    EventModel: { findById: async () => event, updateOne: async (_query, update) => Object.assign(event, update.$set) },
    loadContacts: async () => ({ eindhoven: "eindhoven@example.org" }),
    refund: async () => {
      if (failRefund) return { summary: { failed: 2 } };
      event.guestList.forEach(item => { item.refunded = true; });
      return { summary: { failed: 0 } };
    },
    send: async (_template, email, variables, options) => sent.push({ email, text: variables.text, operationId: options.operationId }),
    lease: async (_key, work) => work({ assertOwned: async () => {} }),
  });
  const first = await service.process(eventId);
  assert.ok(first.failed > 0);
  assert.equal(sent.length, 0);
  failRefund = false;
  const second = await service.process(eventId);
  assert.equal(second.failed, 0);
  assert.deepEqual(sent.map(item => item.email).sort(), ["other@example.org", "person@example.org"]);
  assert.match(sent.find(item => item.email === "other@example.org").text, /No payment was taken, so no refund is due/);
  assert.match(sent.find(item => item.email === "person@example.org").text, /A refund will be issued/);
  assert.equal(new Set(sent.map(item => item.operationId)).size, 2);
  await service.process(eventId);
  assert.equal(sent.length, 2);
  assert.ok(event.cancellationCompletedAt);
});

test("cancellation preview separates free member and guest tickets", () => {
  const event = { guestList: [
    ticket("1", "guest", "guest@example.org"),
    ticket("2", "free guest", "guest2@example.org", "-"),
    ticket("3", "free member", "member@example.org", "-"),
  ] };
  assert.deepEqual(cancellationCounts(event), {
    guest: 1, member: 0, paid: 1, free: 2,
    total: 3, guestTotal: 2, memberTotal: 1, guestFree: 1, memberFree: 1,
  });
});

test("cancellation retries without sending when the event region has no contact email", async () => {
  const event = { _id: eventId, title: "Society evening", region: "eindhoven", cancellationRequestedAt: new Date(),
    archiveCleanupPending: false, guestList: [ticket("1", "guest", "person@example.org")] };
  event.guestList[0].refunded = true;
  let sends = 0;
  const service = createEventCancellationService({
    EventModel: { findById: async () => event, updateOne: async (_query, update) => Object.assign(event, update.$set) },
    loadContacts: async () => ({}), refund: async () => ({ summary: { failed: 0 } }),
    send: async () => { sends++; }, lease: async (_key, work) => work({ assertOwned: async () => {} }),
  });
  assert.equal((await service.process(eventId)).failed, 1);
  assert.equal(sends, 0);
  assert.ok(event.cancellationRetryAt instanceof Date);
});

test("provider retry reuses the same Mailer operation without delivery records", async () => {
  const event = { _id: eventId, title: "Society evening", region: "eindhoven", cancellationRequestedAt: new Date(),
    archiveCleanupPending: false, guestList: [ticket("1", "guest", "person@example.org")] };
  event.guestList[0].refunded = true;
  let attempts = 0;
  const attempted = [];
  const service = createEventCancellationService({
    EventModel: { findById: async () => event, updateOne: async (_query, update) => Object.assign(event, update.$set) },
    loadContacts: async () => ({ eindhoven: "eindhoven@example.org" }),
    refund: async () => ({ summary: { failed: 0 } }),
    send: async (_template, _email, variables, options) => {
      attempted.push({ variables, operationId: options.operationId });
      if (attempts++ === 0) throw new Error("Acceptance timed out");
    },
    lease: async (_key, work) => work({ assertOwned: async () => {} }),
  });
  assert.equal((await service.process(eventId)).failed, 1);
  assert.equal((await service.process(eventId)).failed, 0);
  assert.equal(attempted.length, 2);
  assert.deepEqual(attempted[0], attempted[1]);
});
