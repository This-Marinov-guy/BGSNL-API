# Subscription lifecycle and deployment

## Behaviour

- Member six-month/yearly plans and alumni tiers 1–4 use a server-owned Stripe price allowlist. The website fetches prices from the API; submitted tier, period, customer ID, account ID, roles or status never determine benefits.
- Member ↔ Alumni conversions and Alumni tier **increases** use Stripe confirmation on the **same subscription item**, with immediate invoicing of prorations and a charge warning above the website's action button. No second subscription is created. See [Stripe's portal confirmation flow](https://docs.stripe.com/customer-management/portal-deep-links).
- Member payment-period changes update the profile immediately with no charge or proration today. The existing next billing date is retained. When the interval changes, Stripe uses a paid-through `trial_end` bridge to that date with `proration_behavior: none`; Stripe reports `trialing` and can issue a zero-value invoice. Benefits remain available only through the already-paid date, and the new full period is billed at renewal. Repeated switches never extend this date. See [Stripe's billing-cycle guidance](https://docs.stripe.com/billing/subscriptions/billing-cycle#change-the-billing-period-using-a-trial-period).
- Paid Alumni tier **decreases** schedule both the lower price and lower benefits for the next billing date. The current tier stays unchanged until then. A two-phase Stripe schedule retains the existing phase's tax, coupon and payment settings, disables prorations and keeps the subscription running afterward. Webhook/status reconciliation applies the lower tier from Stripe, recovers interrupted schedule setup, and releases only our completed downgrade schedules so later changes remain possible. External schedules are never modified. While a downgrade is pending, further switches require support. Free Alumni tier 0 retains its existing cancellation-at-period-end path. See [Stripe's scheduled-downgrade guidance](https://docs.stripe.com/billing/subscriptions/subscription-schedules#changing-subscriptions).
- Payment-now warnings show a server-side Stripe invoice preview in EUR, including prorations and available credits, not the catalog price. Previewing creates no invoice/payment/session/customer. A loading skeleton and recoverable error prevent continuation until the selected plan has a valid amount; stale responses are discarded. The warning identifies the amount as an estimate because the confirmation portal recalculates prorations at confirmation time. Zero due never claims a debit. See [Stripe invoice previews](https://docs.stripe.com/api/invoices/upcoming?api-version=2024-06-20).
- Healthy cancellations take effect at period end. A delinquent account can cancel immediately through the recovery portal. Cancellation does not restore paid benefits or imply an outstanding debt has been settled.
- Tier 0 is free alumni with no paid benefits. When selected from a running subscription, the customer must confirm cancellation in Stripe; conversion happens only when that subscription actually ends.
- Member/alumni conversions use a MongoDB transaction. Profile fields, tickets, documents, applications and administrative assignments are retained. Member → Alumni retains the Member as `alumni-migrated`, without benefits or embedded sign-in credentials. Alumni → Member reuses the archived Member when available (otherwise creates one), then deletes the Alumni in the same transaction. Aliases on the current account resolve old IDs and sessions. Same-programme changes update the current record; existing active duplicates fail closed for manual reconciliation.
- Checkout completion checks both account collections before creation. It resolves an existing subscription owner first, then the saved authenticated account or Stripe customer. An email match alone cannot attach another customer's payment. New accounts are created in the Stripe plan's collection; replayed checkouts keep the existing password and profile. Pending or failed payments do not apply a paid programme switch.
- Failed/overdue payments immediately lock benefits when the signed webhook is processed, regardless of a future local expiry date or staff role. The backend independently refreshes Stripe state on benefit requests. Pending asynchronous payments do not trigger failure emails while processing.
- Login, profile editing and billing remain accessible. A billing verification outage removes access to benefits in responses without falsely marking a payment failed or lifting an administrative suspension.
- Discounts, promotion-code retrieval, internship applications, alumni quotes and member-only actions have server-side entitlement checks. JWT roles/status are replaced by current database values on authenticated requests and token refresh.
- Period dates come from Stripe, not `now + subscription.period`. Repeated and out-of-order events fetch current Stripe state under a distributed subscription lease. An old subscription's invoices cannot take over a newer subscription by matching the customer alone. See [Stripe webhook delivery considerations](https://docs.stripe.com/webhooks).
- When an abandoned pending update leaves a void invoice, access can recover only with a paid invoice line covering the exact current item, price and remaining period. An unrelated or expired historical payment never unlocks benefits. See [Stripe pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates).
- Material billing changes refresh the existing member/alumni statistics and spreadsheet queues after the account transaction commits. Repeated status checks do not enqueue exports. These reporting queues remain best-effort; billing authorization does not depend on them.

## Required production configuration

1. Deploy the API before the website. Deploying the new website alone is not compatible with the old API's subscription/status endpoints.
2. Use MongoDB Atlas or another **replica set** supporting transactions. The API requires the dedicated Redis container for checkout/session state and coordination. Financial history and regional allocations live on Stripe. Follow [storage-and-redis.md](storage-and-redis.md) for the coordinated migration.
3. Keep the existing `STRIPE_NL_SECRET_KEY` and `STRIPE_NL_WEBHOOK_CH_KEY` configured. Membership prices must exist in that Stripe account. Historical regional subscriptions are resolved by a successful subscription retrieval **and matching customer**, then their Stripe account is persisted.
4. Configure the signed endpoint `POST /api/v1/webhooks/stripe-payments?region=netherlands`. Existing unversioned `/api/webhooks/stripe-payments` requests still resolve to v1. Each distinct regional Stripe account needs its matching region and signing secret.
5. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.voided`, `invoice.marked_uncollectible`, and subscription `created`, `updated`, `deleted`, `paused`, `resumed`, `pending_update_applied`, `pending_update_expired`. The handler also safely reconciles other subscription/invoice events.
6. Set `BILLING_WORKER_ENABLED=true` on the API process and retain `MAIL_ENDPOINT`/`MAIL_TOKEN` with a verified sender for `no-reply@bulgariansociety.nl`. There is no new mail template to create. The worker also defaults on when `NODE_ENV=production`, but is off in development unless explicitly enabled. Do not enable it against production data from a local development process.
7. On first billing use, the application creates **dedicated v2** Stripe portal configurations: Payments, recovery, and switch-confirmation. Payments/recovery/cancellation sessions disable `subscription_update`; only the authenticated plan-change endpoint creates a `subscription_update_confirm` deep link with the selected price and existing subscription item. Stripe hides general navigation during this focused flow and returns to Settings afterward. Existing v1/legacy configurations are not modified or reused by new sessions. Previously issued portal links retain their old configuration until expiry. The Stripe key must permit prices, customers, subscriptions, invoices, Checkout and Billing Portal reads/required writes. Portal sessions use API version `2024-06-20` for deep links; other Stripe operations retain the existing `2022-08-01` pin.

Settings → Membership → Billing shows **Cancel**, **Switch**, and **Payments**
for a running subscription. Cancel first opens the site's confirmation modal,
then Stripe's final cancellation confirmation. Switch opens the existing Member/
Alumni plan chooser and prevents reselecting the current plan. Payments opens
the customer portal for payment methods, invoices and existing cancellation/
recovery controls, without a plan-switching option. Pending payment or plan
changes and scheduled cancellations block switching until resolved; server-side
reconciliation remains authoritative.

Once Stripe reports the subscription `canceled` (or `incomplete_expired`), Billing
instead shows **Start subscription** and **Payments** when a customer ID exists.
Customer-only accounts use the same actions; accounts without a customer only
show Start. Scheduled cancellation remains a running subscription until Stripe
actually ends it. Account loading/refresh reconciles Stripe, and a verification
failure cannot expose Start from a stale canceled snapshot. Checkout reconciles
again and checks for other running subscriptions before creating a new one.

Restart checkout passes the existing customer ID to Stripe and stays in that
customer's verified Stripe account, including region aliases using the same key.
The plan catalog uses the same account. The requested price must be available
there; failures do not silently create a replacement customer or move billing
to another account. Only genuinely new customers default to central billing.

The worker runs once per minute, sweeps a bounded batch of stale subscriptions and recovers completed Checkout sessions if their initial webhook was missed. Benefit requests also reconcile independently; webhooks are the immediate path. Multiple API processes can run the worker: leases and atomic delivery claims prevent duplicate processing.

Failed records rotate behind other accounts; reminder retries back off for five minutes and orphaned jobs are retired. A failed verification updates only the attempt timestamp, never the trusted `syncedAt` timestamp. Thus an invalid historical record cannot monopolize a batch or refresh cached benefits without verification.

## Payment emails

One email is queued when an unresolved payment failure is discovered. A second is eligible **48 hours after the first send attempt**, only if the problem still needs action. Recovery, payment processing, cancellation and webhook retries do not create extra emails. The message links to `/user#settings`; it contains no short-lived portal URL or payment secrets.

Redis reminder jobs expire 30 days after the failure episode starts, or sooner
after resolution. An expired job is not recreated for that same episode. Pending
checkout data also expires after 30 days; background retries do not renew it.

The two-email limit is per continuous delinquency episode, not per webhook or Stripe retry. Email slots are claimed durably **before** contacting Mailtrap. Because Mailtrap and Redis cannot share a delivery transaction, an ambiguous send failure is recorded and is not retried as another email. Thus there are at most two application delivery attempts; delivery is not guaranteed, and a crash/provider failure may result in fewer. The current reminder job is in Redis; resolved jobs expire after one day. Configure Stripe's own automatic payment emails deliberately if the total customer-facing email limit must also include Stripe-generated messages.

## API contracts

All endpoints below are relative to `/api/v1` and require a verified bearer token.

| Endpoint | Purpose |
| --- | --- |
| `GET /payment/subscription/plans` | Current server-approved plans/prices, including free alumni |
| `POST /payment/subscription/change` | `{ itemId, origin_url }`; returns a Stripe review/checkout URL, `{ updated: true }` for an applied Member period change or scheduled Alumni downgrade, or the account URL for a free conversion |
| `POST /payment/subscription/preview` | Authenticated `{ itemId, origin_url }`; returns `{ quote: { priceId, amountDue, currency, chargeNow } }` with amount in cents; no payment/session creation |
| `POST /payment/subscription/customer-portal` | `{ url, action?: "cancel" | "payment_method" }`; customer and configuration are chosen on the server |
| `GET /user/get-subscription-status` | Fresh status, benefits, tier, billing state and cancellation flags |
| `GET /user/current` | Safe profile plus entitlements; locked responses omit ticket collection/campaign benefits |
| `GET /user/promotions` | Promotion codes only after a current benefit check |

The former `POST /payment/subscription/general` delegates to the new change flow for old clients. `DELETE /user/cancel-membership` now returns a portal URL: clients must redirect for the customer to confirm cancellation. Public signup still uses its existing validated endpoint, but stores a hashed registration draft on the server; passwords and client-controlled entitlement metadata are not sent to Stripe.

## Verification before production

Run `npm run test:subscriptions` and `node --test tests/*.test.js`. Unit/service tests use deterministic Stripe and database doubles, not production subscriptions. They cover locking, stale tokens, exact ownership, reordered events, period/tier changes, migration preservation, lease contention, cancellation, payment processing and email limits. The website production build is a separate check.

For a real end-to-end check use an isolated database, Stripe **test-mode** key/signing secret and test mail destination. Existing production price IDs will not exist in test mode. Supply equivalent recurring EUR test prices through:

```text
STRIPE_MEMBERSHIP_6M_PRICE_ID
STRIPE_MEMBERSHIP_12M_PRICE_ID
STRIPE_ALUMNI_TIER_1_PRICE_ID
STRIPE_ALUMNI_TIER_2_PRICE_ID
STRIPE_ALUMNI_TIER_3_PRICE_ID
STRIPE_ALUMNI_TIER_4_PRICE_ID
```

Do not override production price IDs to repurpose an existing product. In test mode, create prices with the same intervals as the plans: six months, one year, and monthly alumni tiers. The existing configured prices remain the defaults when overrides are absent.

Before rollout, verify in Stripe test mode: member → alumni → member, both member periods, all alumni tiers, free-tier cancellation at period end, failed renewal, card update plus successful invoice payment, cancellation while delinquent, 3-D Secure/processing payments, replayed/out-of-order events, abandoned/repeated checkout and API restarts between email attempts. Check there is only one non-ended subscription per account and that MongoDB transactions roll back on failure. **No live subscriptions should be modified for this verification.**

## Boundaries and operational notes

- Existing accounts with conflicting active records/subscriptions require manual reconciliation. The code never silently cancels a second subscription or chooses a different customer.
- An archived profile is not an active member. Exports and active-member counts exclude the archived status.
- Public hall-of-fame pages may retain their normal frontend cache briefly after a status change. Private benefit endpoints do not use those public caches.
- Previously downloaded tickets/files, copied promotion codes and existing external chat/group access cannot be recalled by a website check. Promotion codes have been removed from new public frontend bundles, but previously public codes should be rotated with partners. Enforcing redemption or removing external group members requires the relevant provider integration; this change does not claim to do that.
- The raw checkout/webhook handler no longer logs or reflects Stripe metadata containing old registration data. Existing historic logs/Stripe metadata are not deleted by this change.

## Regional Member revenue

New Member subscriptions can allocate 80% less attributable Stripe fees to their
configured regional Connect account. New Member and Alumni customers use the
central account; subscription restarts retain the existing customer's verified
Stripe account. See [member-revenue-sharing.md](member-revenue-sharing.md) for
eligibility, renewals, fee recovery, configuration and review limits.
