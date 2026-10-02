import { randomInt } from "node:crypto";
import { isExistingEventTicket } from "../services/tickets/member-ticket-policy.js";
import Event from "../models/Event.js";
import MemberUser from "../models/MemberUser.js";
import HttpError from "../models/Http-error.js";
import { HOME_URL } from "../util/config/defines.js";
import { reconcileAccount } from "../services/subscriptions/reconcile.js";
import { accountEntitlements } from "../util/subscriptions/policy.js";
import { eventPageUrl, eventPurchaseUrl, isCurrentEventMember, isEventOnSale, linkMatchesMember, requiresEventChoices, memberEventPreferencesUrl, verifyMemberEventLink } from "../services/events/member-event-links.js";
import { memberEventPreferences, validateMemberEventChoices } from "../services/events/member-event-preferences.js";
import { stripeCheckoutUrl, freePaymentReturnUrl, createFreePaymentReturn } from "../services/payments/payment-return.js";

export const createMemberEventCheckoutHandler = ({ checkout, EventModel = Event, MemberModel = MemberUser, reconcile = reconcileAccount, verify = verifyMemberEventLink, preferencesUrl = memberEventPreferencesUrl, freeReturn = createFreePaymentReturn, mode = "redirect" } = {}) => async (req, res, next) => {
  res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" });
  // Send no HTML body containing the checkout URL to request/response logging.
  const redirect = (url) => res.status(303).set("Location", url).end();
  try {
    const claims = verify({ token: mode === "redirect" ? req.query.token : req.body?.token });
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
    // Product decision: a verified GET can issue a free ticket in one click.
    // HEAD stays inert, but scanners following GET can also redeem this link.
    const instantFree = mode === "redirect" && req.method === "GET" &&
      (event.isFree || event.isMemberFree) && !event.ticketLink && !requiresEventChoices(event);
    const existingFreeSuccess = async () => {
      const current = await EventModel.findById(claims.eventId);
      if (!current?.guestList?.some(ticket => isExistingEventTicket(ticket, {
        userId: String(member.id || member._id), userIds: member.accountAliases, email: member.email,
      }))) return false;
      const url = freePaymentReturnUrl(await freeReturn({ origin: HOME_URL, region: current.region,
        returnPath: `/${current.region}/event-details/${current._id}`, title: current.title, quantity: 1 }));
      if (!url) throw new HttpError("Could not open your ticket confirmation. Please try again.", 503);
      redirect(url);
      return true;
    };
    if (instantFree && alreadyPurchased && await existingFreeSuccess()) return undefined;
    if (!isEventOnSale(event)) {
      if (mode === "redirect") return redirect(eventPageUrl(event));
      throw new HttpError("Ticket sales for this event are closed.", 409);
    }
    if (event.ticketLink) {
      if (mode === "redirect") return redirect(eventPurchaseUrl(event));
      throw new HttpError("This event now uses external ticketing. Please open its event page.", 409);
    }
    if (mode === "redirect" && requiresEventChoices(event)) return redirect(preferencesUrl(event, member));
    if (mode === "checkout" && req.method !== "POST") throw new HttpError("Please confirm your booking on the ticket page.", 405);
    if (alreadyPurchased && event.isFree) throw new HttpError("You already have a ticket for this event. Find it in your account.", 409);
    const preview = mode !== "redirect" ? memberEventPreferences(event, member, alreadyPurchased) : null;
    if (mode === "preferences") return res.status(200).json(preview);
    if (mode === "checkout" && req.body?.revision !== preview.revision) throw new HttpError("The event options or price have changed. Please reload this page and review them.", 409);
    const choices = mode === "checkout" ? validateMemberEventChoices(event, req.body) : { addOns: "[]" };

    // A scoped email capability is not a login session. It authorizes only this
    // one member/event checkout; all request data comes from verified records.
    const startCheckout = async (guest) => {
      const checkoutRequest = {
        body: { eventId: String(event._id), origin_url: HOME_URL, quantity: 1, code: randomInt(1, 2 ** 48), ...choices, method: guest ? "buy_guest_ticket" : "buy_member_ticket", normalTicket: false },
        user: { userId: String(member.id || member._id) },
        account: member,
        emailTicketCheckout: true,
        emailTicketConfirmed: instantFree || mode === "checkout" && req.method === "POST",
        emailTicketFreeOnly: instantFree,
      };
      const response = {
        status() { return this; },
        async json(result) {
          // A ticket may be fulfilled between the initial check and Checkout.
          // Retry once through the ordinary guest flow at the guest price.
          if (result.alreadyRegistered) {
            if (instantFree) {
              if (await existingFreeSuccess()) return undefined;
              throw new HttpError("Could not confirm your ticket. Please try again.", 409);
            }
            if (mode === "checkout") throw new HttpError("You already have a ticket. Reload this page before booking another one.", 409);
            if (guest) throw new HttpError("Could not prepare guest checkout. Please try again.", 503);
            return startCheckout(true);
          }
          if (instantFree && result.free !== true) throw new HttpError("The ticket options or price changed. Please open the event page.", 409);
          const url = result.free === true && (mode === "checkout" || instantFree)
            ? freePaymentReturnUrl(result.url) : stripeCheckoutUrl(result.url);
          if (!url) throw new HttpError("Could not prepare checkout. Please try again.", 503);
          return mode === "redirect" ? redirect(url) : res.status(200).json({ url, ...(result.free === true ? { free: true } : {}) });
        },
      };
      const checkoutError = async error => {
        if (instantFree && (error?.statusCode || error?.code) === 409 && await existingFreeSuccess()) return undefined;
        return next(error);
      };
      try { return await checkout(checkoutRequest, response, checkoutError); }
      catch (error) { return await checkoutError(error); }
    };
    return await startCheckout(alreadyPurchased);
  } catch (error) { return next(error); }
};
