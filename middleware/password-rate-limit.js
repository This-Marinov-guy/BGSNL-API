import { createHash } from "node:crypto";
import AuthRateLimit from "../models/AuthRateLimit.js";
import HttpError from "../models/Http-error.js";
import { requestClientAddress } from "../util/auth/request-client.js";

export const createPasswordRateLimit = (purpose, { limits = AuthRateLimit, now = Date.now } = {}) => async (req, res, next) => {
  const windowMs = 15 * 60 * 1000;
  const bucket = Math.floor(now() / windowMs);
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  try {
    // Account limits still apply when attackers rotate or spoof IP addresses.
    const identity = req.account ? `account:${req.account.id}` : purpose === "profile-confirm"
      ? `confirmation:${String(req.body?.confirmationToken || "").slice(0, 100)}` : `email:${email}`;
    for (const [key, maximum] of [[`ip:${requestClientAddress(req)}`, 30], [identity, purpose === "reset-send" ? 3 : 10]]) {
      const id = `password:${purpose}:${createHash("sha256").update(key).digest("hex")}:${bucket}`;
      let record;
      try {
        record = await limits.findOneAndUpdate({ _id: id }, {
          $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((bucket + 2) * windowMs) },
        }, { upsert: true, new: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        record = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true });
      }
      if (!record || record.count > maximum) {
        res.set("Retry-After", String(Math.ceil(((bucket + 1) * windowMs - now()) / 1000)));
        return next(new HttpError("Too many attempts. Please try again in 15 minutes.", 429));
      }
    }
    return next();
  } catch {
    return next(new HttpError("Sign-in protection is temporarily unavailable. Please try again shortly.", 503));
  }
};
