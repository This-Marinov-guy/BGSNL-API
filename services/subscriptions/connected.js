import { DEFAULT_REGION } from "../../util/config/defines.js";
import { validMemberRevenueAllocation } from "../../util/config/member-revenue.js";
import { planForPrice } from "../../util/subscriptions/policy.js";

// A reporting flag, not an instruction to enrol or transfer money. The durable
// allocation remains authoritative even while the transfer worker is paused.
export function hasMemberConnectAllocation(subscription, allocation) {
  return !!(subscription?.id && subscription.customerId &&
    subscription.stripeRegion === DEFAULT_REGION && planForPrice(subscription.priceId)?.type === "member" &&
    validMemberRevenueAllocation(allocation) && allocation.subscriptionId === subscription.id &&
    allocation.customerId === subscription.customerId);
}
