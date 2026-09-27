import { createHash, randomUUID } from "node:crypto";
import { hashPassword, registrationPasswordHash } from "../authentication/passwords.js";
import BillingRecord from "../../models/BillingRecord.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import HttpError from "../../models/Http-error.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { DEFAULT_REGION, USER_URL } from "../../util/config/defines.js";
import { chooseRandomAvatar, decryptData } from "../../util/functions/helpers.js";
import { findUserByEmail, normalizeEmail } from "../main-services/user-service.js";
import { MEMBERSHIP_PLANS, FREE_ALUMNI_PLAN, planForPrice, planChangeChargesImmediately, stripeId, ENDED_SUBSCRIPTION_STATUSES, accountEntitlements, accountType } from "../../util/subscriptions/policy.js";
import { createSubscriptionAccount, persistSubscriptionAccount } from "./accounts.js";
import { resolveCheckoutAccount } from "./checkout-account.js";
import { withBillingLease } from "./lease.js";
import { canonicalStripeRegion, reconcileAccount, reconcileSubscription, readStripeSubscription } from "./reconcile.js";
import { alumniWelcomeEmail, welcomeEmail } from "../background-services/email-transporter.js";
import { newPaymentToken, preparePaymentReturn } from "../payments/payment-return.js";
import { hasMemberConnectAllocation } from "./connected.js";
import { memberRevenueMetadata } from "./stripe-revenue-state.js";
import { memberRevenueAllocation } from "../../util/config/member-revenue.js";
import { registerMemberRevenueSubscription } from "./revenue-sharing.js";
import { changePlanAtRenewal } from "./change-plan.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function billingReturnUrl(value) {
  let url;
  try { url = new URL(value || USER_URL); } catch { throw new HttpError("Invalid return URL", 422); }
  const production = ["https://bulgariansociety.nl", "https://www.bulgariansociety.nl"];
  const local = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
  if (url.username || url.password || (!production.includes(url.origin) && !local)) throw new HttpError("Invalid return URL", 422);
  return `${url.origin}/user#settings`;
}

async function membershipPrice(stripe, plan) {
  const price = await stripe.prices.retrieve(plan.priceId);
  if (!price.active || !price.recurring || price.currency !== "eur") throw new Error("Membership price is unavailable");
  const months = price.recurring.interval === "year" ? price.recurring.interval_count * 12
    : price.recurring.interval === "month" ? price.recurring.interval_count : null;
  if (months !== plan.period || price.unit_amount == null) throw new Error("Membership price has an unexpected billing period or amount");
  return { ...plan, amount: price.unit_amount, currency: price.currency,
    interval: price.recurring.interval, intervalCount: price.recurring.interval_count,
    product: stripeId(price.product) };
}

export async function membershipPrices(stripe) {
  return Promise.all(MEMBERSHIP_PLANS.map(plan => membershipPrice(stripe, plan)));
}

// Customer IDs belong to a Stripe account. Restarts stay with the verified
// existing customer/account; genuinely new memberships use central billing.
export function membershipCheckoutRegion(user, verifiedRegion) {
  const region = user?.subscription?.customerId ? verifiedRegion || user.subscription.stripeRegion || DEFAULT_REGION : DEFAULT_REGION;
  return region === DEFAULT_REGION ? DEFAULT_REGION : canonicalStripeRegion(region);
}

export async function portalConfiguration(stripe, region, locked, { switching = false, withLease = withBillingLease } = {}) {
  // Dedicated configurations, never modify the existing regional/legacy portals.
  // Version the key so no Payments session reuses a v1 plan-switching portal.
  const allowSwitch = switching && !locked;
  const key = `portal-config:v2:${region}:${locked ? "recovery" : allowSwitch ? `switch-confirm:${hash(MEMBERSHIP_PLANS.map((p) => p.priceId).join(","))}` : "payments"}`;
  const verify = configuration => {
    const update = configuration.features?.subscription_update;
    if (!configuration.active || update?.enabled !== allowSwitch ||
        (allowSwitch && (update.proration_behavior !== "always_invoice" || update.schedule_at_period_end?.conditions?.length || update.trial_update_behavior === "continue_trial"))) {
      throw new HttpError("Billing configuration is unavailable. Please contact support.", 503);
    }
    return configuration.id;
  };
  return withLease(key, async ({ record }) => {
    if (record.data?.configurationId) return verify(await stripe.billingPortal.configurations.retrieve(record.data.configurationId));
    for await (const configuration of stripe.billingPortal.configurations.list({ limit: 100 })) {
      if (configuration.active && configuration.metadata?.bgsnlConfigurationKey === key) return verify(configuration);
    }
    const products = new Map();
    if (allowSwitch) for (const plan of await membershipPrices(stripe)) {
      products.set(plan.product, [...(products.get(plan.product) || []), plan.priceId]);
    }
    const configuration = await stripe.billingPortal.configurations.create({
      metadata: { bgsnlConfigurationKey: key },
      business_profile: { headline: "Manage your BGSNL subscription" },
      default_return_url: `${USER_URL}#settings`,
      features: {
        payment_method_update: { enabled: true }, invoice_history: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["address", "name"] },
        subscription_cancel: { enabled: true, mode: locked ? "immediately" : "at_period_end", proration_behavior: "none" },
        subscription_update: !allowSwitch ? { enabled: false } : {
          enabled: true, default_allowed_updates: ["price"], proration_behavior: "always_invoice",
          products: [...products].map(([product, prices]) => ({ product, prices })),
        },
      },
    }, { idempotencyKey: key });

    return configuration.id;
  });
}

