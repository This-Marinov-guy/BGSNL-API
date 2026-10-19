import { HOME_URL } from "../../util/config/defines.js";

const objectId = value => /^[a-f\d]{24}$/i.test(String(value || ""));
const qrToken = value => /^[A-Za-z0-9_-]{22}$/.test(String(value || ""));
export const validTicketGuestCode = value => /^\d{1,16}$/.test(String(value ?? ""));
const unavailableStatuses = new Set(["draft", "archived", "canceled", "cancelled"]);

export function isTicketWalletEligible(event, ticket) {
  return !!event && !unavailableStatuses.has(event.status) && validTicketGuestCode(ticket?.code) &&
    qrToken(ticket?.ticketToken) && !ticket?.refunded;
}

// The URL is assembled for delivery only. Its opaque QR token already belongs
// to the issued ticket; no wallet link or issuance record is persisted.
export function ticketWalletUrl(event, ticket) {
  if (!objectId(event?._id || event?.id) || !objectId(ticket?._id || ticket?.id) ||
      !isTicketWalletEligible(event, ticket)) return "";
  const url = new URL("/wallet/ticket", HOME_URL);
  url.searchParams.set("event", String(event._id || event.id));
  url.searchParams.set("ticket", String(ticket._id || ticket.id));
  url.searchParams.set("key", ticket.ticketToken);
  return url.href;
}

export function validTicketWalletIdentity({ eventId, ticketId, token }) {
  return objectId(eventId) && objectId(ticketId) && qrToken(token);
}

export function ticketWalletImageUrl(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
