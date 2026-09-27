import { findBillingAccount } from "./accounts.js";
import { findUserById, normalizeEmail } from "../main-services/user-service.js";

const findEmailAccount = (email) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return findBillingAccount({ email: new RegExp(`^${escaped}$`, "i") });
};

// Checkout's saved account ID is authoritative. Anonymous signups may reuse
// an account only when Stripe ownership also matches, never by email alone.
export async function resolveCheckoutAccount({ subscriptionId, customerId, userId, email }, {
  findAccount = findBillingAccount, findById = findUserById, findByEmail = findEmailAccount,
} = {}) {
  if (typeof subscriptionId !== "string" || !subscriptionId || typeof customerId !== "string" || !customerId) {
    throw new Error("Checkout is missing its Stripe billing identity");
  }
  const owner = await findAccount({ "subscription.id": subscriptionId });
  const requested = userId ? await findById(userId) : null;
  if (userId && !requested) throw new Error("Checkout account no longer exists");
  if (owner) {
    if (owner.subscription?.customerId !== customerId || (requested && String(requested.id) !== String(owner.id))) {
      throw new Error("Checkout account ownership mismatch");
    }
    return owner;
  }
  const user = requested || await findAccount({ "subscription.customerId": customerId }) || await findByEmail(email);
  if (user && !requested && user.subscription?.customerId !== customerId) {
    throw new Error("Signup email already belongs to another account; sign in to change its membership");
  }
  return user;
}
