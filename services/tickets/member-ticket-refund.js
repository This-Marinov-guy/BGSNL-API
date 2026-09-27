import { createStripeClient } from "../../util/config/stripe.js";

export const refundDuplicateMemberTicket = async (
  { transactionId, eventId, userId, region },
  { stripeFactory = createStripeClient } = {}
) => {
  if (!transactionId || String(transactionId).startsWith("free_")) return false;

  const stripeClient = stripeFactory(region);
  await stripeClient.refunds.create(
    { payment_intent: transactionId, reason: "duplicate" },
    { idempotencyKey: `duplicate-member-ticket:${eventId}:${userId}:${transactionId}` }
  );

  return true;
};
