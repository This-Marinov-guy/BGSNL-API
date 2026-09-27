import { redisRecordStore } from "../services/storage/redis-records.js";
import { checkoutDeadline } from "../services/storage/retention.js";
// Recovery has a fixed 30-day window; polling and retries cannot renew it.
// Stripe metadata handles historical replays after completed state expires.
export default redisRecordStore("checkout-state", {
  expiresAtFor: checkoutDeadline,
});
