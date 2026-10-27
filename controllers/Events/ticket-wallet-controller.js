import HttpError from "../../models/Http-error.js";
import { isTrustedServerRequest } from "../../middleware/firewall.js";
import { ticketQrLink } from "../../services/tickets/qr-link.js";
import { isTicketWalletEligible, ticketWalletImageUrl, validTicketWalletIdentity } from "../../services/tickets/wallet-link.js";
import { eventModelForId, publicEventRegion } from "../../services/events/managed-event-store.js";

export async function ticketWalletDetails(req, res, next) {
  if (!isTrustedServerRequest(req)) return next(new HttpError("Ticket unavailable", 404));
  const { eventId, ticketId, token } = req.body || {};
  if (!validTicketWalletIdentity({ eventId, ticketId, token })) return next(new HttpError("Ticket unavailable", 404));
  try {
    const EventModel = await eventModelForId(eventId);
    const event = await EventModel.findOne({ _id: eventId,
      guestList: { $elemMatch: { _id: ticketId, ticketToken: token, refunded: { $ne: true } } } })
      .select("title date correctedDate location region poster status guestList._id guestList.ticketToken guestList.name guestList.code guestList.ticket guestList.refunded").lean();
    const ticket = event?.guestList?.find(row => String(row._id) === ticketId && row.ticketToken === token && !row.refunded);
    if (!isTicketWalletEligible(event, ticket)) {
      return next(new HttpError("Ticket unavailable", 404));
    }
    res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" });
    return res.json({ event: { id: String(event._id), title: event.title, date: event.correctedDate || event.date,
      location: event.location || "", region: publicEventRegion(event.region || ""), poster: event.poster || "" },
    ticket: { id: String(ticket._id), name: ticket.name, barcode: ticketQrLink(token),
      image: ticketWalletImageUrl(ticket.ticket),
      quantity: event.guestList.filter(row => row.ticketToken === token && !row.refunded).length } });
  } catch { return next(new HttpError("Ticket details are temporarily unavailable", 503)); }
}
