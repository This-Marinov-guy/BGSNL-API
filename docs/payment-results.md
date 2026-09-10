# Protected payment results

Deploy **BGSNL-API and BGSNL together**. No new Stripe products, invoice-generation
fees, provider accounts or secrets are required. The frontend uses its existing
API URL and `BGSNL_SERVER_KEY` configuration. MongoDB creates the `paymentreturns`
collection and its expiry index at API startup.

## Flow

1. Checkout creation reserves a random 256-bit return token. Only its SHA-256
   hash is stored in the receipt collection, alongside the server-selected
   Stripe region and the exact Checkout Session ID. Subscription checkout keeps
   its token in the existing private billing operation to preserve idempotency.
2. Stripe's success and cancellation URLs both use `/payment/return?token=…`.
   The destination is determined from Stripe, never from a client success flag.
3. The Next.js return handler strips the token and Stripe parameters from the
   address bar before rendering app HTML/analytics, and stores the token in a
   Secure (production), HttpOnly, SameSite=Lax cookie. Separate receipt cookies
   support multiple checkout tabs without overwriting each other.
4. `/success`, `/fail` and `/payment/pending` require the matching cookie and
   a fresh server-to-server `POST /api/v1/payment/result` lookup. The API checks
   expiry, stored session ID, Stripe metadata binding and current payment state.
   No cookie, unknown token, or expired receipt means no confirmation access.
5. Free ticket fulfilment issues an equivalent server-confirmed receipt after
   the ticket handler succeeds. Merely navigating to `/success` cannot confirm it.

These are **private bearer receipt links**, not account logins. Anyone with the
original secret return link can view that receipt until it expires (seven days).
Keep reverse-proxy/CDN access logs from retaining the `token` query parameter on
`/payment/return`. Payment API request/response bodies are excluded from Axiom
logging. Receipt pages/documents are no-store and noindex; no token, Stripe
document URL, raw customer object or checkout metadata is passed to React props.

## Payment state, retries and documents

- Completed + paid/no-payment-required: confirmation, line items, total, currency,
  date and reference. This does not grant account benefits or fulfil an order.
- Paid success pages also show the Stripe charge ID as **Transaction ID**; failed,
  cancelled and expired pages show the **Payment Intent ID** when one exists.
  These IDs come from the verified intent (the invoice's intent for subscriptions),
  never query parameters. Free bookings have no transaction ID; leaving checkout
  before Stripe creates an intent has no Payment Intent ID. Only the IDs, not
  client secrets or raw Stripe objects, are passed to the frontend.
- Open/unpaid: incomplete/cancelled; a Stripe payment error gets failure wording.
- Processing, authorised but not captured, or complete/unpaid without a failure:
  pending, with bounded refresh. Never offer another checkout while processing.
- Expired: restart from the server-selected original event/signup/settings page.
- Retry re-reads Stripe at click time and resumes only the same open session.
  If another tab already completed it, return to confirmation instead.
- Invoice download is available only for an existing paid Stripe invoice. The
  server revalidates access and streams a PDF attachment, following only a bounded
  allowlist of Stripe HTTPS redirects. Otherwise offer the existing Stripe receipt.
  **No `invoice_creation` option is enabled and no invoice is created on demand.**
- Missing documents offer a refresh; download failures return with a toast.
- Stripe/API outages show a neutral verification-recovery screen, not “failed”
  or “not charged”. Webhooks remain the authority for fulfilment/entitlements.

The legacy Stripe donation intent endpoint also returns a protected `returnUrl`;
any consumer must pass that URL to `CheckoutForm`. The currently visible donation
widget uses GoFundMe and is unchanged.

## Existing sessions and verification

Already-open Stripe checkouts created before this deployment retain their old
return URLs. They still fulfil through webhooks/email, but cannot open a protected
confirmation without the new return context. Do not expire or recreate these live
sessions during deployment just to change their return URLs.

Tests (isolated doubles, no live charges, refunds or account writes):

```sh
# BGSNL-API
node --test tests/payment-return.test.js tests/subscription-*.test.js tests/member-ticket-*.test.js

# BGSNL
node --experimental-vm-modules --test scripts/payment-return.test.mjs
npm run build
```

The frontend's existing development-only allowlist includes
`/dev/payment-result` for visual fixtures; production builds do not allow it.
Before production release, complete and cancel a **Stripe test-mode** checkout
with the intended domain/region, then verify the receipt/invoice for that session.
Do not use a live payment for a smoke test.
