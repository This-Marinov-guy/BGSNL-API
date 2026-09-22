import assert from "node:assert/strict";
import test from "node:test";
import { checkoutState, createFreePaymentReturn, createReturnedCheckout, newPaymentToken, paymentOrigin,
  paymentTokenId, preparePaymentReturn, readPaymentReturn, safeReturnPath, stripeCheckoutUrl, stripeDocumentUrl, RETURN_LIFETIME_MS } from "../services/payments/payment-return.js";

const now = Date.UTC(2026, 8, 10);
const token = "a".repeat(64);
const id = paymentTokenId(token);
function harness(overrides = {}) {
  const data = new Map();
  const records = {
    updateOne: async (filter, update) => {
      let doc = data.get(filter._id);
      if (filter.$or && doc?.stripeId && doc.stripeId !== update.$set.stripeId) return { matchedCount: 0 };
      if (!doc && update.$setOnInsert) { doc = structuredClone(update.$setOnInsert); data.set(filter._id, doc); }
      if (!doc) return { matchedCount: 0 };
      Object.assign(doc, structuredClone(update.$set || {}));
      return { matchedCount: 1 };
    },
    findById: (key) => ({ lean: async () => structuredClone(data.get(key) || null) }),
  };
  const session = { id: "cs_verified", status: "complete", payment_status: "paid", amount_total: 1200, currency: "eur", created: now / 1000,
    metadata: { paymentReturnId: id, guestEmail: "private@example.test" },
    payment_intent: { id: "pi_verified", client_secret: "never-expose-intent-secret", status: "succeeded", latest_charge: { id: "ch_verified", receipt_url: "https://pay.stripe.com/receipts/test", amount_refunded: 0 } },
    invoice: null, ...overrides };
  let reads = 0;
  const calls = [];
  const stripe = { checkout: { sessions: {
    retrieve: async (sessionId) => { reads++; assert.equal(sessionId, "cs_verified"); return session; },
    listLineItems: async () => ({ data: [{ description: "Bulgarian Dinner", quantity: 1, amount_total: 1200 }] }),
    create: async (args, options) => { calls.push({ args, options }); return { id: "cs_verified", url: "https://checkout.stripe.com/c/test" }; },
  } } };
  const deps = { records, now, stripeForRegion: (region) => { assert.equal(region, "groningen"); return stripe; } };
  const options = { token, origin: "https://www.bulgariansociety.nl", kind: "ticket", region: "groningen", returnPath: "/groningen/purchase-ticket/event123" };
  const prepare = async () => { const receipt = await preparePaymentReturn(options, deps); await receipt.bind("cs_verified"); return receipt; };
  return { deps, options, prepare, data, session, stripe, calls, readCount: () => reads };
}

test("receipt capabilities are random, hashed, expiring and bound to one Stripe object", async () => {
  assert.match(newPaymentToken(), /^[a-f0-9]{64}$/);
  assert.notEqual(newPaymentToken(), newPaymentToken());
  const h = harness(); const receipt = await h.prepare();
  assert.equal(receipt.id, id);
  assert.equal(receipt.success_url, receipt.cancel_url);
  assert.equal(h.data.get(id).token, undefined);
  assert.equal(h.data.get(id).expiresAt.getTime(), now + RETURN_LIFETIME_MS);
  await assert.rejects(receipt.bind("cs_another"), /binding failed/);
  await receipt.bind("cs_verified");
});

