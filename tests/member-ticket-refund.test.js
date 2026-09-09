import test from "node:test";
import assert from "node:assert/strict";
import { refundDuplicateMemberTicket } from "../services/tickets/member-ticket-refund.js";

test("a duplicate paid member ticket is refunded idempotently", async () => {
  const calls = [];
  const refunded = await refundDuplicateMemberTicket(
    {
      transactionId: "pi_duplicate",
      eventId: "event",
      userId: "account",
      region: "groningen",
    },
    {
      stripeFactory: (region) => ({
        refunds: {
          create: async (...args) => calls.push({ region, args }),
        },
      }),
    }
  );

  assert.equal(refunded, true);
  assert.deepEqual(calls, [{
    region: "groningen",
    args: [
      { payment_intent: "pi_duplicate", reason: "duplicate" },
      { idempotencyKey: "duplicate-member-ticket:event:account:pi_duplicate" },
    ],
  }]);
});

test("free duplicate tickets never call Stripe", async () => {
  const refunded = await refundDuplicateMemberTicket(
    {
      transactionId: "free_123",
      eventId: "event",
      userId: "account",
      region: "groningen",
    },
    { stripeFactory: () => { throw new Error("Stripe must not be called"); } }
  );

  assert.equal(refunded, false);
});