export async function createMembershipPortal(user, { returnUrl, priceId, action, freeAlumni = false, dependencies = {} } = {}) {
  const { reconcile = reconcileAccount, withLease = withBillingLease } = dependencies;
  if (action && !["cancel", "payment_method"].includes(action)) throw new HttpError("Unknown billing action", 422);
  const result = await reconcile(user);
  user = result?.user || user;
  if (!user.subscription?.customerId) throw new HttpError("No billing account yet. Choose a subscription to get started.", 409);
  const region = result?.region || canonicalStripeRegion(user.subscription.stripeRegion || DEFAULT_REGION);
  const stripe = result?.stripe || createStripeClient(region);
  const return_url = billingReturnUrl(returnUrl);
  if (freeAlumni && result?.sub) {
    await withLease(`subscription:${region}:${result.sub.id}`, async ({ assertOwned }) => {
      await assertOwned();
      await user.constructor.updateOne({ _id: user.id, "subscription.id": result.sub.id }, { $set: {
        "subscription.freeAlumniRequested": true, "subscription.freeAlumniPriceId": user.subscription.priceId,
      } });
    });
  }
  const locked = !accountEntitlements(user).hasBenefits;
  const data = { customer: user.subscription.customerId, return_url };
  if (priceId) {
    const plan = planForPrice(priceId, { selectable: true });
    if (!plan) throw new HttpError("Unknown membership plan", 422);
    if (locked || !result?.sub || result.sub.pending_update || result.sub.schedule || result.sub.cancel_at_period_end) {
      throw new HttpError("Resolve your payment, pending change or scheduled cancellation in Payments before changing plans.", 409);
    }
    const item = result.sub.items.data[0];
    if (stripeId(item.price) === priceId) throw new HttpError("You already have this plan", 409);
    const current = planForPrice(stripeId(item.price));
    if (!current || !planChangeChargesImmediately(current, plan)) throw new HttpError("Use the website Switch button to update your tier or payment period without an immediate charge.", 409);
    data.flow_data = { type: "subscription_update_confirm", subscription_update_confirm: {
      subscription: result.sub.id, items: [{ id: item.id, price: priceId, quantity: 1 }],
    } };
  } else if (action === "cancel" && result?.sub && !ENDED_SUBSCRIPTION_STATUSES.includes(result.sub.status)) {
    data.flow_data = { type: "subscription_cancel", subscription_cancel: { subscription: result.sub.id } };
  } else if (action === "payment_method") data.flow_data = { type: "payment_method_update" };
  if (data.flow_data) data.flow_data.after_completion = { type: "redirect", redirect: { return_url } };
  // Only the authenticated /change path supplies a validated price. Generic
  // Payments, cancellation and recovery sessions cannot expose a plan picker.
  data.configuration = await portalConfiguration(stripe, region, locked, {
    switching: data.flow_data?.type === "subscription_update_confirm", withLease,
  });
  // flow_data postdates the project's original 2022 API pin. Scope the newer
  // version to portal sessions so event checkout/webhook payloads stay compatible.
  return stripe.billingPortal.sessions.create(data, { apiVersion: "2024-06-20" });
}

async function assertNoExistingSubscription(stripe, customer) {
  for await (const sub of stripe.subscriptions.list({ customer, status: "all", limit: 100 })) {
    if (!ENDED_SUBSCRIPTION_STATUSES.includes(sub.status)) {
      throw new HttpError("You already have a subscription. Manage it in the billing portal.", 409);
    }
  }
}

