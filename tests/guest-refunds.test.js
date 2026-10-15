import test from "node:test";
import assert from "node:assert/strict";
import { ACCESS_3 } from "../util/config/defines.js";
import { calculateGuestRefund, createGuestRefundService } from "../services/tickets/guest-refunds.js";
import { getStripeRefundQuote, refundStripePayment } from "../services/side-services/stripe.js";

const eventId = "a".repeat(24);
const firstId = "b".repeat(24);
const secondId = "c".repeat(24);
const quote = { amountCents: 1000, refundedCents: 0, remainingCents: 1000, feeCents: 70, currency: "EUR" };
const ticket = (_id, changes = {}) => ({ _id, transactionId: "pi_group", refunded: false, ...changes });

test("refund access excludes active and committee roles", () => {
  assert.ok(ACCESS_3.includes("regional_board_member"));
  for (const role of ["active_member", "regional_committee_member", "committee_member", "national_committee_member"]) {
    assert.ok(!ACCESS_3.includes(role));
  }
});

test("fee deduction is proportional and can be included", () => {
  assert.deepEqual(calculateGuestRefund(1000, quote, false),
    { amountCents: 1000, feeDeductionCents: 70, refundCents: 930, includeFee: false });
  assert.deepEqual(calculateGuestRefund(400, quote, false),
    { amountCents: 400, feeDeductionCents: 28, refundCents: 372, includeFee: false });
  assert.deepEqual(calculateGuestRefund(400, quote, true),
    { amountCents: 400, feeDeductionCents: 0, refundCents: 400, includeFee: true });
  assert.throws(() => calculateGuestRefund(1001, quote, false), /within the payment balance/);
});

test("preview and submit cover the whole shared purchase once", async () => {
  const event = { region: "eindhoven", guestList: [ticket(firstId), ticket(secondId)] };
  const calls = [];
  const service = createGuestRefundService({
    EventModel: { findById: async () => event }, quote: async () => quote,
    lease: async (_key, work) => work({ assertOwned: async () => {} }),
    refund: async (...args) => { calls.push(args); return { summary: { refunded: 2, failed: 0 },
      results: { success: [{ refundId: "re_1", amountCents: 930 }] } }; },
  });
  const preview = await service.preview(eventId, firstId, "eindhoven");
  assert.equal(preview.affectedTicketCount, 2);
  assert.deepEqual(preview.affectedTicketIds, [firstId, secondId]);
  assert.equal(preview.defaultRefund.refundCents, 930);
  const result = await service.submit(eventId, firstId, "eindhoven",
    { amountCents: 1000, reason: "Requested by attendee", includeFee: false });
  assert.equal(result.refundCents, 930);
  assert.equal(result.affectedTicketCount, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][4].expandGroup, true);
  assert.equal(calls[0][4].amountCents, 930);
  assert.match(calls[0][4].idempotencyKey, /^manual-event-refund:/);
});

test("refund denies a different region, cancellation, free ticket, and already-refunded payment", async () => {
  const event = { region: "eindhoven", guestList: [ticket(firstId), ticket(secondId)] };
  const service = createGuestRefundService({ EventModel: { findById: async () => event }, quote: async () => quote });
  await assert.rejects(service.preview(eventId, firstId, "amsterdam"), /No access/);
  event.cancellationRequestedAt = new Date();
  await assert.rejects(service.preview(eventId, firstId, "eindhoven"), /being cancelled/);
  delete event.cancellationRequestedAt;
  event.guestList[0].transactionId = "-";
  await assert.rejects(service.preview(eventId, firstId, "eindhoven"), /no payment/);
  event.guestList[0].transactionId = "pi_group";
  event.guestList[1].refunded = true;
  await assert.rejects(service.preview(eventId, firstId, "eindhoven"), /already been refunded/);
});

test("Stripe replays an existing operation instead of creating another refund", async () => {
  let created = 0;
  const result = await refundStripePayment("eindhoven", "pi_group", "Requested by attendee", {
    mode: "partial", amountCents: 930, operationId: "manual-test", idempotencyKey: "manual-test",
    dependencies: { stripeClient: {
      refunds: { list: async () => ({ data: [{ id: "re_existing", amount: 930, status: "succeeded",
        metadata: { operation_id: "manual-test" } }] }), create: async () => { created++; } },
      paymentIntents: { retrieve: async () => { throw new Error("Should not load balance for a replay"); } },
    } },
  });
  assert.equal(result.alreadyRefunded, true);
  assert.equal(result.amountCents, 930);
  assert.equal(created, 0);
});

test("Stripe quote reads the original charge, remaining balance, and processing fee", async () => {
  const result = await getStripeRefundQuote("eindhoven", "pi_group", { stripeClient: {
    paymentIntents: { retrieve: async () => ({ latest_charge: { amount: 1000, amount_refunded: 200,
      currency: "eur", balance_transaction: { fee: 70 } } }) },
  } });
  assert.deepEqual(result, { amountCents: 1000, refundedCents: 200, remainingCents: 800,
    feeCents: 70, currency: "EUR" });
});
