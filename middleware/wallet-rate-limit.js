import { createHash } from "node:crypto";
import { redisRateLimits as limits } from "../services/storage/rate-limits.js";
import { requestClientAddress } from "../util/auth/request-client.js";
import HttpError from "../models/Http-error.js";

// Applies even to SSR-proxied reads; token rotation cannot create new buckets.
export async function walletPublicRateLimit(req, res, next) {
  const window = 15 * 60 * 1000, bucket = Math.floor(Date.now() / window);
  const id = `wallet-public:${createHash("sha256").update(requestClientAddress(req)).digest("hex")}:${bucket}`;
  try {
    let record;
    try { record = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * window) } }, { upsert: true, new: true }); }
    catch (error) {
      if (error.code !== 11000) throw error;
      record = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true });
    }
    if (!record || record.count > 120) {
      res.set("Retry-After", "60");
      return next(new HttpError("Wallet verification rate limit exceeded", 429));
    }
    return next();
  } catch { return next(new HttpError("Card verification is temporarily unavailable.", 503)); }
}
