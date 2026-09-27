import { LIMITLESS_ACCOUNT } from "../../util/config/defines.js";
import { accountEntitlements } from "../../util/subscriptions/policy.js";
import { reconcileAccount } from "../subscriptions/reconcile.js";
import { isBirthdayToday } from "../../util/functions/helpers.js";
import { sessions } from "./sessions.js";
import HttpError from "../../models/Http-error.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

export async function buildLoginResponse(user, { reconcile = reconcileAccount, sign = sessions.start } = {}) {
  const authenticatedVersion = Number(user.sessionVersion ?? 0);
  const authenticatedPassword = user.password;
  if (!user.subscription?.id && ["active", "locked", "payment_awaiting"].includes(user.status) &&
      !user.roles?.some((role) => LIMITLESS_ACCOUNT.includes(role)) && user.tier !== 0 && new Date(user.expireDate) < new Date()) {
    user.status = "locked";
    await user.save();
  }
  let billingVerificationUnavailable = false;
  try { user = (await reconcile(user))?.user || user; }
  catch (error) { logOperationalError("service.login-billing-verification", error); billingVerificationUnavailable = true; }
  if (Number(user.sessionVersion ?? 0) !== authenticatedVersion || user.password !== authenticatedPassword) {
    throw new HttpError("Account security changed during sign-in. Please sign in again.", 401);
  }
  const credentials = await sign(user);
  return {
    ...(typeof credentials === "string" ? { token: credentials } : credentials), image: user.image, region: user.region, roles: user.roles,
    ...accountEntitlements(user), billingVerificationUnavailable,
    ...(billingVerificationUnavailable ? { hasBenefits: false, memberDiscount: false } : {}),
    ...(isBirthdayToday(user.birth) ? { celebrate: true } : {}),
  };
}
