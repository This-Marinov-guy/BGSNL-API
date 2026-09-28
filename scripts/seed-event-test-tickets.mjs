// Development-only fixtures. Does not import fulfillment, email, or spreadsheet services.
// node --env-file=.env.dev scripts/seed-event-test-tickets.mjs [--apply]
import mongoose from "mongoose";
import Stripe from "stripe";
import QRCode from "qrcode";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Event from "../models/Event.js";

const eventId = "6aa7eb0e6c53d4c529cb92eb";
const withAddOns = process.argv.includes("--addons");
const batch = `mock-tickets-${eventId}${withAddOns ? "-addons" : ""}-v1`;
const purchases = withAddOns ? [
  { name: "Mock Guest with Drink", tier: "guest", quantity: 1, addOnIndex: 0 },
  { name: "Mock Member with Drink 2", tier: "member", quantity: 1, addOnIndex: 1 },
  { name: "Mock Active Member with Drink", tier: "activeMember", quantity: 1, addOnIndex: 0 },
] : [
  { name: "Mock Guest Pair", tier: "guest", quantity: 2 },
  { name: "Mock Guest Trio", tier: "guest", quantity: 3 },
  { name: "Mock Member One", tier: "member", quantity: 1 },
  { name: "Mock Member Two", tier: "member", quantity: 1 },
  { name: "Mock Guest One", tier: "guest", quantity: 1 },
  { name: "Mock Guest Two", tier: "guest", quantity: 1 },
  { name: "Mock Active Member", tier: "activeMember", quantity: 1 },
];
const publicPath = `/test-tickets/${eventId}${withAddOns ? "/addons" : ""}`;
const output = fileURLToPath(new URL(`../../BGSNL/public${publicPath}/`, import.meta.url));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function main() {
  if (process.env.APP_ENV !== "dev" || process.env.NODE_ENV === "production") throw new Error("Development only");
  // Eindhoven uses the Netherlands account in the application's regional mapping.
  const key = process.env.STRIPE_NL_SECRET_KEY;
  if (!key?.startsWith("sk_test_")) throw new Error("A Stripe test key is required");
  mongoose.set("strictQuery", true);
  await mongoose.connect(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`, { serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== "test") throw new Error("Refusing a non-test database");
  const event = await Event.findById(eventId);
  if (!event || event.region !== "eindhoven") throw new Error("Expected development event not found");
  if (withAddOns && (!event.addOns?.isEnabled || purchases.some(p => !event.addOns.items[p.addOnIndex]))) throw new Error("Expected add-ons unavailable");
  const stripe = new Stripe(key, { apiVersion: "2022-08-01", timeout: 20000, maxNetworkRetries: 1 });
  console.log(JSON.stringify({ eventId, title: event.title, database: mongoose.connection.name, purchases: purchases.length, tickets: purchases.reduce((n, p) => n + p.quantity, 0), emails: false }));
  if (!process.argv.includes("--apply")) return;
  await mkdir(output, { recursive: true });
  const results = [];
  for (const [index, purchase] of purchases.entries()) {
    const item = withAddOns ? event.addOns.items[purchase.addOnIndex] : null;
    const addOns = item ? [{ title: item.title, price: Number(item.price) }] : [];
    if (item && (!Number.isFinite(Number(item.price)) || Number(item.price) < 0)) throw new Error("Invalid add-on price");
    const identity = `${batch}-${index + 1}`;
    const code = parseInt(createHash("sha256").update(identity).digest("hex").slice(0, 12), 16);
    const email = `mock-ticket-${index + 1}@example.invalid`;
    const snapshot = await Event.findById(eventId).select("guestList").lean();
    const existing = snapshot.guestList.filter(row => row.code === code);
    if (existing.some(row => row.email !== email) || (existing.length && existing.length !== purchase.quantity)) throw new Error("Fixture identity collision or partial purchase");
    let payment;
    if (existing.length) {
      payment = await stripe.paymentIntents.retrieve(existing[0].transactionId);
    } else {
      const amount = Math.round(Number(event.product[purchase.tier].price) * 100) * purchase.quantity + addOns.reduce((sum, item) => sum + Math.round(item.price * 100), 0);
      if (!Number.isSafeInteger(amount) || amount < 50) throw new Error("Invalid test charge amount");
      payment = await stripe.paymentIntents.create({
        amount, currency: "eur", payment_method: "pm_card_visa", payment_method_types: ["card"], confirm: true,
        description: `${purchase.name} — DEVELOPMENT FIXTURE`,
        // No customer, receipt_email, or fulfillment method: no outgoing email.
        metadata: { fixture: batch, eventId, quantity: String(purchase.quantity), tier: purchase.tier, emails: "disabled", ...(item ? { addOnId: String(item._id), addOnTitle: item.title, addOnAmount: String(item.price) } : {}) },
      }, { idempotencyKey: identity });
    }
    if (payment.livemode || payment.status !== "succeeded" || payment.metadata.fixture !== batch) throw new Error("Test payment not confirmed");
    const issuedEvent = await Event.findOne({ _id: eventId, "guestList.code": code }).select("guestList.code guestList.ticketToken").lean();
    const token = issuedEvent?.guestList.find(row => row.code === code && typeof row.ticketToken === "string")?.ticketToken
      || randomBytes(16).toString("base64url");
    const qrUrl = `http://localhost:3000/t/${token}`;
    const imageName = `purchase-${index + 1}.png`;
    await QRCode.toFile(`${output}${imageName}`, qrUrl, { width: 400, margin: 4, errorCorrectionLevel: "M" });
    if (!existing.length) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const rows = Array.from({ length: purchase.quantity }, () => ({
            code, ticketToken: token, name: purchase.name, email, phone: "+31600000000", type: purchase.tier === "guest" ? "guest" : "member",
            memberPriceApplied: purchase.tier !== "guest", transactionId: payment.id, status: 0, refunded: false,
            preferences: { fixture: batch, pricingTier: purchase.tier },
            addOns,
            ticket: `http://localhost:3000${publicPath}/${imageName}`,
          }));
          const result = await Event.updateOne({ _id: eventId, "guestList.code": { $ne: code } }, { $push: { guestList: { $each: rows } } }, { session, runValidators: true });
          if (result.modifiedCount !== 1) throw new Error("Purchase already exists; rerun to reconcile");
        });
      } finally { await session.endSession(); }
    }
    results.push({ ...purchase, addOns, code, token, qrUrl, imageName, paymentIntent: payment.id, amount: payment.amount / 100 });
    console.log(JSON.stringify({ purchase: index + 1, name: purchase.name, quantity: purchase.quantity, payment: payment.id, status: payment.status }));
  }
  const verified = await Event.findById(eventId).select("guestList").lean();
  const rows = verified.guestList.filter(row => row.preferences?.fixture === batch);
  if (rows.length !== purchases.reduce((sum, p) => sum + p.quantity, 0) || new Set(rows.map(row => row.code)).size !== purchases.length) throw new Error("Fixture count verification failed");
  if (withAddOns && rows.some(row => row.addOns.length !== 1)) throw new Error("Add-on verification failed");
  await writeFile(`${output}manifest.json`, JSON.stringify({ eventId, batch, testMode: true, emails: false, purchases: results }, null, 2));
await writeFile(`${output}index.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Development test tickets</title><style>body{font:16px system-ui;margin:32px;background:#f5f5f2;color:#17231e}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:24px}article{background:white;padding:24px;border-radius:12px}img{width:100%;max-width:300px}a{color:#006455}code{overflow-wrap:anywhere}</style><h1>${escape(event.title)} — test tickets</h1><p>Development only · ${results.length} mock purchases · ${rows.length} tickets · Stripe test charges · No emails. QR links target localhost; use the code or QR upload when scanning from another device.</p><main>${results.map(p => `<article><h2>${escape(p.name)}</h2><p>${escape(p.tier)} · ${p.quantity} ticket(s) · €${p.amount.toFixed(2)}</p><img src="${p.imageName}" alt="QR for ${escape(p.name)}"><p><a href="${p.qrUrl}">Open check-in</a> · <a href="${p.imageName}" download>Download QR</a></p><p>Manual code: <code>${p.token}</code></p></article>`).join("")}</main></html>`);
  console.log(JSON.stringify({ verifiedTickets: rows.length, verifiedPurchases: results.length, preview: `http://localhost:3000${publicPath}/index.html` }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
