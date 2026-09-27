# Developer webhook alerts

Developer group: `vladislavmarinov3142@gmail.com`. It is separate from the general internal-notification recipients and enabled by default. Override with `DEVELOPER_NOTIFICATION_SUBSCRIBERS` (comma-separated); disable with `DEVELOPER_NOTIFICATIONS_ENABLED=false`.

The Stripe webhook route alerts on completed HTTP 4xx/5xx responses, including invalid signatures, unknown Stripe accounts, raw-body parsing failures, and processing errors. Successful deliveries, including successfully handled payment-failed business events, do not alert. Verified Stripe event ID/type and live/test mode are included when available. Raw payloads, query strings, signatures, exception messages and personal payment data are never included.

Delivery uses the existing internal email queue/provider. Alerts are enqueued after the response completes, so notification failures do not alter webhook status or retry behavior. The queue is in-memory, not a durable outbox; process crashes or provider failures can lose alerts. A request that never completes cannot trigger this response observer.

Duplicate event/status alerts are suppressed for 15 minutes. Unverified requests share a status-level bucket. A server-wide cap limits alerts to 20 per 15 minutes. Limits are per process and reset on restart; multiple replicas can each send an alert. Inspect logs/Stripe delivery history for full incident scope.

No test email has been sent and this change has not been deployed. Tests use mock delivery. Configure the existing email provider for the running environment before relying on inbox delivery.
