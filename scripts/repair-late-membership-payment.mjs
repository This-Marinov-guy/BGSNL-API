// Explicit, one-account remediation. Dry run by default. Never collects funds,
// refunds money, alters original invoice amounts, or enables automatic renewal.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Stripe from "stripe";

const idOf = value => typeof value === "string" ? value : value?.id;
export function replacementTerm(account, sub, invoice, charge) {
  const price = sub.items?.data?.[0]?.price;
  const annual = price?.recurring?.interval === "year" && price.recurring.interval_count === 1 ||
    price?.recurring?.interval === "month" && price.recurring.interval_count === 12;
  const start = invoice.status_transitions?.paid_at;
  if (!account.roles?.includes("member") || !["locked", "active", "payment_awaiting"].includes(account.status) ||
      sub.status !== "canceled" || !sub.ended_at || start <= sub.ended_at || !start ||
      idOf(invoice.subscription) !== sub.id || idOf(invoice.customer) !== idOf(sub.customer) ||
      account.subscription?.customerId !== idOf(sub.customer) || invoice.status !== "paid" ||
      invoice.billing_reason !== "subscription_cycle" || invoice.amount_remaining !== 0 ||
      invoice.amount_paid !== price?.unit_amount || invoice.currency !== "eur" || price.currency !== "eur" ||
      !annual || !price.active || sub.items.data.length !== 1 || sub.items.data[0].quantity !== 1 ||
      !charge?.paid || charge.refunded || charge.amount_refunded || charge.disputed ||
      idOf(charge.customer) !== idOf(sub.customer) || idOf(charge.invoice) !== invoice.id ||
      charge.amount !== invoice.amount_paid || charge.currency !== invoice.currency ||
      invoice.pre_payment_credit_notes_amount || invoice.post_payment_credit_notes_amount) {
    throw new Error("This is not a fully paid, unrefunded annual Member renewal received after cancellation; manual review required.");
  }
  const end = new Date(start * 1000);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  if (+end <= Date.now()) throw new Error("The replacement term has already expired.");
  return { start, end: Math.floor(+end / 1000), priceId: price.id, customerId: idOf(sub.customer) };
}

