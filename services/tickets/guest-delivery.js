import Event from "../../models/Event.js";
import HttpError from "../../models/Http-error.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { sendTicketEmailNow } from "../background-services/email-transporter.js";
import { sendEmail } from "../background-services/email-provider.js";
import { NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME } from "../../util/config/defines.js";
import { ticketWalletUrl } from "./wallet-link.js";

const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
const validTicketUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
};
const stripeId = value => typeof value === "string" ? value : value?.id;
const escapeHtml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const validStripeReceiptUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "pay.stripe.com" &&
      url.pathname.startsWith("/receipts/") && !url.username && !url.password;
  } catch { return false; }
};

const sendReceiptLinkEmail = ({ email, receiptUrl, eventName }) => {
  const safeTitle = String(eventName || "your event").replace(/[\r\n]+/g, " ").trim();
  return sendEmail({ from: { email: NO_REPLY_EMAIL, name: NO_REPLY_EMAIL_NAME }, to: [{ email }],
    subject: "Your payment receipt",
    text: `Your receipt for ${safeTitle}\n\nView your Stripe receipt: ${receiptUrl}`,
    html: `<p>Your receipt for ${escapeHtml(safeTitle)} is ready.</p><p><a href="${escapeHtml(receiptUrl)}">View your Stripe receipt</a></p>` });
};

export const createGuestDeliveryService = ({ EventModel = Event, stripeForRegion = createStripeClient,
  deliverTicket = sendTicketEmailNow, deliverReceiptLink = sendReceiptLinkEmail } = {}) => {
  const loadGuest = async (eventId, guestId, region) => {
    const event = await EventModel.findById(eventId).select("region status title date poster guestList cancellationRequestedAt");
    if (!event) throw new HttpError("Event not found", 404);
    if (event.region !== region) throw new HttpError("No access to this event guest list", 403);
    const guest = event.guestList.id(guestId);
    if (!guest) throw new HttpError("Guest not found", 404);
    if (guest.refunded) throw new HttpError("This ticket has been refunded", 422);
    if (!validEmail(guest.email)) throw new HttpError("This guest needs a valid email address", 422);
    return { event, guest, email: guest.email.trim().toLowerCase() };
  };

  const sendTicket = async (eventId, guestId, region) => {
    const { event, guest, email } = await loadGuest(eventId, guestId, region);
    if (event.cancellationRequestedAt || ["canceled", "cancelled", "archived", "draft"].includes(event.status)) {
      throw new HttpError("Tickets cannot be sent for this event", 422);
    }
    if (!validTicketUrl(guest.ticket)) throw new HttpError("This guest has no ticket image to send", 422);
    const samePurchase = event.guestList.filter(entry => !entry.refunded &&
      guest.code != null && guest.ticketToken &&
      String(entry.email).trim().toLowerCase() === email &&
      String(entry.code || "") === String(guest.code || "") &&
      String(entry.ticketToken || "") === String(guest.ticketToken || "") &&
      String(entry.transactionId || "") === String(guest.transactionId || "") &&
      entry.ticket === guest.ticket);
    const tickets = samePurchase.length ? samePurchase.map(entry => entry.ticket) : [guest.ticket];
    await deliverTicket({ type: ["guest", "free guest"].includes(guest.type) ? "guest" : "member",
      receiver: email, eventName: event.title, eventDate: event.date, guestName: guest.name,
      tickets, poster: event.poster, guestDetails: { region: event.region, phone: guest.phone },
      walletUrl: ticketWalletUrl(event, guest) });
    return { email, ticketCount: tickets.length };
  };

  const sendReceipt = async (eventId, guestId, region) => {
    const { event, guest, email } = await loadGuest(eventId, guestId, region);
    let paymentIntentId = String(guest.transactionId || "");
    if (!/^(pi|cs)_/.test(paymentIntentId)) throw new HttpError("This ticket has no Stripe payment receipt", 422);
    const stripe = stripeForRegion(region);
    if (paymentIntentId.startsWith("cs_")) {
      const session = await stripe.checkout.sessions.retrieve(paymentIntentId);
      if (session.metadata?.eventId && session.metadata.eventId !== String(eventId)) {
        throw new HttpError("This payment belongs to another event", 409);
      }
      paymentIntentId = stripeId(session.payment_intent);
      if (!paymentIntentId?.startsWith("pi_")) throw new HttpError("This ticket has no completed Stripe payment", 422);
    }
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
    if (intent.metadata?.eventId && intent.metadata.eventId !== String(eventId)) {
      throw new HttpError("This payment belongs to another event", 409);
    }
    if (intent.status !== "succeeded") throw new HttpError("This payment has not completed", 422);
    const charge = typeof intent.latest_charge === "string"
      ? await stripe.charges.retrieve(intent.latest_charge) : intent.latest_charge;
    if (!charge?.id || charge.payment_intent && stripeId(charge.payment_intent) !== intent.id ||
        !charge.paid || charge.refunded || charge.amount_refunded >= charge.amount) {
      throw new HttpError("This payment has no active Stripe receipt", 422);
    }
    if (String(charge.receipt_email || "").trim().toLowerCase() === email) {
      if (!validStripeReceiptUrl(charge.receipt_url)) throw new HttpError("This payment has no Stripe receipt link to send", 422);
      await deliverReceiptLink({ email, receiptUrl: charge.receipt_url, eventName: event.title });
      return { email, method: "receipt-link" };
    }
    await stripe.charges.update(charge.id, { receipt_email: email });
    return { email, method: "stripe-email" };
  };

  return { sendTicket, sendReceipt };
};

export const guestDelivery = createGuestDeliveryService();
