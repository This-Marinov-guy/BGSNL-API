import test from "node:test";
import assert from "node:assert/strict";
import { isTicketWalletEligible, ticketWalletUrl, validTicketGuestCode, validTicketWalletIdentity } from "../services/tickets/wallet-link.js";
import { buildTicketEmailContent } from "../services/events/ticket-email-content.js";

const eventId = "507f1f77bcf86cd799439011", ticketId = "507f1f77bcf86cd799439012";
const token = "aBcDeFgHiJkLmNoPqRsTuv";

test("ticket wallet link requires an issued guest code and QR identity, regardless of printed QR setting", () => {
  const event = { _id: eventId, ticketQR: true };
  const ticket = { _id: ticketId, code: 1792218844, ticketToken: token };
  const url = new URL(ticketWalletUrl(event, ticket));
  assert.equal(url.pathname, "/wallet/ticket");
  assert.deepEqual(Object.fromEntries(url.searchParams), { event: eventId, ticket: ticketId, key: token });
  assert.equal(validTicketWalletIdentity({ eventId, ticketId, token }), true);
  assert.equal(validTicketGuestCode(ticket.code), true);
  assert.equal(isTicketWalletEligible(event, ticket), true);
  assert.equal(ticketWalletUrl({ ...event, ticketQR: false }, ticket), url.href);
  assert.equal(ticketWalletUrl(event, { ...ticket, code: undefined }), "");
  assert.equal(ticketWalletUrl(event, { ...ticket, code: "not-a-code" }), "");
  assert.equal(ticketWalletUrl(event, { ...ticket, refunded: true }), "");
  assert.equal(ticketWalletUrl(event, { ...ticket, ticketToken: "123" }), "");
  assert.equal(ticketWalletUrl({ ...event, status: "canceled" }, ticket), "");
  assert.equal(isTicketWalletEligible({ ...event, status: "draft" }, ticket), false);
});

test("ticket email fits the poster and offers equal-size actions for code-backed tickets", () => {
  const input = { eventName: "Autumn <Social>", eventDate: "17.10 | 19:00", guestName: "Alex",
    ticketUrl: "https://example.test/ticket", poster: "https://example.test/poster.jpg",
    walletUrl: `https://bulgariansociety.nl/wallet/ticket?event=${eventId}&ticket=${ticketId}&key=${token}` };
  const withWallet = buildTicketEmailContent(input);
  assert.match(withWallet.html, /width="32%"[^>]*max-width:160px/);
  assert.match(withWallet.html, /max-width:148px;height:auto;max-height:208px;object-fit:contain/);
  assert.match(withWallet.html, /width:190px;height:60px/);
  assert.match(withWallet.html, /v1792221931\/emails\/add-to-apple-wallet-570x180_tig4rn\.png/);
  assert.match(withWallet.html, /alt="Add to Apple Wallet" width="190" height="60"/);
  assert.match(withWallet.html, /Autumn &lt;Social&gt;/);
  const withoutPrintedQr = buildTicketEmailContent({
    ...input,
    walletUrl: ticketWalletUrl({ _id: eventId, ticketQR: false }, { _id: ticketId, code: 1792218844, ticketToken: token }),
  });
  assert.match(withoutPrintedQr.html, /Add to Apple Wallet/);
  assert.match(withoutPrintedQr.text, /Add to Wallet/);
  const withoutCode = buildTicketEmailContent({
    ...input,
    walletUrl: ticketWalletUrl({ _id: eventId }, { _id: ticketId, ticketToken: token }),
  });
  assert.doesNotMatch(withoutCode.html, /Add to Apple Wallet|<td class="wallet-action-cell"/);
  const withoutTicket = buildTicketEmailContent({ ...input, ticketUrl: "" });
  assert.doesNotMatch(withoutTicket.html, /Add to Apple Wallet|<td class="wallet-action-cell"/);
  assert.doesNotMatch(withoutTicket.text, /Add to Wallet/);
});