export async function reserveCheckout({ key, user, registration, plan, returnUrl, region, dependencies = {} }) {
  const { withLease = withBillingLease, records = BillingRecord, prepareReturn = preparePaymentReturn } = dependencies;
  if (!user) registrationPasswordHash(registration);
  return withLease(key, async ({ record, assertOwned }) => {
    const stripe = dependencies.stripe || createStripeClient(region);
    let data = record.data || {};
    if (data.sessionId) {
      const previousStripe = data.stripeRegion && data.stripeRegion !== region ?
        dependencies.previousStripe || createStripeClient(data.stripeRegion) : stripe;
      const previous = await previousStripe.checkout.sessions.retrieve(data.sessionId);
      if (previous.status === "open") {
        if (data.priceId !== plan.priceId) throw new HttpError("A different checkout is already open. Complete it or let it expire before choosing another plan.", 409);
        return previous;
      }
      if (previous.status === "complete" && !record.completedAt) throw new HttpError("Your payment is being processed. Please refresh your account shortly.", 409);
      data = { customerId: !data.stripeRegion || data.stripeRegion === region ? data.customerId : undefined };
    }
    if (data.operationId && data.stripeRegion && data.stripeRegion !== region) throw new HttpError("A checkout is still pending on your previous billing account. Please retry after it completes or expires.", 409);
    if (data.operationId && data.priceId !== plan.priceId) throw new HttpError("Another checkout is being created. Please retry the original plan shortly.", 409);
    const sameStripeAccount = !user?.subscription?.stripeRegion || user.subscription.stripeRegion === region ||
      canonicalStripeRegion(user.subscription.stripeRegion) === canonicalStripeRegion(region);
    if (user?.subscription?.customerId && !sameStripeAccount) throw new HttpError("Your existing billing customer belongs to another Stripe account. Please contact support.", 409);
    const customerId = user?.subscription?.customerId || data.customerId ||
      (await stripe.customers.create({ email: user?.email || registration.email }, { idempotencyKey: `customer:${key}` })).id;
    if (user && !user.subscription?.id && !user.subscription?.customerId) {
      if (!user.subscription) user.subscription = {};
      user.subscription.customerId = customerId;
      user.subscription.stripeRegion = region;
      await assertOwned();
      await user.save();
    }
    await assertNoExistingSubscription(stripe, customerId);
    // Persist the operation before contacting Stripe. Network retries use the
    // same idempotency key, so concurrent clicks cannot make duplicate checkouts.
    const revenueAllocation = data.operationId ? data.revenueAllocation :
      region === DEFAULT_REGION ? memberRevenueAllocation(plan, user?.region || registration?.region) : null;
    data = { ...data, reservedAt: data.reservedAt || (data.operationId ? record.createdAt : new Date()), revenueAllocation, operationId: data.operationId || randomUUID(), paymentReturnToken: data.paymentReturnToken || newPaymentToken(), customerId, priceId: plan.priceId,
      userId: user?.id, registration: user ? undefined : data.registration || registration, stripeRegion: region,
      returnUrl: data.returnUrl || billingReturnUrl(returnUrl) };
    if (!user) registrationPasswordHash(data.registration);
    await records.updateOne({ _id: key }, { $set: { data }, $unset: { completedAt: 1 } }, { upsert: true });
    const origin = new URL(data.returnUrl).origin;
    const receipt = await prepareReturn({ token: data.paymentReturnToken, origin, kind: "subscription", region,
      returnPath: user ? "/user#settings" : plan.type === "alumni" ? "/alumni/register" : `/${registration?.region || region}/signup` });
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", customer: customerId, allow_promotion_codes: false,
      line_items: [{ price: plan.priceId, quantity: 1 }],
      success_url: receipt.success_url,
      cancel_url: receipt.cancel_url,
      metadata: { method: "membership_checkout", checkoutKey: key, paymentReturnId: receipt.id },
      subscription_data: { metadata: { bgsnlCheckoutKey: key,
        ...memberRevenueMetadata(data.revenueAllocation, customerId, data.operationId) } },
    }, { idempotencyKey: `checkout:${data.operationId}` });
    await assertOwned();
    await receipt.bind(session.id);
    await records.updateOne({ _id: key }, { $set: { "data.sessionId": session.id } });
    return session;
  });
}

