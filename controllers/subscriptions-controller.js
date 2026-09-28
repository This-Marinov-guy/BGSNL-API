import HttpError from "../models/Http-error.js";
import { createStripeClient } from "../util/config/stripe.js";
import { membershipPrices, membershipCheckoutRegion, startMembershipChange, startMembershipSignup, createMembershipPortal, previewMembershipChange } from "../services/subscriptions/checkout.js";
import { resolveSubscriptionRegion } from "../services/subscriptions/reconcile.js";
import { FREE_ALUMNI_PLAN } from "../util/subscriptions/policy.js";
import { readBillingDetails } from "../services/subscriptions/billing-details.js";
import { logOperationalError } from "../middleware/axiom-logger.js";

const billingAction = (handler) => async (req, res, next) => {
  try { return await handler(req, res); }
  catch (error) {
    if (error instanceof HttpError) return next(error);
    logOperationalError("service.billing-request", error);
    console.error("Billing request failed", { type: error.type, code: error.code });
    return next(new HttpError("Billing is temporarily unavailable. Please try again shortly or contact support.", 503));
  }
};

export const getMembershipPlans = billingAction(async (req, res) => {
  const region = req.account.subscription?.id ? await resolveSubscriptionRegion(req.account) : membershipCheckoutRegion(req.account);
  const plans = await membershipPrices(createStripeClient(region));
  res.json({ plans: [...plans.map(({ product, ...plan }) => plan), FREE_ALUMNI_PLAN] });
});
export const getBillingDetails = billingAction(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({ billing: await readBillingDetails(req.account) });
});
export const changeMembership = billingAction(async (req, res) => {
  const session = await startMembershipChange(req.account, { priceId: req.body.itemId, returnUrl: req.body.origin_url, memberRegion: req.body.region });
  res.json(session.updated ? { updated: true } : { url: session.url });
});
export const previewMembership = billingAction(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({ quote: await previewMembershipChange(req.account, { priceId: req.body.itemId }) });
});
export const signupMembership = billingAction(async (req, res) => {
  const session = await startMembershipSignup(req.body, req.file);
  res.json({ url: session.url });
});
export const manageMembership = billingAction(async (req, res) => {
  const session = await createMembershipPortal(req.account, { returnUrl: req.body.url, action: req.body.action });
  res.json({ url: session.url });
});
export const cancelMembershipInPortal = billingAction(async (req, res) => {
  const session = await createMembershipPortal(req.account, { action: "cancel" });
  res.json({ url: session.url, message: "Review and confirm the cancellation in the billing portal." });
});
