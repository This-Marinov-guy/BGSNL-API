import { verifySessionToken } from "../util/auth/session-token.js";
import HttpError from "../models/Http-error.js";
import { findUserById } from "../services/main-services/user-service.js";
import { accountEntitlements } from "../util/subscriptions/policy.js";
import { reconcileAccount } from "../services/subscriptions/reconcile.js";
import { sessions } from "../services/authentication/sessions.js";

export const createAuthMiddleware = ({ findAccount = findUserById, validateSession = sessions.validate } = {}) => async (req, res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (!token) return next(new HttpError("Please login to access this request", 401));
  let claims;
  try {
    claims = verifySessionToken(token);
  } catch (error) {
    // Only this pre-handler failure is eligible for one safe server-side retry.
    if (error.name === "TokenExpiredError") return res.status(401).json({ code: "ACCESS_TOKEN_EXPIRED", message: "Access token expired" });
    return next(new HttpError("Session invalid: please login again!", 401));
  }
  try {
    const account = await findAccount(claims.userId);
    if (!account) return next(new HttpError("Account no longer available. Please login again.", 401));
    if (Number(claims.sessionVersion ?? 0) !== Number(account.sessionVersion ?? 0)) return next(new HttpError("Session revoked. Please login again.", 401));
    await validateSession(claims, account);
    req.account = account;
    req.authClaims = claims;
    req.user = { userId: account.id, email: account.email, image: account.image,
      roles: account.roles, status: account.status, region: account.region,
      customerId: account.subscription?.customerId, ...accountEntitlements(account) };
    res.set("Cache-Control", "private, no-store");
    return next();
  } catch (error) { return next(error instanceof HttpError ? error : new HttpError("Could not verify your account. Please try again.", 503)); }
};
export const authMiddleware = createAuthMiddleware();

export const optionalAuthMiddleware = (req, res, next) =>
  req.headers.authorization ? authMiddleware(req, res, next) : next();

export const requireBenefits = (benefit = "hasBenefits") => async (req, res, next) => {
  if (!req.account) return next(new HttpError("Please login to use membership benefits", 401));
  try {
    const result = await reconcileAccount(req.account);
    req.account = result?.user || req.account;
    const access = accountEntitlements(req.account);
    req.user = { ...req.user, userId: req.account.id, roles: req.account.roles, ...access };
    if (!access[benefit]) return next(new HttpError("Your membership benefits are unavailable. Please manage your subscription in account settings.", 403));
    return next();
  } catch { return next(new HttpError("We could not verify your subscription. Please try again shortly.", 503)); }
};

export const adminMiddleware = (requiredRoles = []) => (req, res, next) =>
  authMiddleware(req, res, (error) => {
    if (error) return next(error);
    if (req.account.status !== "active" || !requiredRoles.some((role) => req.account.roles?.includes(role))) {
      return next(new HttpError("No access for such request", 403));
    }
    return next();
  });