export async function startMembershipChange(user, { priceId, returnUrl, dependencies = {} }) {
  const { reconcile = reconcileAccount, openPortal = createMembershipPortal, checkout = reserveCheckout, changeAtRenewal = changePlanAtRenewal } = dependencies;
  const plan = priceId === FREE_ALUMNI_PLAN.priceId ? FREE_ALUMNI_PLAN : planForPrice(priceId, { selectable: true });
  if (!plan) throw new HttpError("Unknown membership plan", 422);
  const result = await reconcile(user);
  user = result?.user || user;
  if (!["active", "locked", "payment_awaiting"].includes(user.status)) throw new HttpError("Please contact support about your account", 403);
  if (user.subscription?.id && !ENDED_SUBSCRIPTION_STATUSES.includes(user.subscription.status)) {
    if (plan.tier === 0) return openPortal(user, { returnUrl, action: "cancel", freeAlumni: true });
    const current = planForPrice(stripeId(result?.sub?.items?.data?.[0]?.price));
    if (!current) throw new HttpError("Your current subscription could not be verified. Please try again or contact support.", 409);
    if (!planChangeChargesImmediately(current, plan)) return changeAtRenewal(user, plan, { stripe: result.stripe, region: result.region });
    return openPortal(user, { priceId, returnUrl });
  }
  if (plan.tier === 0) {
    await withBillingLease(`account-checkout:${user.id}`, async ({ assertOwned }) => {
      await persistSubscriptionAccount(user, { status: "active", subscription: {
        ...(user.subscription?.toObject() || {}), freeAlumniRequested: true, hasBenefits: false, lockReason: null,
      } }, plan, assertOwned);
    });
    return { url: billingReturnUrl(returnUrl) };
  }
  return checkout({ key: `account-checkout:${user.id}`, user, plan, returnUrl,
    region: membershipCheckoutRegion(user, result?.region) });
}

// Read-only invoice preview: no Checkout/Portal session, invoice, or payment is
// created. Derive ownership, price and billing timing on the server.
export async function previewMembershipChange(user, { priceId, dependencies = {} }) {
  const { reconcile = reconcileAccount, stripeForRegion = createStripeClient } = dependencies;
  const plan = planForPrice(priceId, { selectable: true });
  if (!plan) throw new HttpError("Unknown membership plan", 422);
  const result = await reconcile(user);
  user = result?.user || user;
  if (!["active", "locked", "payment_awaiting"].includes(user.status)) throw new HttpError("Please contact support about your account", 403);
  const running = user.subscription?.id && !ENDED_SUBSCRIPTION_STATUSES.includes(user.subscription.status);
  const sub = result?.sub;
  const params = {};
  if (running) {
    if (!accountEntitlements(user).hasBenefits || !sub || sub.pending_update || sub.schedule || sub.cancel_at_period_end || sub.cancel_at) {
      throw new HttpError("Resolve your pending billing changes before switching plans.", 409);
    }
    const item = sub.items?.data?.[0];
    const current = sub.items?.data?.length === 1 && item.quantity === 1 && planForPrice(stripeId(item.price));
    if (!current || stripeId(sub.customer) !== user.subscription.customerId || sub.id !== user.subscription.id) {
      throw new HttpError("Subscription could not be verified", 409);
    }
    if (!planChangeChargesImmediately(current, plan)) return { priceId, amountDue: 0, currency: "eur", chargeNow: false };
    params.subscription = sub.id;
    params.subscription_items = [{ id: item.id, price: priceId, quantity: 1 }];
    params.subscription_proration_behavior = "always_invoice";
    // The pinned portal flow ends an existing trial on upgrade/conversion.
    if (sub.status === "trialing") params.subscription_trial_end = "now";
  } else params.subscription_items = [{ price: priceId, quantity: 1 }];
  const region = result?.region || membershipCheckoutRegion(user);
  const stripe = result?.stripe || stripeForRegion(region);
  await membershipPrice(stripe, plan);
  if (user.subscription?.customerId) params.customer = user.subscription.customerId;
  const invoice = await stripe.invoices.retrieveUpcoming(params);
  if (!Number.isSafeInteger(invoice.amount_due) || invoice.amount_due < 0 || invoice.currency !== "eur" ||
      (params.customer && stripeId(invoice.customer) !== params.customer)) throw new HttpError("The payment amount could not be verified", 503);
  return { priceId, amountDue: invoice.amount_due, currency: invoice.currency, chargeNow: true };
}

