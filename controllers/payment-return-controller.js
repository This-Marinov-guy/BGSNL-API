import HttpError from "../models/Http-error.js";
import { readPaymentReturn } from "../services/payments/payment-return.js";

export async function paymentResult(req, res, next) {
  res.set("Cache-Control", "private, no-store, max-age=0");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  try {
    const result = await readPaymentReturn(req.body?.token);
    res.json(result);
  } catch (error) {
    // Never include Stripe's raw error or the receipt token in logs/responses.
    next(error instanceof HttpError ? error : new HttpError("We could not verify your payment right now. Please try again shortly.", 503));
  }
}
