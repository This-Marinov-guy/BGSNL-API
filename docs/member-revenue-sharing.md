# Regional Member subscription revenue

Member and Alumni subscriptions, customers, products, prices, invoices and
payment methods stay on central BGSNL Stripe account `acct_1QLOPaAShinXgMFZ`.
Regions receive separate Connect transfers. The existing central billing portal
continues to handle Member/Alumni switches, renewals and cancellation.

Status: deployed and enabled for new Member Checkouts in production. Five
existing Member subscriptions were enrolled in a prospective pilot on
2026-10-08; see [the migration plan](existing-member-connect-migration-plan.md).

## Allocation

New Member Checkout operations created while sharing is enabled receive a
version 1 allocation. Their server-stored region determines the recipient. An
in-flight Checkout keeps its original allocation on retries, even if the
feature flag or profile region changes. Existing subscriptions are enrolled
only through the separately approved version 2 migration runner, with sharing
starting at the next billing period. The ordinary worker does not enrol them.
Alumni signups and unmatched regions retain their current central billing.

| Profile region | Connected account |
| --- | --- |
| `amsterdam` | `acct_1UDN8vAsNA3SVv1m` |
| `groningen` | `acct_1UDNdQPLbBQEXyV6` |
| `leeuwarden` | `acct_1UDNAJPRZxbCvsET` |
| `leiden_hague` | `acct_1UDNCEAgrqHPcNaG` |
| `rotterdam` | `acct_1UDNCjPNvWZqP4Cu` |

These five named accounts were checked through the central Stripe API: transfers
were active and payouts enabled. Three other accounts were unnamed/inactive and
are not mapped. Routes live in `util/config/member-revenue.js`. Preserve account
IDs referenced by existing allocations when adding future routes.

The version 1 subscription allocation applies to the first paid Member invoice
and every future paid Member renewal. Version 2 allocations begin with the
next eligible service period after enrolment. Both survive account migration, Checkout
reservation reuse and changes to the member's profile region. Alumni invoices
produce no regional transfer. If the same enrolled subscription later returns
to a Member plan, its original region allocation resumes. An Alumni-origin or
historical subscription switched through the portal is not a new subscription
and is not automatically enrolled.

## Fees and amounts

For a normal paid invoice:

```text
central retained share = round(collected amount × 20%)
regional transfer = collected amount − central retained share − actual Stripe fee
```

All calculations use integer euro cents. For a €10 payment with €0.40 in payment
fees, the region gets €7.60 and central keeps €2.00. This is 20% of the gross
payment, with the entire fee charged against the region's share.

