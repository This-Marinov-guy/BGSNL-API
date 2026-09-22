import { notifyWebhookError } from "../services/background-services/developer-notifications.js";

export const createWebhookErrorObserver = (notify = notifyWebhookError) => (_req, res, next) => {
  // Observe after response completion: alerts never delay or alter Stripe retries.
  // Mounted before the raw-body parser so parser errors are covered as well.
  res.once("finish", () => {
    if (res.statusCode < 400) return;
    Promise.resolve().then(() => notify({ provider: "stripe", status: res.statusCode,
      ...res.locals.verifiedWebhookEvent })).catch(() => {
      console.error("Developer webhook alert failed.");
    });
  });
  next();
};

export const observeWebhookErrors = createWebhookErrorObserver();
