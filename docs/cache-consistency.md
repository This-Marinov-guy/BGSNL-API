# Repeated reads and freshness

Authenticated API requests still load the current account from MongoDB and
validate its session version. Full profiles, credentials, connected identities,
and benefit authorization are not stored in a browser or Redis response cache.
The account page refreshes while visible and after successful account changes;
private HTTP responses remain `private, no-store`.

| Read | Reuse | Freshness boundary |
| --- | --- | --- |
| Current account and subscription display | The DB subscription snapshot for at most 30 seconds after `syncedAt` | `fresh=1`, a passed period/cancellation boundary, or a pending update always reconciles with Stripe. |
| Membership benefit authorization, checkout, plan changes | None | These paths use live Stripe reconciliation and current MongoDB account/session state. |
| Stripe plan catalogue shown to members | Redis for 15 minutes, keyed by Stripe region and configured price IDs | The checkout and quote paths still retrieve and validate current Stripe prices. |
| Public event descriptions | Next.js for five minutes | Event writes request signed immediate revalidation; ticket availability, sale flags and prices use an uncached read. |
| Public event lists | Next.js for one minute | Event writes request signed immediate revalidation. |

## Subscription and credential changes

- **New account, reactivation, renewal:** checkout fulfillment persists the
  account and reconciles before the payment result reports it ready. The next
  account read uses the new DB record; a billing return forces Stripe.
- **Plan change:** immediate changes reconcile before `updated: true` is sent.
  A scheduled downgrade correctly keeps the current tier until renewal and
  shows the scheduled change separately. If a membership change moves the
  account to another region, the next account read refreshes the signed region
  claim before it reaches a protected handler.
- **Cancellation or change in Stripe's portal:** the portal returns through
  `/user?billing=return`; that first account read forces Stripe even if the DB
  snapshot was just synchronized. Stripe webhooks also reconcile from the
  current Stripe resource instead of relying on webhook order.
- **Automatic renewal or an external Stripe edit:** until the webhook commits,
  a display read may use a snapshot for up to 30 seconds. The account page
  refreshes on focus and every 60 seconds while visible. Membership actions
  still verify live benefits. A lost webhook remains an operational risk and
  must be monitored; the display freshness limit is the fallback.
- **Email/password changes:** confirmation increments `sessionVersion`; every
  authenticated request checks the current version. The website replaces the
  current browser session only when authorized and other sessions expire.
- **Google/passkey changes:** the account and credential stores are read live.
  Removing a method increments `sessionVersion`; registration/linking updates
  identity state transactionally. No credential data enters the display cache.

The account change browser signal only prompts a new read; it does not carry
account data. Failure to refresh leaves the existing visible account and the
normal retry path; it never changes authorization. A Redis outage falls back to
Stripe for the plan catalogue. Event revalidation failures fall back to the
bounded Next.js lifetimes above.
