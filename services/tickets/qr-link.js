import TicketQr from "../../models/TicketQr.js";

// The opaque token resolves only inside the authenticated staff endpoint.
// Unfulfilled checkout codes do not match any guest and cannot grant entry.
export async function ticketQrLink(eventId, code) {
  if (!eventId || !/^\d{1,16}$/.test(String(code))) throw new Error("Missing ticket identity");
  const identity = { eventId, code: String(code) };
  let record = await TicketQr.findOne(identity);
  // A code may not be reused for a second issued purchase. Callers generate a
  // fresh server-side code; a collision fails issuance instead of aliasing it.
  if (record) throw new Error("Ticket identity already issued; please retry");
  if (!record) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { record = await TicketQr.create(identity); break; }
      catch (error) {
        if (error.code !== 11000) throw error;
        record = await TicketQr.findOne(identity);
        if (record) throw new Error("Ticket identity already issued; please retry");
      }
    }
  }
  if (!record) throw new Error("Unable to reserve unique ticket QR");
  return `https://bulgariansociety.nl/t/${record.token}`;
}
