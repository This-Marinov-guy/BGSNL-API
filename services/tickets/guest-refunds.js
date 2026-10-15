import { createHash } from "node:crypto";
import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { getStripeRefundQuote } from "../side-services/stripe.js";
import { refundEventTickets } from "../main-services/event-action-service.js";
import { withBillingLease } from "../subscriptions/lease.js";

const paymentId = ticket => ticket?.transactionId && ticket.transactionId !== "-" ? ticket.transactionId : null;

export function calculateGuestRefund(amountCents, quote, includeFee) {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > quote.remainingCents) {
    throw new HttpError("Choose an amount within the payment balance", 422);
  }
  const feeDeductionCents = includeFee ? 0 : Math.round(quote.feeCents * amountCents / quote.amountCents);
  const refundCents = amountCents - feeDeductionCents;
  if (refundCents <= 0) throw new HttpError("The amount must be greater than the Stripe fee", 422);
  return { amountCents, feeDeductionCents, refundCents, includeFee };
}

export function createGuestRefundService({ EventModel = Event, quote = getStripeRefundQuote,
  refund = refundEventTickets, lease = withBillingLease } = {}) {
  const load = async (eventId, guestId, region) => {
    const event = await EventModel.findById(eventId);
    if (!event) throw new HttpError("Event not found", 404);
    if (event.region !== region) throw new HttpError("No access for this region", 403);
    if (event.cancellationRequestedAt) throw new HttpError("This event is being cancelled. Its refunds are handled automatically.", 409);
    const selected = event.guestList.find(ticket => String(ticket._id) === String(guestId));
    if (!selected) throw new HttpError("Ticket not found", 404);
    const transactionId = paymentId(selected);
    if (!transactionId) throw new HttpError("This ticket has no payment to refund", 409);
    const tickets = event.guestList.filter(ticket => paymentId(ticket) === transactionId);
    if (tickets.some(ticket => ticket.refunded)) throw new HttpError("This payment has already been refunded", 409);
    return { event, transactionId, tickets };
  };

  const preview = async (eventId, guestId, region) => {
    const { transactionId, tickets } = await load(eventId, guestId, region);
    const stripe = await quote(region, transactionId);
    if (stripe.remainingCents <= 0) throw new HttpError("This payment has already been refunded", 409);
    return { ...stripe, affectedTicketIds: tickets.map(ticket => String(ticket._id)),
      affectedTicketCount: tickets.length,
      defaultRefund: calculateGuestRefund(stripe.remainingCents, stripe, false) };
  };

  const submit = async (eventId, guestId, region, { amountCents, reason, includeFee }) =>
    lease(`event-refund:${eventId}`, async ({ assertOwned }) => {
      const { transactionId, tickets } = await load(eventId, guestId, region);
      const stripe = await quote(region, transactionId);
      if (!Number.isInteger(amountCents) || amountCents > stripe.amountCents) {
        throw new HttpError("Choose an amount within the original payment", 422);
      }
      // A prior Stripe refund may have succeeded while the event save failed.
      // Let the stable operation ID recover that result before rejecting the
      // now-smaller balance; Stripe itself rejects a new over-balance refund.
      const calculation = calculateGuestRefund(amountCents,
        { ...stripe, remainingCents: Math.max(stripe.remainingCents, amountCents) }, includeFee);
      const operationId = createHash("sha256").update(`manual-event-refund:${eventId}:${transactionId}`).digest("hex");
      await assertOwned();
      const result = await refund(eventId, reason, region, [String(guestId)], {
        mode: "partial", amountCents: calculation.refundCents, expandGroup: true,
        operationId, idempotencyKey: `manual-event-refund:${eventId}:${transactionId}`,
      });
      if (result.summary.refunded !== tickets.length) {
        throw new HttpError("The refund could not be completed. Check the payment before trying again.", 502);
      }
      return { ...calculation, refundCents: result.results.success[0]?.amountCents ?? calculation.refundCents,
        affectedTicketIds: tickets.map(ticket => String(ticket._id)),
        affectedTicketCount: tickets.length, refundId: result.results.success[0]?.refundId,
        profileCleanupPending: result.summary.failed > 0 };
    });
  return { preview, submit };
}

export const guestRefunds = createGuestRefundService();
