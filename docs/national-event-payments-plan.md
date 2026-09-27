# National customers and regional event payments

Status: proposed, not implemented or approved for production rollout.
Recorded: 2026-09-27.

## Objective

Use the logged-in account's national Stripe customer for event purchases, keep
those payments associated with that customer, and distribute proceeds to the
event's region. Do not create regional customers for this flow.

- Connected region: charge nationally, then transfer the region's entitlement.
- Region without Connect: charge nationally and retain the funds nationally.
- Store payment methods in Stripe, never raw card details in BGSNL.
- Preserve ticket issuance, admission tracking, and membership eligibility.

The user confirmed that regional Connect connections exist and that regions
without Connect use the national account. Verify actual account capabilities and
test/live configuration before rollout.

## Selected direction

Use **separate charges and transfers**, rather than automatically transferring
the full amount with a destination charge at checkout. This lets the backend
read the actual processing fee before calculating the regional entitlement.

1. Resolve the authenticated purchaser and their national Stripe customer.
2. Create Checkout on the national Stripe account.
3. Fulfil the purchase after verified successful payment, independently of payout.
4. A retryable worker retrieves the charge's balance transaction and actual fee.
5. Transfer the eligible amount to the configured regional connected account.
6. Stripe pays out the regional balance to its bank under its payout schedule.

A Stripe-to-Stripe transfer is not a bank payout. Neither step charges the
customer a second time. Do not transfer for a merely completed Checkout session
if an asynchronous payment is still pending.

Proposed normal-sale calculation, subject to the fee decision below:

`regional entitlement = gross event payment - actual payment processing fee`

There is no proposed 20% national event share. Refunds, disputes, credits, and
later fee adjustments require reconciliation; the formula above is not a full
lifecycle accounting rule.

## Fee verification: required before implementation

The code does not establish the commercial fees Stripe actually bills BGSNL.
Inspect the national account's Connect pricing agreement and actual fee reports
or invoices before claiming that transfers are free or that there are two fees.

- The national charge incurs payment processing fees.
- Connect account, routing, and bank-payout fees may also apply depending on the
  account configuration and pricing agreement.
- Payment balance-transaction fees do not necessarily include separately billed
  monthly Connect costs.
- Do not add together pricing-table entries without confirming the applicable
  pricing model and whether entries describe the same charge.
- Decide whether national absorbs separate Connect costs or allocates them to
  regions. Monthly costs cannot necessarily be attributed exactly at checkout.
- Define responsibility for non-refundable fees, refunds, disputes, negative
  regional balances, and transfer reversals.

Existing membership logic already uses national charges and regional transfers
for eligible allocations. Its normal calculation retains 20% nationally and
deducts recorded processing fees from the regional entitlement. That 20% is a
BGSNL allocation, not a Stripe fee. Alumni plans are excluded from new regional
revenue allocations. Preserve both behaviours; do not reuse membership payout
rules unchanged for event sales.

## Backend changes

### Customer and checkout ownership

- Resolve customer ownership on the server, never from a client-supplied customer
  ID or an email match alone.
- Reuse a verified national customer; create one idempotently if absent.
- Keep the billing customer independent of active subscription eligibility, so
  alumni and accounts without an active membership can buy at the correct price.
- Keep purchaser identity separate from attendee identity and ticket-price type.
  Buying a guest-priced ticket must not lose the logged-in purchaser association.
- Offer explicit consent to save eligible payment methods for future Checkout
  purchases. Existing subscription payment methods are not automatically eligible
  for redisplay; verify the pinned SDK/API support before adding parameters.

### Account routing and prices

- Create new event Checkout sessions with national credentials.
- Reuse the region-to-Connect-account mapping, separating common destinations
  from membership-specific policy and feature flags.
- Only intentionally unconnected regions retain proceeds nationally. A broken or
  disabled configured destination must raise an operational issue, not silently
  become a national-only sale.
- Regional Stripe Product/Price IDs cannot be passed into national Checkout.
  Choose national catalog prices or server-generated `price_data` using validated
  event pricing. Cover add-ons and existing early/late pricing rules.
- Separate `eventRegion` from the Stripe account owning the payment. Update
  payment-return lookups, receipt/refund actions, webhook processing, and logs.

### Fulfilment and transfers

- Process new payments through the national webhook with signature verification.
- Preserve idempotent ticket fulfilment and account ownership checks.
- Queue transfers independently; ticket delivery must not wait for fund settlement.
- Verify fee availability, currency, payment success, destination, and Stripe mode.
- Persist/recover transfer instructions and reconcile actual Stripe transfers to
  prevent duplicate payouts across retries and expired idempotency-key windows.
- Associate each transfer with its originating charge where supported, retaining
  stable purchase/transfer-group references for reconciliation.
- Recover from missing fees, unavailable balances, worker crashes, and disabled
  destinations; notify developers when intervention is needed.
- Implement partial/full refunds and appropriate transfer reversals explicitly.
  Refunding a separate charge must not be assumed to reverse its transfer.

