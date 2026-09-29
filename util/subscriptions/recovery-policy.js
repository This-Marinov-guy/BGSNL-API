import { DEFAULT_REGION } from "../config/defines.js";

// Stripe owns attempt scheduling and failure emails for central billing.
// Regional subscriptions retain their existing application reminder policy.
// Call with the canonical Stripe region, not the member's home region.
export const stripeOwnsBillingEmails = (stripeRegion) => stripeRegion === DEFAULT_REGION;