export async function repairLateMembershipPayment({ stripe, collection, account, invoiceId, apply = false }) {
  const source = await stripe.invoices.retrieve(invoiceId, { expand: ["charge"] });
  const old = await stripe.subscriptions.retrieve(idOf(source.subscription));
  const charge = typeof source.charge === "object" ? source.charge : await stripe.charges.retrieve(source.charge);
  const term = replacementTerm(account, old, source, charge);
  const subscriptions = [];
  for await (const sub of stripe.subscriptions.list({ customer: term.customerId, status: "all", limit: 100 })) subscriptions.push(sub);
  const replacements = subscriptions.filter(sub => sub.metadata?.bgsnlReplacementInvoice === source.id);
  if (replacements.length > 1 || subscriptions.some(sub => !["canceled", "incomplete_expired"].includes(sub.status) && !replacements.includes(sub))) {
    throw new Error("Another running subscription exists; do not create or overwrite a membership.");
  }
  let replacement = replacements[0];
  if (![old.id, replacement?.id].includes(account.subscription.id)) throw new Error("Account subscription changed; manual review required.");
  if (source.metadata?.bgsnlLatePaymentReview && !["pending", "replacement_term"].includes(source.metadata.bgsnlLatePaymentReview)) {
    throw new Error("This payment has already been handled another way.");
  }
  if (!apply) return { repairable: true, accountId: account._id, sourceInvoice: source.id, ...term, additionalCharge: 0, automaticRenewal: false };
  const key = `prepaid-replacement:v1:${source.id}`;
  const metadata = { bgsnlReplacementInvoice: source.id, bgsnlPreviousSubscription: old.id,
    bgsnlAccountId: String(account._id), bgsnlPurpose: "late-payment-prepaid-replacement", bgsnlRenewalConsent: "not-granted" };
  if (!replacement) replacement = await stripe.subscriptions.create({
    customer: term.customerId, items: [{ price: term.priceId, quantity: 1 }],
    collection_method: "send_invoice", days_until_due: 30,
    backdate_start_date: term.start, billing_cycle_anchor: term.end, cancel_at: term.end,
    proration_behavior: "none", metadata,
  }, { idempotencyKey: `${key}:subscription` });
  if (replacement.status !== "active" || replacement.cancel_at !== term.end ||
      replacement.current_period_end !== term.end || replacement.collection_method !== "send_invoice" ||
      idOf(replacement.customer) !== term.customerId || idOf(replacement.items?.data?.[0]?.price) !== term.priceId) {
    throw new Error("Replacement no longer matches the approved non-renewing term; manual review required.");
  }
  // No chargeable invoice is generated when backdating with proration=none.
  // Issue a zero-due record linked to the original payment, not a second sale.
  let confirmation;
  for await (const invoice of stripe.invoices.list({ subscription: replacement.id, limit: 100 })) {
    if (invoice.metadata?.bgsnlReplacementInvoice === source.id) {
      if (confirmation) throw new Error("Multiple replacement invoices require review.");
      confirmation = invoice;
    } else if (invoice.amount_due > 0) throw new Error("Unexpected chargeable replacement invoice; manual review required.");
  }
  confirmation ||= await stripe.invoices.create({ customer: term.customerId, subscription: replacement.id,
    collection_method: "send_invoice", days_until_due: 30, auto_advance: false, metadata,
    description: `Replacement membership following payment of invoice ${source.number || source.id}. Already paid; no additional payment or automatic renewal.`,
  }, { idempotencyKey: `${key}:invoice` });
  if (confirmation.status === "draft") {
    const hasLine = confirmation.lines?.data?.some(line => line.metadata?.bgsnlReplacementInvoice === source.id);
    if (!hasLine) await stripe.invoiceItems.create({ customer: term.customerId, invoice: confirmation.id,
      amount: 0, currency: "eur", period: { start: term.start, end: term.end }, metadata,
      description: "Prepaid 12-month replacement membership. No additional payment due.",
    }, { idempotencyKey: `${key}:line` });
    confirmation = await stripe.invoices.retrieve(confirmation.id);
    if (confirmation.amount_due !== 0 || confirmation.total !== 0 || confirmation.starting_balance !== 0) {
      throw new Error("Refusing to finalize an invoice with a balance or charge.");
    }
    confirmation = await stripe.invoices.finalizeInvoice(confirmation.id, { auto_advance: false }, { idempotencyKey: `${key}:finalize` });
  }
  replacement = await stripe.subscriptions.retrieve(replacement.id, { expand: ["latest_invoice"] });
  if (confirmation.status !== "paid" || confirmation.amount_due !== 0 || confirmation.amount_paid !== 0 ||
      idOf(replacement.latest_invoice) !== confirmation.id || replacement.latest_invoice.status !== "paid") {
    throw new Error("The zero-due replacement is not confirmed; account was not changed.");
  }
  // Check for funds in flight or credits before recording the correction.
  const paid = await stripe.invoices.retrieve(source.id, { expand: ["charge"] });
  replacementTerm(account, old, paid, paid.charge);
  const current = await collection.findOne({ _id: account._id });
  if (!current || ![old.id, replacement.id].includes(current.subscription?.id) || current.status !== account.status) {
    throw new Error("Account changed during correction; no account data was overwritten.");
  }
  const now = new Date();
  const result = await collection.updateOne({ _id: account._id, status: current.status,
    "subscription.id": current.subscription.id, "subscription.customerId": term.customerId }, { $set: {
    status: "active", purchaseDate: new Date(replacement.current_period_start * 1000), expireDate: new Date(term.end * 1000),
    "subscription.id": replacement.id, "subscription.priceId": term.priceId, "subscription.stripeRegion": "netherlands",
    "subscription.period": 12, "subscription.status": "active", "subscription.hasBenefits": true, "subscription.lockReason": null,
    "subscription.connected": false, "subscription.cancelAt": new Date(term.end * 1000),
    "subscription.cancelAtPeriodEnd": !!replacement.cancel_at_period_end, "subscription.pendingUpdate": false,
    "subscription.currentPeriodStart": new Date(replacement.current_period_start * 1000), "subscription.currentPeriodEnd": new Date(term.end * 1000),
    "subscription.syncedAt": now, "subscription.lastAttemptAt": now, "subscription.scheduledChange": null,
  }, $unset: { "subscription.failureEpisode": "", "subscription.freeAlumniRequested": "", "subscription.freeAlumniPriceId": "" } });
  if (result.matchedCount !== 1) throw new Error("Account changed during correction; retry safely.");
  await stripe.invoices.update(source.id, { metadata: { bgsnlLatePaymentReview: "replacement_term",
    bgsnlReplacementSubscription: replacement.id, bgsnlReplacementTermStart: String(term.start), bgsnlReplacementTermEnd: String(term.end) } },
  { idempotencyKey: `${key}:resolved` });
  return { changed: true, accountId: account._id, sourceInvoice: source.id, replacementSubscription: replacement.id,
    confirmationInvoice: confirmation.id, termStart: new Date(term.start * 1000), termEnd: new Date(term.end * 1000), additionalCharge: 0, automaticRenewal: false };
}