Stripe initially charges the **platform**, as required by its
[separate charges and transfers model](https://docs.stripe.com/connect/separate-charges-and-transfers).
The application recovers that cost through the reduced transfer; it does not
change Stripe's fee payer. A payment's expanded balance transaction supplies its
actual fee. Missing fee data postpones the transfer without delaying membership
activation. No estimated card fee is used.

Separately reported fees are reconciled from Stripe's
[monthly itemized Fees report](https://docs.stripe.com/reports/report-types/fees)
(`all_fees.balance_transaction_created.itemized.2`). The worker waits for a
complete UTC month plus at least 96 hours and Stripe's data-availability cutoff.
It also waits for relevant enrolled subscriptions to complete their recovery
sweep. Report availability was verified with the central account's API.

Invoice/charge fees are matched to enrolled payments. Refund, dispute and
transfer references are resolved to their original charge. Fees explicitly
attributed to a configured regional account are regional overhead. Processing
fees already present in the payment balance transaction are not deducted twice.
Tax included in the report amount is not added again. Decimal report amounts
are summed before rounding to cents; each immutable monthly total replaces its
previous value on retry.

This recovers **attributable** fees. Unattributed overhead, unsupported settlement
methods (including Stripe fee credits), and unresolved references are flagged
for review. They are not guessed or split arbitrarily. Consequently, central
may temporarily bear fees pending reporting/recovery; an unconditional promise
of zero fees at every instant would be incorrect. Fees that the connected
account pays directly are not charged again through the central ledger.

## Refunds, disputes and plan switches

Refunds reduce the amount eligible for regional revenue. Open/lost disputes
reduce it by the disputed amount; won disputes restore it. Previously issued
transfers are reversed when the target decreases. Fees retained after a full
refund are recovered from that same region's other allocations.

A paid plan-change invoice that references a credit to an earlier Member
invoice reduces that earlier allocation, including on a Member-to-Alumni
switch. On a paid Member-to-Member change, the carried Member credit is included
in the new allocation so it is not deducted twice. The customer continues to
use the existing central billing portal.

Mixed Member/Alumni charges, credits without a verifiable original Member
invoice, zero-cash Member changes funded by carried credits, out-of-band
payments and mismatched ownership/currency are held for manual review. This
holds transfer accounting; the existing account/entitlement flow still runs.
Manual invoice credit notes or customer-balance adjustments outside the normal
portal invoice flow also require accounting review.

Reversals happen before new transfers for a region. An insufficient regional
balance leaves a durable retry and stops further transfers for that region.
Unrecovered debt is logged and remains owed by that region. Another region's
money is never used to cover it. Bank payouts follow each connected account's
Stripe payout schedule; this integration creates Connect transfers, not bank
payouts.

## Worker and records

The billing worker runs coordinated revenue maintenance every 15 minutes, with
independent backoff on failure so it cannot block membership recovery. It paginates
Stripe subscriptions and paid invoices, reconstructs calculations in memory,
reuses Stripe's complete monthly fee reports, and settles each region. No Mongo
invoice statements, billing receipts or enrollment ledger are retained.

- The original allocation is stored in the Stripe subscription's
  `bgsnlRevenueAllocation` metadata, including customer, region and operation.
  A later Member/Alumni switch does not remove the original allocation history.
- Refunds, disputes, credits and processing fees are read from Stripe each pass.
- Pending money operations live in `bgsnlPendingRevenueOperation` on the Stripe
  invoice. Stable operation IDs and transfer-group searches recover ambiguous
  responses even after the idempotency retention window. Superseded instructions
  are checked against the current transferred/reversed amount before submission.
- Redis leases serialize the coordinator and regional settlement. Redis does
  not hold a permanent financial ledger. Missing or incomplete Stripe reports
  postpone settlement instead of treating unknown fees as zero.

The existing signed central webhook registers eligible subscriptions; it never
moves money directly. `invoice.paid`, `customer.subscription.updated` and
Checkout completion are already enabled on the central BGSNL endpoint. Checkout
completion also registers allocations, and the worker recovers missed invoice
notifications. Refund/dispute changes are refreshed during the sweep.

This is an API billing worker, not a MongoDB database trigger. The separately
created Atlas event-announcement trigger remains disabled.

## Configuration and rollout

```dotenv
# Existing central Stripe credentials remain the billing credentials.
MEMBER_REVENUE_SHARING_ENABLED=true
# Live is the default; the worker verifies the actual Stripe balance mode.
MEMBER_REVENUE_SHARING_LIVEMODE=true
# Already on by default in production; explicitly false stops the worker.
BILLING_WORKER_ENABLED=true
```

Before enabling sharing in another environment, exercise the full flow in an isolated
database with central Stripe test keys, equivalent test prices and connected
test recipients. Set `MEMBER_REVENUE_SHARING_LIVEMODE=false` for that environment.
Verify first payment, renewal, Alumni switch, refund, failed reversal and report
reconciliation. Keep test and production databases separate.

Set `MEMBER_REVENUE_MIGRATED_ENABLED=false` to pause only the version 2 migrated
cohort while version 1 Checkout sharing continues. Disabling sharing pauses new
enrolment and all reconciliation/transfers; it
does not delete existing allocations. Re-enabling resumes those subscriptions'
eligible invoices. This code does not alter any existing region Stripe keys or
move historical subscriptions between accounts.

Run deterministic checks without live credentials or payment operations:

```bash
STRIPE_NL_SECRET_KEY=sk_test_unit STRIPE_GRO_SECRET_KEY=sk_test_unit \
  node --test tests/subscription-*.test.js tests/payment-return.test.js
```

Monitor `reviewReason`, pending `operation`, monthly `unattributedRows`, and
logs for postponed settlement or unrecovered fees. Inspect the saved Stripe
report and invoice before applying any manual accounting correction.

## `subscription.connected`

Every account subscription stores a boolean `connected`, defaulting to `false`.
It is `true` only for a Member account whose current Member subscription has a
verified durable Connect allocation matching its subscription and customer IDs.
Existing unsplit subscriptions and unmatched regions stay `false`; all Alumni
subscriptions are `false`, including legacy Alumni copies pending migration. Checkout completion
and each reconciliation refresh the flag. Member-to-Alumni conversion clears
it; returning to Member on the same enrolled subscription restores it.

This marks enrolment in the split, not a successful bank payout. Pausing the
revenue worker does not erase enrolment. The flag is informational; transfers
continue to use the original Stripe subscription allocation as their authority.

Backfill account flags explicitly (Stripe is read-only; changes apply only to account fields):

```bash
node scripts/backfill-subscription-connected.js
node scripts/backfill-subscription-connected.js --apply --backup=/private/tmp/bgsnl-connected-backup.json
```

The first command previews counts. Apply creates an exclusive, private backup
before updating only the flag (or initializing a missing/null subscription).
Exact subscription snapshot filters protect concurrent billing changes;
conflicts are reported for a fresh retry with a new backup path.