test("legacy donation returns verify the exact intent and expose only a paid receipt", async () => {
  const h = harness();
  const intent = { id: "pi_verified", metadata: { paymentReturnId: id }, amount: 1000, amount_received: 1000,
    currency: "eur", created: now / 1000, status: "succeeded", latest_charge: { id: "ch_donation", receipt_url: "https://pay.stripe.com/receipts/donation" } };
  const receipt = await preparePaymentReturn({ ...h.options, kind: "donation" }, h.deps);
  await receipt.bind(intent.id);
  h.stripe.paymentIntents = { retrieve: async (requested) => { assert.equal(requested, intent.id); return intent; } };
  for (const [status, expected] of [["succeeded", "success"], ["processing", "processing"], ["requires_payment_method", "failed"]]) {
    intent.status = status;
    const result = await readPaymentReturn(token, h.deps);
    assert.equal(result.status, expected); assert.equal(result.invoiceUrl, null);
    assert.equal(result.receiptUrl, expected === "success" ? intent.latest_charge.receipt_url : null);
    assert.equal(result.paymentIntentId, "pi_verified");
    assert.equal(result.transactionId, expected === "success" ? "ch_donation" : null);
  }
  intent.metadata.paymentReturnId = "other";
  await assert.rejects(readPaymentReturn(token, h.deps), (error) => error.statusCode === 404);
});

test("invalid, missing, forged and expired tokens are denied before contacting Stripe", async () => {
  const h = harness(); await h.prepare();
  for (const value of [undefined, null, {}, [], "", "cs_known", "b".repeat(64), `${token}x`]) {
    await assert.rejects(readPaymentReturn(value, h.deps), (error) => error.statusCode === 404);
  }
  h.data.get(id).expiresAt = new Date(now);
  await assert.rejects(readPaymentReturn(token, h.deps), (error) => error.statusCode === 404);
  assert.equal(h.readCount(), 0);
});

test("return preparation is retry-safe and does not extend receipt expiry", async () => {
  const h = harness(); await h.prepare();
  await preparePaymentReturn(h.options, { ...h.deps, now: now + 30000 });
  assert.equal(h.data.get(id).expiresAt.getTime(), now + RETURN_LIFETIME_MS);
});

