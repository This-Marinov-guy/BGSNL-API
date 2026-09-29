import { createHmac, timingSafeEqual } from "node:crypto";
import { sendEmail } from "../background-services/email-provider.js";
import { consumeSupportLimit } from "../support/rate-limit.js";
import { HOME_URL, NO_REPLY_EMAIL, NO_REPLY_EMAIL_NAME } from "../../util/config/defines.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import HttpError from "../../models/Http-error.js";
import { ACCESS_2, ACCESS_3, BILLING_LOCKED_STATUSES, BILLING_LOCK_EXEMPT, REGIONS } from "../../util/config/defines.js";
import { canManageAccountType, canEditProtectedAccount, normalizeRoleNames } from "../../util/config/account-roles.js";
import { ENDED_SUBSCRIPTION_STATUSES, stripeId } from "../../util/subscriptions/policy.js";
import { resolveSubscriptionRegion, reconcileSubscription } from "../subscriptions/reconcile.js";
import { createStripeClient } from "../../util/config/stripe.js";
import { withBillingLease } from "../subscriptions/lease.js";
import { logIntegrationError, logOperationalError } from "../../middleware/axiom-logger.js";

export function assertAccountManagementAccess(actor, target) {
  const roles = normalizeRoleNames(actor?.roles);
  const statusAllowed = actor?.status === "active" ||
    (BILLING_LOCKED_STATUSES.includes(actor?.status) && roles.some(role => BILLING_LOCK_EXEMPT.includes(role)));
  if (!statusAllowed || !roles.some(role => ACCESS_3.includes(role))) throw new HttpError("Only board members and admins can manage membership", 403);
  if (!roles.some(role => ACCESS_2.includes(role)) &&
      (!REGIONS.includes(actor.region) || target.region !== actor.region)) throw new HttpError("You can only manage accounts in your own region", 403);
  const targetRoles = normalizeRoleNames(target.roles);
  if (!canEditProtectedAccount(roles, targetRoles) ||
      (targetRoles.includes("national_board_member") && !roles.some(role => ACCESS_2.includes(role)))) {
    throw new HttpError("Your role cannot manage this account's membership", 403);
  }
}

const periodEnd = sub => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
const cancellationReason = (sub, timestamp) => !sub ? "This account has no subscription." :
  ENDED_SUBSCRIPTION_STATUSES.includes(sub.status) ? "This subscription has already ended." :
  sub.cancel_at_period_end || sub.cancel_at ? "Cancellation is already scheduled." :
  sub.schedule || sub.pending_update ? "Resolve the scheduled or pending plan change before cancelling." :
  !["active", "trialing", "past_due", "unpaid"].includes(sub.status) ? "This subscription cannot be cancelled from this panel." :
  !Number.isFinite(periodEnd(sub)) || periodEnd(sub) * 1000 <= timestamp ? "The billing period must be refreshed before cancelling." : null;