export async function startMembershipSignup(body, file, { findAccount = findUserByEmail, checkout = reserveCheckout } = {}) {
  const plan = planForPrice(body.itemId, { selectable: true });
  if (!plan || (body.method === "signup" ? "member" : "alumni") !== plan.type) throw new HttpError("Invalid signup plan", 422);
  const email = normalizeEmail(body.email);
  if (!email) throw new HttpError("Please provide a valid email", 422);
  if (await findAccount(email)) throw new HttpError("An account already exists. Please sign in to change your subscription.", 409);
  const registration = {};
  for (const field of ["name", "surname", "birth", "phone", "university", "region", "otherUniversityName", "graduationDate", "course", "studentNumber", "profession", "notificationTypeTerms"]) {
    if (body[field] !== undefined) registration[field] = body[field];
  }
  registration.email = email;
  // Preserve the reservation field used by older API instances during a rolling
  // deploy. Its VALUE is always a server-created hash, never plaintext.
  registration.password = await hashPassword(decryptData(body.password));
  registration.image = file?.Location || file?.location || chooseRandomAvatar();
  registration.notificationTerms = body.notificationTerms === true || body.notificationTerms === "true";
  return checkout({ key: `signup:${hash(email)}`, registration, plan,
    returnUrl: body.origin_url, region: DEFAULT_REGION });
}

export async function completeMembershipCheckout(session, region, {
  withLease = withBillingLease, records = BillingRecord, stripeClient = createStripeClient,
  readSubscription = readStripeSubscription, reconcile = reconcileSubscription,
  notifyMember = welcomeEmail, notifyAlumni = alumniWelcomeEmail,
  resolveAccount = resolveCheckoutAccount, reconcileExisting = reconcileAccount,
  readRevenueAllocation = registerMemberRevenueSubscription,
  createAccount = createSubscriptionAccount, persistAccount = persistSubscriptionAccount,
} = {}) {
  const key = session.metadata?.checkoutKey;
  if (!key || session.mode !== "subscription" || session.status !== "complete" || !session.subscription) return;
  const subscriptionId = stripeId(session.subscription);
  await withLease(key, async ({ record, assertOwned }) => {
    const data = record.data;
    if (!data) {
      const existing = await resolveAccount({ subscriptionId, customerId: stripeId(session.customer) });
      if (existing?.subscription?.id === subscriptionId && existing.subscription.customerId === stripeId(session.customer)) return;
      throw new Error("Checkout registration state is unavailable; restore Redis before fulfilling this payment");
    }
    if ( data.sessionId !== session.id || data.customerId !== stripeId(session.customer) ||
        canonicalStripeRegion(data.stripeRegion) !== canonicalStripeRegion(region)) throw new Error("Checkout ownership mismatch");
    if (record.completedAt) return;
    const { sub, state } = await readSubscription(stripeClient(region), subscriptionId);
    if (stripeId(sub.customer) !== data.customerId || !state.plan || state.plan.priceId !== data.priceId) throw new Error("Checkout price mismatch");
    const revenueAllocation = await readRevenueAllocation(sub, { records });
    let user = await resolveAccount({ subscriptionId, customerId: data.customerId, userId: data.userId, email: data.registration?.email });
    if (user?.subscription?.id && user.subscription.id !== subscriptionId) {
      const previous = await reconcileExisting(user);
      if (!previous?.state.ended) throw new Error("Refusing to replace an existing subscription");
      user = previous.user;
    }
    if (!user && data.userId) throw new Error("Checkout account no longer exists");
    const created = !user;
    if (!user) {
      const Model = state.plan.type === "alumni" ? AlumniUser : MemberUser;
      const storedHash = registrationPasswordHash(data.registration);
      const registration = { ...data.registration };
      delete registration.password;
      delete registration.passwordHash;
      user = new Model({ ...registration, password: storedHash, roles: [state.plan.type], tier: state.plan.tier,
        joinDate: new Date(sub.created * 1000), expireDate: new Date((state.periodEnd || sub.created) * 1000) });
    }
    // Until reconciliation completes, no benefits are granted by checkout alone.
    const status = created || ["active", "locked", "payment_awaiting"].includes(user.status) ? "payment_awaiting" : user.status;
    const subscription = { id: subscriptionId, customerId: data.customerId, stripeRegion: canonicalStripeRegion(region), period: state.plan.period, priceId: state.plan.priceId };
    subscription.connected = accountType(user) === "member" && hasMemberConnectAllocation(subscription, revenueAllocation);
    await assertOwned();
    if (created) {
      user.set({ status, subscription });
      user = await createAccount(user, assertOwned);
    } else {
      user = await persistAccount(user, { status, subscription }, null, assertOwned);
    }
    await records.updateOne({ _id: key }, { $set: { completedAt: new Date() }, $unset: { "data.registration": 1 } });
    if (created && state.hasBenefits) {
      if (state.plan.type === "alumni") notifyAlumni(user.email, user.name);
      else notifyMember(user.email, user.name, user.region);
    }
  });
  await reconcile(subscriptionId, region, { expectedCustomerId: stripeId(session.customer) });
}
