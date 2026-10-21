import HttpError from "../models/Http-error.js";
import { createStripeClient } from "../util/config/stripe.js";
import { membershipPrices, membershipCheckoutRegion, startMembershipChange, startMembershipSignup, createMembershipPortal, previewMembershipChange } from "../services/subscriptions/checkout.js";
import { resolveSubscriptionRegion } from "../services/subscriptions/reconcile.js";
import { FREE_ALUMNI_PLAN } from "../util/subscriptions/policy.js";
import { readBillingDetails } from "../services/subscriptions/billing-details.js";
import { logOperationalError } from "../middleware/axiom-logger.js";
import { redisCache } from "../services/storage/cache.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";

const planCatalogCache = redisCache("membership-plan-catalog:v1", 15 * 60);
const planCatalogVersion = MEMBERSHIP_PLANS.map((plan) => plan.priceId).join(":");

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
  const cacheKey = `${region}:${planCatalogVersion}`;
  let plans = process.env.BGSNL_REDIS_URL ? await planCatalogCache.get(cacheKey) : undefined;
  if (!plans) {
    plans = await membershipPrices(createStripeClient(region));
    if (process.env.BGSNL_REDIS_URL) await planCatalogCache.set(cacheKey, plans);
  }
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
