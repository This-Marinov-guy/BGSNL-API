import { randomBytes } from "node:crypto";
import Event from "../../models/Event.js";

// 128 random bits, 22 base64url characters. Tokens live on the guest-list
// entries they admit (Event.guestList.ticketToken); there is no separate
// collection to keep in step with the event document.
export const mintTicketToken = () => randomBytes(16).toString("base64url");

// The opaque token resolves only inside the authenticated staff endpoint.
// Unfulfilled checkout codes do not match any guest and cannot grant entry.
export const ticketQrLink = (token) => {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(token)) throw new Error("Missing ticket token");
  return `https://bulgariansociety.nl/t/${token}`;
};

// Every ticket gets an identity, including tickets without a printed QR.
// A code may not be reused for a second issued purchase; callers
// generate a fresh server-side code, and a collision fails issuance instead of
// aliasing it.
export async function reserveTicketToken(event, code) {
  const eventId = event?._id ?? event?.id;
  if (!eventId || !/^\d{1,16}$/.test(String(code))) throw new Error("Missing ticket identity");
  const issued = await Event.exists({ _id: eventId,
    guestList: { $elemMatch: { code: Number(code), ticketToken: { $type: "string" } } } });
  if (issued) throw new Error("Ticket identity already issued; please retry");
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = mintTicketToken();
    if (!await Event.exists({ "guestList.ticketToken": token })) return token;
  }
  throw new Error("Unable to reserve unique ticket QR");
}

// Scanned tokens resolve to the purchase that owns them.
export async function resolveTicketToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(token)) return null;
  const event = await Event.findOne({ "guestList.ticketToken": token })
    .select("guestList.code guestList.ticketToken").lean();
  if (!event) return null;
  const guest = event.guestList.find(entry => entry.ticketToken === token);
  return guest ? { eventId: String(event._id), code: guest.code } : null;
}
