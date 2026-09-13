import { randomInt } from "node:crypto";
import { isExistingEventTicket } from "../services/tickets/member-ticket-policy.js";
import Event from "../models/Event.js";
import User from "../models/User.js";
import HttpError from "../models/Http-error.js";
import { HOME_URL } from "../util/config/defines.js";
import { reconcileAccount } from "../services/subscriptions/reconcile.js";
import { accountEntitlements } from "../util/subscriptions/policy.js";
import { eventPageUrl, eventPurchaseUrl, isCurrentEventMember, isEventOnSale, linkMatchesMember, requiresEventChoices, verifyMemberEventLink } from "../services/events/member-event-links.js";
import { stripeCheckoutUrl } from "../services/payments/payment-return.js";

export const createMemberEventCheckoutHandler = ({ checkout, EventModel = Event, MemberModel = User, reconcile = reconcileAccount, verify = verifyMemberEventLink } = {}) => async (req, res, next) => {
  res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
  // Send no HTML body containing the checkout URL to request/response logging.
  const redirect = (url) => res.status(303).set("Location", url).end();
  try {
    const claims = verify({ token: req.query.token });
    // Mail scanners use HEAD to inspect links. It must not prepare a purchase.
    if (req.method === "HEAD") return res.status(204).end();
    const [event, account] = await Promise.all([EventModel.findById(claims.eventId), MemberModel.findById(claims.memberId)]);
    if (!account || !linkMatchesMember(claims, account)) throw new HttpError("Your membership is no longer available. Please open the event on the website.", 403);
    if (!event) throw new HttpError("This event is no longer available.", 404);
    const alreadyPurchased = (event.guestList || []).some(ticket => isExistingEventTicket(ticket, {
      userId: String(account.id || account._id), userIds: account.accountAliases, email: account.email,
    }));
    if (account.status !== "active") throw new HttpError("Your membership is no longer available. Please open the event on the website.", 403);
    const member = (await reconcile(account))?.user;
    if (!isCurrentEventMember(member) || !accountEntitlements(member).memberDiscount || !linkMatchesMember(claims, member)) throw new HttpError("An active, non-expired membership is required. Please open the event on the website.", 403);
    if (!isEventOnSale(event)) return redirect(eventPageUrl(event));
    if (requiresEventChoices(event) || event.ticketLink) return redirect(eventPurchaseUrl(event));

    // A scoped email capability is not a login session. It authorizes only this
    // one member/event checkout; all request data comes from verified records.
    const startCheckout = async (guest) => {
      const checkoutRequest = {
        body: { eventId: String(event._id), origin_url: HOME_URL, quantity: 1, code: randomInt(1, 2 ** 48), addOns: "[]", method: guest ? "buy_guest_ticket" : "buy_member_ticket", normalTicket: false },
        user: { userId: String(member.id || member._id) },
        account: member,
        emailTicketCheckout: true,
      };
      const response = {
        status() { return this; },
        async json(result) {
          // A ticket may be fulfilled between the initial check and Checkout.
          // Retry once through the ordinary guest flow at the guest price.
          if (result.alreadyRegistered) {
            if (guest) throw new HttpError("Could not prepare guest checkout. Please try again.", 503);
            return startCheckout(true);
          }
          const url = stripeCheckoutUrl(result.url);
          if (!url) throw new HttpError("Could not prepare checkout. Please try again.", 503);
          return redirect(url);
        },
      };
      return await checkout(checkoutRequest, response, next);
    };
    return await startCheckout(alreadyPurchased);
  } catch (error) { return next(error); }
};