export const createAccountActionsService = ({ memberModel = MemberUser, alumniModel = AlumniUser,
  resolveRegion = resolveSubscriptionRegion, stripeClient = createStripeClient,
  withLease = withBillingLease, reconcile = reconcileSubscription, now = Date.now,
  secret = () => process.env.JWT_STRING, deliver = sendEmail, limit = consumeSupportLimit,
} = {}) => {
  const loadTarget = async ({ type, id, actor }) => {
    if (!["member", "alumni"].includes(type) || typeof id !== "string" || !id || id.length > 100) throw new HttpError("Invalid account", 422);
    if (!canManageAccountType(actor?.roles, type)) throw new HttpError("No access to Alumni administration", 403);
    // Reject unauthorized callers before loading another person's account.
    assertAccountManagementAccess(actor, { roles: [], region: actor?.region });
    const target = await (type === "member" ? memberModel : alumniModel).findById(id);
    if (!target) throw new HttpError("Account not found. Refresh the list.", 404);
    assertAccountManagementAccess(actor, target);
    if (["alumni-migrated", "membership_active", "membership-migrated"].includes(target.status)) throw new HttpError("This account has moved. Refresh the list.", 409);
    return target;
  };
  const readBilling = async target => {
    if (!target.subscription?.id) return { sub: null };
    if (!target.subscription.customerId) throw new HttpError("Subscription ownership could not be verified", 409);
    const region = await resolveRegion(target);
    const stripe = stripeClient(region);
    const sub = await stripe.subscriptions.retrieve(target.subscription.id);
    if (sub.id !== target.subscription.id || stripeId(sub.customer) !== target.subscription.customerId) throw new HttpError("Subscription ownership could not be verified", 409);
    return { sub, stripe, region };
  };
  const signature = (args, target, sub, timestamp) => {
    const key = secret();
    if (!key) throw new HttpError("Membership actions are temporarily unavailable", 503);
    return createHmac("sha256", key).update(JSON.stringify(["backoffice-membership-cancel-v1", timestamp,
      String(args.actor?._id || args.actor?.id), args.type, String(target._id || target.id), Number(target.__v || 0),
      target.region, target.roles, target.status, sub.id, stripeId(sub.customer), sub.status,
      periodEnd(sub), sub.cancel_at_period_end, sub.cancel_at, stripeId(sub.schedule), sub.pending_update,
    ])).digest("hex");
  };
  const confirmationFor = (args, target, sub) => {
    const timestamp = now();
    return `${timestamp}.${signature(args, target, sub, timestamp)}`;
  };
  const checkConfirmation = (args, target, sub) => {
    const token = args.body?.confirmation;
    if (Object.keys(args.body || {}).some(key => key !== "confirmation") || typeof token !== "string" || !/^\d{13}\.[a-f0-9]{64}$/.test(token)) throw new HttpError("Review and confirm the cancellation first", 422);
    const [stamp, digest] = token.split(".");
    const timestamp = Number(stamp);
    if (timestamp > now() || now() - timestamp > 15 * 60 * 1000 ||
        !timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(signature(args, target, sub, timestamp), "hex"))) {
      throw new HttpError("This account or subscription changed. Refresh and review the cancellation again.", 409);
    }
  };
  const inspect = async args => {
    const target = await loadTarget(args);
    const canTransfer = ["active", "locked", "payment_awaiting"].includes(target.status);
    let sub;
    try { ({ sub } = await readBilling(target)); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      logIntegrationError("stripe", error, "account-billing-inspect");
      // A stale reference or unavailable Stripe account must never look like
      // a cancellable subscription. Transfer requests do not modify billing.
      return { canTransfer, canCancel: false, billingUnavailable: true, confirmation: null,
        cancellationReason: "We could not verify the subscription. Cancellation is unavailable until the billing reference and connection are checked.",
        subscription: null };
    }
    const reason = cancellationReason(sub, now());
    return { canTransfer,
      canCancel: !reason, cancellationReason: reason,
      confirmation: !reason ? confirmationFor(args, target, sub) : null,
      subscription: sub ? { status: sub.status, cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        cancelAt: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
        currentPeriodEnd: periodEnd(sub) ? new Date(periodEnd(sub) * 1000).toISOString() : null } : null,
    };
  };
  const cancel = async args => {
    let target = await loadTarget(args);
    if (!target.subscription?.id) throw new HttpError("This account has no subscription", 409);
    const region = await resolveRegion(target);
    const subscriptionId = target.subscription.id;
    const result = await withLease(`subscription:${region}:${subscriptionId}`, async ({ assertOwned }) => {
      target = await loadTarget(args);
      if (target.subscription?.id !== subscriptionId || await resolveRegion(target) !== region) throw new HttpError("The subscription changed. Refresh and try again.", 409);
      const { sub, stripe } = await readBilling(target);
      checkConfirmation(args, target, sub);
      const reason = cancellationReason(sub, now());
      if (reason) throw new HttpError(reason, 409);
      await assertOwned();
      const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true }, {
        idempotencyKey: `board-cancel:${sub.id}:${args.body.confirmation}`,
      });
      return { cancelAt: new Date((updated.cancel_at || periodEnd(updated)) * 1000).toISOString(), customerId: target.subscription.customerId };
    });
    // Stripe is authoritative. A delayed local refresh must not misreport a successful cancellation.
    let syncPending = false;
    try { await reconcile(subscriptionId, region, { expectedCustomerId: result.customerId }); }
    catch (error) { logOperationalError("service.subscription-cancellation-sync", error); syncPending = true; }
    return { cancelled: true, cancelAt: result.cancelAt, syncPending,
      message: "Renewal cancelled. Existing paid access continues until the end of the billing period." };
  };
  const requestTransfer = async args => {
    const target = await loadTarget(args);
    if (Object.keys(args.body || {}).length) throw new HttpError("Transfer requests do not accept account or billing overrides", 422);
    if (!["active", "locked", "payment_awaiting"].includes(target.status)) throw new HttpError("Resolve the account restriction before requesting a transfer", 409);
    if (typeof target.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.email)) throw new HttpError("A valid account email is required", 409);
    const targetType = args.type === "member" ? "alumni" : "member";
    const label = targetType === "alumni" ? "Alumni" : "Member";
    // This is an ordinary authenticated settings link, not a login or billing capability.
    // Its only effect is to preselect the requested membership type for the owner.
    const url = `${HOME_URL}/user?transferTo=${targetType}#settings`;
    const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    await limit(`board-transfer:actor:${args.actor._id || args.actor.id}`, 20, 60 * 60 * 1000);
    await limit(`board-transfer:account:${target.id || target._id}`, 3, 24 * 60 * 60 * 1000);
    const response = await deliver({
      from: { email: NO_REPLY_EMAIL, name: NO_REPLY_EMAIL_NAME }, to: [{ email: target.email }],
      subject: `Review your transfer to ${label}`, category: "membership-transfer",
      text: `The BGSNL board has requested a transfer of your account to ${label}. Sign in using ${target.email}, choose a plan and review any charge before confirming: ${url} . Your account and subscription have not changed. If you do not want this transfer, ignore this email.`,
      html: `<p>Hello ${escape(target.name || "")},</p><p>The BGSNL board has requested a transfer of your account to <strong>${label}</strong>.</p><p>Sign in using <strong>${escape(target.email)}</strong>, choose a plan and review any charge before confirming.</p><p><a href="${escape(url)}">Review transfer to ${label}</a></p><p>Your account and subscription have not changed. If you do not want this transfer, ignore this email.</p>`,
    });
    if (response?.error || response?.success === false) throw new HttpError("The transfer email could not be accepted. Please try again.", 503);
    return { requested: true, targetType, message: `Transfer email queued for ${target.email}. The account holder must confirm the new plan.` };
  };
  return { inspect, cancel, requestTransfer };

};
export const accountActionsService = createAccountActionsService();
