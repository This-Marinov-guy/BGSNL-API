import { createHash, randomBytes } from "node:crypto";
import PaymentReturn from "../../models/PaymentReturn.js";
import HttpError from "../../models/Http-error.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { membershipAccountReady } from "./account-readiness.js";

export const RETURN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const newPaymentToken = () => randomBytes(32).toString("hex");
export const paymentTokenId = (token) => createHash("sha256").update(token).digest("hex");
const invalidReturn = () => new HttpError("This payment link is invalid or has expired.", 404);
const stripeObjectId = (value) => typeof value === "string" ? value : value?.id || null;
const paymentIdentifiers = (intent, status) => ({
  transactionId: status === "success" ? stripeObjectId(intent?.latest_charge) : null,
  paymentIntentId: stripeObjectId(intent),
});

export function paymentOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError("Invalid payment return URL", 422); }
  const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || (!local && !["https://bulgariansociety.nl", "https://www.bulgariansociety.nl"].includes(url.origin))) {
    throw new HttpError("Invalid payment return URL", 422);
  }
  return url.origin;
}

export function safeReturnPath(path) {
  // Only destinations constructed by our checkout handlers, never client URLs.
  if (typeof path !== "string" || !/^\/(?!\/)[a-zA-Z0-9/_?=#.-]*$/.test(path)) throw new HttpError("Invalid checkout destination", 422);
  return path;
}

export async function preparePaymentReturn({ token = newPaymentToken(), origin, kind, region, returnPath, title, quantity }, { records = PaymentReturn, now = Date.now() } = {}) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw invalidReturn();
  const id = paymentTokenId(token);
  const data = { _id: id, origin: paymentOrigin(origin), kind, region, returnPath: safeReturnPath(returnPath), title, quantity,
    expiresAt: new Date(now + RETURN_LIFETIME_MS) };
  await records.updateOne({ _id: id }, { $setOnInsert: data }, { upsert: true });
  const url = `${data.origin}/payment/return?token=${token}`;
  return {
    id, token, url,
    // The outcome comes from Stripe, never from the URL the customer chose.
    success_url: url, cancel_url: url,
    async bind(stripeId) {
      const result = await records.updateOne({ _id: id, $or: [{ stripeId: { $exists: false } }, { stripeId }] }, { $set: { stripeId } });
      if (result.matchedCount !== 1) throw new Error("Payment return binding failed");
    },
  };
}

export async function createReturnedCheckout({ stripe, checkoutData, region, returnPath }, dependencies) {
  const receipt = await preparePaymentReturn({ origin: checkoutData.success_url, kind: "ticket", region, returnPath }, dependencies);
  const session = await stripe.checkout.sessions.create({ ...checkoutData, success_url: receipt.success_url, cancel_url: receipt.cancel_url,
    metadata: { ...checkoutData.metadata, paymentReturnId: receipt.id } }, { idempotencyKey: `payment-return:${receipt.id}` });
  await receipt.bind(session.id);
  return session;
}

export async function createFreePaymentReturn(options, dependencies = {}) {
  const receipt = await preparePaymentReturn({ ...options, kind: "free" }, dependencies);
  const records = dependencies.records || PaymentReturn;
  await records.updateOne({ _id: receipt.id }, { $set: { confirmedAt: new Date(dependencies.now ?? Date.now()) } });
  return receipt.url;
}

export function freePaymentReturnUrl(value) {
  try {
    const url = new URL(value);
    paymentOrigin(url.href);
    if (url.pathname !== "/payment/return" || url.hash ||
        [...url.searchParams.keys()].length !== 1 || !/^[a-f0-9]{64}$/.test(url.searchParams.get("token") || "")) return null;
    return url.href;
  } catch { return null; }
}

export function checkoutState(session) {
  if (session.status === "complete" && ["paid", "no_payment_required"].includes(session.payment_status)) return "success";
  const intent = session.payment_intent;
  if (intent?.status === "processing" || intent?.status === "succeeded" || intent?.status === "requires_capture") return "processing";
  if (session.status === "expired") return "expired";
  if (session.status === "complete") return intent?.last_payment_error ? "failed" : "processing";
  if (session.status === "open") return intent?.last_payment_error ? "failed" : "cancelled";
  throw new HttpError("Payment status is temporarily unavailable.", 503);
}

export function stripeDocumentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      ["pay.stripe.com", "invoice.stripe.com", "invoice.stripecdn.com", "files.stripe.com", "dashboard.stripe.com"].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

export function stripeCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// This is a read-only projection. Visiting a result page never fulfils an order,
// grants benefits, creates an invoice or creates another payment.
export async function readPaymentReturn(token, { records = PaymentReturn, stripeForRegion = createStripeClient, accountReady = membershipAccountReady, now = Date.now() } = {}) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw invalidReturn();
  const record = await records.findById(paymentTokenId(token)).lean();
  if (!record || new Date(record.expiresAt).getTime() <= now) throw invalidReturn();
  const base = { checkout: record._id.slice(0, 24), kind: record.kind, returnPath: record.returnPath,
    reference: record._id.slice(-12).toUpperCase(), expiresAt: new Date(record.expiresAt).toISOString() };
  if (record.kind === "free") {
    if (!record.confirmedAt) throw invalidReturn();
    return { ...base, status: "success", amount: 0, currency: "eur", date: new Date(record.confirmedAt).toISOString(),
      items: [{ description: record.title || "Event ticket", quantity: record.quantity || 1, amount: 0 }],
      transactionId: null, paymentIntentId: null,
      invoiceUrl: null, receiptUrl: null, retryUrl: null };
  }
  if (!record.stripeId) throw new HttpError("Your checkout is still being prepared. Please try again shortly.", 503);
  const stripe = stripeForRegion(record.region);
  if (record.kind === "donation") {
    const intent = await stripe.paymentIntents.retrieve(record.stripeId, { expand: ["latest_charge"] });
    if (intent.id !== record.stripeId || intent.metadata?.paymentReturnId !== record._id) throw invalidReturn();
    const status = intent.status === "succeeded" ? "success" : ["processing", "requires_capture"].includes(intent.status) ? "processing" : "failed";
    return { ...base, ...paymentIdentifiers(intent, status), status, amount: intent.amount_received || intent.amount, currency: intent.currency,
      date: new Date(intent.created * 1000).toISOString(), items: [{ description: "Donation to Bulgarian Society Netherlands", quantity: 1, amount: intent.amount }],
      invoiceUrl: null, receiptUrl: status === "success" ? stripeDocumentUrl(intent.latest_charge?.receipt_url) : null,
      retryUrl: null };
  }
  const session = await stripe.checkout.sessions.retrieve(record.stripeId, { expand: ["invoice.payment_intent.latest_charge", "payment_intent.latest_charge"] });
  if (session.id !== record.stripeId || session.metadata?.paymentReturnId !== record._id) throw invalidReturn();
  // Subscription Checkout stores its payment intent on the invoice (Stripe API 2022-08-01).
  const intent = session.payment_intent || session.invoice?.payment_intent;
  const status = checkoutState({ ...session, payment_intent: intent });
  const setup = record.kind === "subscription" ? {
    accountReady: status === "success" && await accountReady(session, record.region),
    isSignup: typeof session.metadata?.checkoutKey === "string" && session.metadata.checkoutKey.startsWith("signup:"),
  } : {};
  const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const invoice = session.invoice;
  const charge = intent?.latest_charge;
  return { ...base, ...setup, ...paymentIdentifiers(intent, status), status, amount: session.amount_total, currency: session.currency,
    date: new Date((charge?.created || session.created) * 1000).toISOString(),
    reference: invoice?.number || base.reference,
    items: lines.data.map((item) => ({ description: item.description || "Purchase", quantity: item.quantity, amount: item.amount_total })),
    invoiceUrl: status === "success" && invoice?.status === "paid" ? stripeDocumentUrl(invoice.invoice_pdf) : null,
    receiptUrl: status === "success" ? stripeDocumentUrl(charge?.receipt_url) : null,
    refunded: charge?.amount_refunded || 0,
    // Resume only this same, still-open session. Complete/processing checkouts
    // can never be restarted by changing a query parameter or replaying retry.
    retryUrl: ["failed", "cancelled"].includes(status) && session.status === "open" ? stripeCheckoutUrl(session.url) : null,
  };
}
