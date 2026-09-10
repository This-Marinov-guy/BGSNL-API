# Account billing alerts

`GET /api/v1/payment/subscription/billing-details` requires the existing account
authentication middleware, including for locked accounts. It accepts no account,
customer or subscription ID from the caller: those come from `req.account`.
Responses are private/no-store. Deploy the API and frontend together.

This is a read-only diagnostic check, not a payment retry or entitlement update.
It verifies the stored Stripe subscription/customer ownership and applies the
existing subscription policy. Older unpaid invoices are considered even when
the latest invoice is paid. Supported reasons include missing membership linkage,
failed/pending payments, ended/paused subscriptions and unsupported plans.

Only safe, curated payment-error descriptions and the outstanding amount/currency
are returned. Raw Stripe errors, fraud/lost/stolen-card reasons, card details,
client secrets and customer objects are not exposed. An API/Stripe error must
show verification unavailable, never invent a failed payment or missing membership.
A paid subscription awaiting account refresh does not invite another checkout.

The account page shares one background request between its main alert and the
Settings membership/billing panel. Healthy accounts and administrative restrictions
do not request billing diagnostics. A changed account/billing snapshot invalidates
the result; outdated responses are ignored. Checks have a 15-second UI deadline
and an explicit retry action. They never activate the global page loader.

Both surfaces use the same billing-action component: Start subscription,
Manage billing, or Contact support as appropriate. Wherever Manage billing is
shown, Cancel subscription also appears if a valid subscription ID exists
(independent of the account's `isSubscribed` flag). It opens the shared
confirmation modal; Continue to Stripe requests the existing portal cancellation
flow, where Stripe performs final review and confirmation. Keeping the subscription
or dismissing the modal sends no cancellation request. Skeletons replace details while loading; alerts
animate on appearance, replacement and removal, respecting reduced motion.
The event/ticket banners and their links are unchanged.

Tests (no real payment or account changes):

```sh
# API
node --test tests/subscription-*.test.js
# Website
node --test scripts/billing-alert.test.mjs scripts/account-status-notice.test.mjs scripts/subscription-checkout.test.mjs
```
