import AuthRateLimit from "../../models/AuthRateLimit.js";
import HttpError from "../../models/Http-error.js";
import { digest } from "./policy.js";

export async function consumeSupportLimit(key, maximum, windowMs, { limits = AuthRateLimit, now = Date.now() } = {}) {
  const bucket = Math.floor(now / windowMs);
  const id = `support:${digest(key)}:${windowMs}:${bucket}`;
  let result;
  try {
    result = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) } }, { upsert: true, new: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    result = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true });
  }
  if (!result || result.count > maximum) throw new HttpError("Too many support requests. Please wait a few minutes and try again.", 429);
}

export async function limitSupportRequest(req) {
  const identity = req.account ? `account:${req.account._id || req.account.id}` : `ip:${req.ip}`;
  if (req.method === "POST" && req.path === "/conversations") {
    // A site-wide creation budget also bounds spam if proxy IP headers can be
    // spoofed. This service inherits the API's proxy configuration.
    await consumeSupportLimit("all-creations", 200, 60 * 60000);
    await consumeSupportLimit(`create:${identity}`, 8, 15 * 60000);
  } else if (req.method !== "GET") {
    await consumeSupportLimit(`write:${identity}`, 60, 15 * 60000);
  } else {
    await consumeSupportLimit(`read:${identity}`, 180, 60000);
  }
}