async function main() {
  const args = process.argv.slice(2), option = name => args.find(arg => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const environment = option("env"), email = option("email"), invoiceId = option("invoice");
  if (!["dev", "prod"].includes(environment) || !email || !/^in_[A-Za-z0-9]+$/.test(invoiceId || "") ||
      args.some(arg => arg !== "--apply" && !/^--(env|email|invoice)=/.test(arg))) {
    throw new Error("Usage: node scripts/repair-late-membership-payment.mjs --env=dev|prod --email=<email> --invoice=<id> [--apply]");
  }
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = dotenv.parse(fs.readFileSync(path.join(directory, `.env.${environment}`)));
  if (!env.STRIPE_NL_SECRET_KEY?.startsWith(environment === "prod" ? "sk_live_" : "sk_test_")) throw new Error("Wrong billing mode.");
  Object.assign(process.env, env);
  const { planForPrice } = await import("../util/subscriptions/policy.js");
  const stripe = new Stripe(env.STRIPE_NL_SECRET_KEY, { apiVersion: "2022-08-01", timeout: 20000, maxNetworkRetries: 1 });
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(`mongodb+srv://${encodeURIComponent(env.DB_USER)}:${encodeURIComponent(env.DB_PASS)}@${env.DB}`,
      { serverSelectionTimeoutMS: 12000, autoCreate: false, autoIndex: false });
    const matches = [];
    for (const name of ["memberUsers", "alumniUsers"]) {
      const collection = mongoose.connection.db.collection(name);
      const account = await collection.findOne({ email: email.toLowerCase(), status: { $nin: ["alumni-migrated", "membership_active", "membership-migrated"] } },
        { projection: { _id: 1, email: 1, status: 1, roles: 1, subscription: 1 } });
      if (account) matches.push({ account, collection });
    }
    if (matches.length !== 1) throw new Error("Expected exactly one current account.");
    const source = await stripe.invoices.retrieve(invoiceId);
    const old = await stripe.subscriptions.retrieve(idOf(source.subscription));
    const plan = planForPrice(idOf(old.items.data[0].price));
    if (plan?.type !== "member" || plan.period !== 12) throw new Error("Expected a recognized annual Member price.");
    console.log(JSON.stringify(await repairLateMembershipPayment({ stripe, ...matches[0], invoiceId, apply: args.includes("--apply") })));
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ message: error.message, code: error.code })); process.exitCode = 1; });
}