## Database and billing history

### National billing reference

Add a billing reference independent of `subscription`, using shared member/alumni
fields or a dedicated identity mapping. Logical fields:

```text
account identity
national customer ID
Stripe platform account ID
test/live mode
```

The final schema must preserve separate test/live mappings and account aliases
across member/alumni transitions. Do not overwrite legacy regional subscription
customer IDs. Backfill only verified national references; create missing ones
lazily and with concurrency protection.

### Purchase references

Record the distinction between event region and payment owner, along with the
customer, Checkout session, PaymentIntent, and optional transfer destination.
Snapshot the destination/policy at purchase time so later configuration edits do
not redirect historical entitlements.

### Choose the history surface before adding a ledger

**Stripe portal only:** associate purchases with the national customer and
evaluate paid one-time invoice generation if they must appear in invoice history.
Attaching a customer does not by itself create an invoice. Verify invoicing fees
before enabling it. A permanent local payment-history collection is optional.

**History inside BGSNL:** add a permanent payment projection, one row per purchase
(not per individual ticket), containing:

- Account identity, event, region, quantity, and purchase description.
- Amount in integer minor units and currency.
- Stripe account/mode, customer, Checkout session, PaymentIntent, and charge IDs.
- Payment/refund state, refunded amount, receipt/invoice references, timestamps.
- Transfer references and reconciliation state where needed.

Update via verified webhooks and reconciliation with unique payment keys. Stripe
remains authoritative. Account-history queries must enforce ownership and aliases.
The existing Redis `BillingRecord` and `PaymentReturn` stores expire and must not
serve as permanent billing history. Never store card numbers or CVCs.

## Scope and compatibility

- Promo-code redesign and email one-click checkout enhancements are deferred at
  the user's request. Audit shared call sites nonetheless: existing promo logic
  can replace the Checkout customer with a temporary customer. Explicitly decide
  how legacy paths are isolated or adapted before enabling national checkout;
  do not silently override the intended customer or remove existing discounts.
- Do not expose saved payment methods through an unauthenticated email capability
  as an accidental consequence of changing the shared checkout handler.
- Keep historical regional payments, subscriptions, and tickets unchanged.
- Continue handling old regional webhooks and already-open regional Checkouts.
- Existing regional payments do not automatically migrate into national Stripe
  customer history. Historical aggregation is a separate optional project.
- Leave membership's 20% allocation and alumni's national-only policy unchanged.

## Relevant existing code

- `controllers/payments-controllers.js`: ticket pricing and Checkout creation.
- `services/tickets/event-promo-codes.js`: customer-replacing promo preparation.
- `controllers/member-event-checkout-controller.js`: email checkout shared path.
- `util/config/stripe.js`: regional/national Stripe clients.
- `util/config/member-revenue.js`: existing Connect destinations and member rules.
- `services/subscriptions/revenue-sharing.js`: transfer/reversal recovery patterns.
- `services/subscriptions/revenue-fees.js`: existing fee reconciliation support.
- `controllers/Webhooks/stripe-wh-controllers.js`: verified payment fulfilment.
- `services/payments/payment-return.js`: payment owner lookup and return flow.
- `services/main-services/stripe-webhook-service.js`: ticket persistence.
- `models/SubscriptionFields.js`: shared account and subscription fields.
- `services/subscriptions/checkout.js`: customer portal and membership Checkout.

## Implementation and rollout checklist

- [ ] Confirm actual Connect fees, capabilities, destinations, and platform identity.
- [ ] Decide separate fee allocation, refund/dispute policy, and billing-history UI.
- [ ] Choose a national price strategy and isolate legacy/email/promo paths.
- [ ] Add verified national-customer mapping and safe backfill.
- [ ] Implement national event checkout behind a dedicated feature flag.
- [ ] Update payment ownership, fulfilment, and return/receipt/refund lookups.
- [ ] Implement retry-safe transfer and adjustment reconciliation.
- [ ] Implement the selected history/invoicing option.
- [ ] Test connected/unconnected regions, member/alumni/guest-priced purchases,
      add-ons, zero-value orders, async payments, and failed payments.
- [ ] Test webhook replays, concurrent requests, worker crashes, delayed fees,
      insufficient balances, partial refunds, disputes, and account transitions.
- [ ] Confirm test/live isolation and compatibility with pre-rollout Checkouts.
- [ ] Reconcile a sandbox purchase from customer through fee, transfer, and history.
- [ ] Obtain explicit production rollout authorization; monitor initial transfers.

## Stripe references

Re-check current documentation and BGSNL's actual pricing at implementation time.

- [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)
- [Destination charges: alternative, not the selected exact-fee approach](https://docs.stripe.com/connect/destination-charges)
- [Netherlands Connect pricing](https://stripe.com/nl/connect/pricing)
- [Saving payment methods in Checkout](https://docs.stripe.com/payments/checkout/save-during-payment?payment-ui=stripe-hosted)
- [Receipts and paid invoices](https://docs.stripe.com/receipts)
