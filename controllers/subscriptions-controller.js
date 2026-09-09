import HttpError from "../models/Http-error.js";
import { createStripeClient } from "../util/config/stripe.js";
import { DEFAULT_REGION } from "../util/config/defines.js";
import { membershipPrices, startMembershipChange, startMembershipSignup, createMembershipPortal } from "../services/subscriptions/checkout.js";
import { resolveSubscriptionRegion } from "../services/subscriptions/reconcile.js";
import { FREE_ALUMNI_PLAN } from "../util/subscriptions/policy.js";

const billingAction = (handler) => async (req, res, next) => {
  try { return await handler(req, res); }
  catch (error) {
    if (error instanceof HttpError) return next(error);
    console.error("Billing request failed", { type: error.type, code: error.code });
    return next(new HttpError("Billing is temporarily unavailable. Please try again shortly or contact support.", 503));
  }
};

export const getMembershipPlans = billingAction(async (req, res) => {
  const region = req.account.subscription?.id ? await resolveSubscriptionRegion(req.account) : DEFAULT_REGION;
  const plans = await membershipPrices(createStripeClient(region));
  res.json({ plans: [...plans.map(({ product, ...plan }) => plan), FREE_ALUMNI_PLAN] });
});
export const changeMembership = billingAction(async (req, res) => {
  const session = await startMembershipChange(req.account, { priceId: req.body.itemId, returnUrl: req.body.origin_url });
  res.json({ url: session.url });
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
