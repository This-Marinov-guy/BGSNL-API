// Replace local QR-only fixtures with the real ticket renderer. No Stripe/email/upload calls.
import mongoose from "mongoose";
import sharp from "sharp";
import { readFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Event from "../models/Event.js";
import TicketQr from "../models/TicketQr.js";
import { renderEventTicket } from "../services/side-services/ticket-generator.js";

const eventId = "6aa7eb0e6c53d4c529cb92eb";
async function main() {
  if (process.env.APP_ENV !== "dev" || process.env.NODE_ENV === "production") throw new Error("Development only");
  mongoose.set("strictQuery", true);
  await mongoose.connect(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`);
  if (mongoose.connection.name !== "test") throw new Error("Refusing non-test database");
  const event = await Event.findById(eventId);
  if (!event?.ticketImg) throw new Error("Event ticket artwork is missing");
  let total = 0;
  for (const suffix of ["", "addons/"]) {
    const directory = fileURLToPath(new URL(`../../BGSNL/public/test-tickets/${eventId}/${suffix}`, import.meta.url));
    const manifest = JSON.parse(await readFile(`${directory}manifest.json`, "utf8"));
    if (manifest.eventId !== eventId || !manifest.testMode) throw new Error("Unexpected fixture manifest");
    for (const purchase of manifest.purchases) {
      if (!/^purchase-\d+\.png$/.test(purchase.imageName)) throw new Error("Invalid fixture filename");
      const qr = await TicketQr.findOne({ eventId, code: String(purchase.code), token: purchase.token });
      const guests = event.guestList.filter(row => String(row.code) === String(purchase.code));
      if (!qr || guests.length !== purchase.quantity || guests.some(row => row.preferences?.fixture !== manifest.batch)) throw new Error("Ticket identity mismatch");
      const expectedLink = `http://localhost:3000/t/${qr.token}`;
      const buffer = await renderEventTicket({
        event: { ...event.toObject(), ticketQR: true },
        checkoutType: "guest", guestName: purchase.name, code: purchase.code,
        quantity: purchase.quantity, qrLink: expectedLink,
      });
      const destination = `${directory}${purchase.imageName}`;
      try { await copyFile(destination, `${destination}.qr-only-backup`, 1); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      await sharp(buffer).png().toFile(destination);
      const metadata = await sharp(destination).metadata();
      if (metadata.width !== 1500 || metadata.height !== 485) throw new Error("Unexpected ticket dimensions");
      total += purchase.quantity;
      console.log(JSON.stringify({ name: purchase.name, quantity: purchase.quantity, width: metadata.width, height: metadata.height }));
    }
  }
  console.log(JSON.stringify({ tickets: total, paymentsChanged: false, emailsSent: false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
