import { notifyWebhookError } from "../services/background-services/developer-notifications.js";
import { ingestLog, logOperationalError } from "./axiom-logger.js";

export const createWebhookErrorObserver = (notify = notifyWebhookError, log = ingestLog) => (_req, res, next) => {
  // Observe after response completion: alerts never delay or alter Stripe retries.
  // Mounted before the raw-body parser so parser errors are covered as well.
  const startedAt = Date.now();
  res.once("finish", () => {
    const verified = res.locals.verifiedWebhookEvent;
    const eventType = typeof verified?.eventType === "string" && /^[a-z][a-z._]{0,79}$/.test(verified.eventType)
      ? verified.eventType : undefined;
    log({ level: res.statusCode >= 400 ? "error" : "info", ts: new Date().toISOString(),
      req: { method: "POST", path: "/api/v1/webhooks/stripe-payments" },
      res: { statusCode: res.statusCode, durationMs: Date.now() - startedAt },
      meta: { service: "bgsnl-api", environment: process.env.APP_ENV || process.env.NODE_ENV,
        source: "webhook.stripe", verified: Boolean(verified), eventType } });
    if (res.statusCode < 400) return;
    Promise.resolve().then(() => notify({ provider: "stripe", status: res.statusCode,
      ...res.locals.verifiedWebhookEvent })).catch((error) => {
      logOperationalError("webhook.stripe-alert", error);
      console.error("Developer webhook alert failed.");
    });
  });
  next();
};

export const observeWebhookErrors = createWebhookErrorObserver();