test("paid details come only from Stripe and omit checkout metadata and customer PII", async () => {
  const h = harness(); await h.prepare();
  const result = await readPaymentReturn(token, h.deps);
  assert.equal(result.status, "success"); assert.equal(result.amount, 1200);
  assert.equal(result.items[0].description, "Bulgarian Dinner");
  assert.equal(result.retryUrl, null); assert.equal(result.invoiceUrl, null);
  assert.equal(result.receiptUrl, "https://pay.stripe.com/receipts/test");
  assert.equal(JSON.stringify(result).includes("private@example.test"), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(result.transactionId, "ch_verified");
  assert.equal(result.paymentIntentId, "pi_verified");
  assert.equal(JSON.stringify(result).includes("never-expose-intent-secret"), false);
});

test("paid signup waits for account readiness without permitting another checkout", async () => {
  const h = harness(); await h.prepare(); h.data.get(id).kind = "subscription";
  h.session.metadata.checkoutKey = "signup:privatehash";
  let ready = false;
  const deps = { ...h.deps, accountReady: async (session, region) => {
    assert.equal(session.id, "cs_verified"); assert.equal(region, "groningen"); return ready;
  } };
  const waiting = await readPaymentReturn(token, deps);
  assert.equal(waiting.status, "success"); assert.equal(waiting.accountReady, false); assert.equal(waiting.isSignup, true);
  assert.equal(waiting.retryUrl, null);
  ready = true;
  for (let i = 0; i < 3; i++) assert.equal((await readPaymentReturn(token, deps)).accountReady, true);
  assert.equal(h.calls.length, 0, "polls never create payments");
  assert.doesNotMatch(JSON.stringify(waiting), /privatehash|private@example/);
  h.session.payment_status = "unpaid"; h.session.payment_intent = null;
  assert.equal((await readPaymentReturn(token, { ...deps, accountReady: () => { throw new Error("must not check unpaid setup"); } })).accountReady, false);
});

test("failed payments expose their intent ID, not a failed charge as a transaction", async () => {
  const h = harness({ status: "open", payment_status: "unpaid", payment_intent: {
    id: "pi_declined", status: "requires_payment_method", last_payment_error: { code: "card_declined" }, latest_charge: "ch_failed",
  } });
  await h.prepare();
  const result = await readPaymentReturn(token, h.deps);
  assert.equal(result.status, "failed");
  assert.equal(result.paymentIntentId, "pi_declined");
  assert.equal(result.transactionId, null);
});

test("subscription results use the initial invoice's payment intent and charge", async () => {
  const h = harness({ payment_intent: null, invoice: { status: "paid", payment_intent: {
    id: "pi_subscription", status: "succeeded", latest_charge: { id: "ch_subscription" },
  } } });
  await h.prepare(); h.data.get(id).kind = "subscription";
  let result = await readPaymentReturn(token, h.deps);
  assert.equal(result.paymentIntentId, "pi_subscription");
  assert.equal(result.transactionId, "ch_subscription");
  h.session.payment_status = "unpaid";
  h.session.invoice.payment_intent.status = "requires_payment_method";
  h.session.invoice.payment_intent.last_payment_error = { code: "card_declined" };
  result = await readPaymentReturn(token, h.deps);
  assert.equal(result.status, "failed");
  assert.equal(result.transactionId, null);
  assert.equal(result.paymentIntentId, "pi_subscription");
});

test("unexpanded Stripe identifiers remain strings and missing intents are not invented", async () => {
  const h = harness({ payment_intent: { id: "pi_verified", latest_charge: "ch_unexpanded" } });
  await h.prepare();
  assert.equal((await readPaymentReturn(token, h.deps)).transactionId, "ch_unexpanded");
  h.session.status = "open"; h.session.payment_status = "unpaid";
  for (const intent of ["pi_unexpanded", null]) {
    h.session.payment_intent = intent;
    const result = await readPaymentReturn(token, h.deps);
    assert.equal(result.transactionId, null);
    assert.equal(result.paymentIntentId, intent);
  }
});

test("an invoice is exposed only when paid and on an approved Stripe host", async () => {
  const h = harness({ invoice: { status: "paid", number: "INV-42", invoice_pdf: "https://pay.stripe.com/invoice/test/pdf" } });
  await h.prepare();
  let result = await readPaymentReturn(token, h.deps);
  assert.equal(result.invoiceUrl, h.session.invoice.invoice_pdf); assert.equal(result.reference, "INV-42");
  h.session.invoice.status = "open";
  assert.equal((await readPaymentReturn(token, h.deps)).invoiceUrl, null);
  h.session.invoice.status = "paid"; h.session.invoice.invoice_pdf = "https://attacker.test/invoice";
  assert.equal((await readPaymentReturn(token, h.deps)).invoiceUrl, null);
});

for (const [session, expected] of [
  [{ status: "complete", payment_status: "paid" }, "success"],
  [{ status: "complete", payment_status: "no_payment_required" }, "success"],
  [{ status: "complete", payment_status: "unpaid" }, "processing"],
  [{ status: "complete", payment_status: "unpaid", payment_intent: { last_payment_error: { code: "declined" } } }, "failed"],
  [{ status: "open", payment_status: "unpaid" }, "cancelled"],
  [{ status: "open", payment_status: "unpaid", payment_intent: { status: "processing" } }, "processing"],
  [{ status: "open", payment_status: "unpaid", payment_intent: { status: "succeeded" } }, "processing"],
  [{ status: "open", payment_status: "unpaid", payment_intent: { status: "requires_payment_method", last_payment_error: {} } }, "failed"],
  [{ status: "expired", payment_status: "unpaid" }, "expired"],
  [{ status: "expired", payment_status: "unpaid", payment_intent: { status: "succeeded" } }, "processing"],
]) test(`Stripe state ${JSON.stringify(session)} maps to ${expected}`, () => assert.equal(checkoutState(session), expected));

test("retry reuses an open checkout but is disabled immediately if payment completes", async () => {
  const h = harness({ status: "open", payment_status: "unpaid", payment_intent: null, url: "https://checkout.stripe.com/c/only-this-session" });
  await h.prepare();
  assert.equal((await readPaymentReturn(token, h.deps)).retryUrl, h.session.url);
  h.session.status = "complete"; h.session.payment_status = "paid";
  assert.equal((await readPaymentReturn(token, h.deps)).retryUrl, null);
  assert.equal(h.calls.length, 0);
});

test("complete but failed, expired and processing sessions do not get a Stripe retry URL", async () => {
  const h = harness({ url: "https://checkout.stripe.com/c/test", payment_status: "unpaid" }); await h.prepare();
  for (const status of ["complete", "expired"]) {
    h.session.status = status;
    assert.equal((await readPaymentReturn(token, h.deps)).retryUrl, null);
  }
});

test("a mismatched Stripe session or metadata is never accepted", async () => {
  const h = harness(); await h.prepare();
  h.session.id = "cs_somebody_else";
  await assert.rejects(readPaymentReturn(token, h.deps), (error) => error.statusCode === 404);
  h.session.id = "cs_verified"; h.session.metadata.paymentReturnId = "another";
  await assert.rejects(readPaymentReturn(token, h.deps), (error) => error.statusCode === 404);
});

test("free confirmation is issued only by the server after fulfilment, without contacting Stripe", async () => {
  const h = harness();
  await preparePaymentReturn({ ...h.options, kind: "free" }, h.deps);
  await assert.rejects(readPaymentReturn(token, h.deps), (error) => error.statusCode === 404);
  const url = await createFreePaymentReturn({ ...h.options, title: "Free dinner", quantity: 2 }, h.deps);
  assert.match(url, /\/payment\/return\?token=/);
  const result = await readPaymentReturn(token, h.deps);
  assert.equal(result.status, "success"); assert.equal(result.amount, 0); assert.equal(result.invoiceUrl, null);
  assert.equal(result.transactionId, null); assert.equal(result.paymentIntentId, null);
  assert.equal(h.readCount(), 0);
});

test("ticket checkout receives protected URLs and binds its exact session; invoice fees remain off", async () => {
  const h = harness();
  await createReturnedCheckout({ stripe: h.stripe, region: "groningen", returnPath: h.options.returnPath,
    checkoutData: { success_url: h.options.origin, line_items: [{ price: "price_db", quantity: 1 }], metadata: { paymentReturnId: "forged" } } }, h.deps);
  const { args, options } = h.calls[0];
  assert.match(args.success_url, /^https:\/\/www.bulgariansociety.nl\/payment\/return\?token=[a-f0-9]{64}$/);
  assert.equal(args.success_url, args.cancel_url); assert.notEqual(args.metadata.paymentReturnId, "forged");
  assert.equal(args.invoice_creation, undefined); assert.ok(options.idempotencyKey);
  assert.equal(h.data.get(args.metadata.paymentReturnId).stripeId, "cs_verified");
});

test("redirect and document hosts reject open redirects, credentials and lookalike domains", () => {
  for (const value of ["https://evil.test", "https://www.bulgariansociety.nl.evil.test", "javascript:alert(1)", "https://user@www.bulgariansociety.nl"]) assert.throws(() => paymentOrigin(value));
  for (const value of ["//evil.test", "/\\evil", "https://evil.test", "/%2f%2fevil"]) assert.throws(() => safeReturnPath(value));
  for (const value of ["http://checkout.stripe.com/c", "https://checkout.stripe.com.evil.test/c", "https://user@checkout.stripe.com/c"]) assert.equal(stripeCheckoutUrl(value), null);
  for (const value of ["https://evil.test/pdf", "http://pay.stripe.com/pdf", "https://user@pay.stripe.com/pdf"]) assert.equal(stripeDocumentUrl(value), null);
});
