# New event announcements and personal ticket checkout

Publishing a new event queues an announcement for every active regular member
whose `expireDate` is in the future, across all regions. Alumni accounts are not
regular memberships and are excluded. Duplicate email addresses receive one
announcement. Expiry and account status are checked again when checkout opens;
Stripe-backed membership benefits are reconciled before granting member pricing.

Both direct publication and publication of an EventDraft save
`memberAnnouncementQueuedAt` in the same write/transaction as the Event. Draft
saves and later event edits do not queue announcements. Existing events have no
marker and are never mailed retrospectively. Hidden events wait until public.

The background worker starts after MongoDB is ready and checks every minute.
The Atlas database trigger can request an immediate pass through a protected
API endpoint. It is created disabled; see the [trigger registry](triggers.md)
for deployment status, configuration and activation prerequisites.
It sends through the existing BGSNL email provider, with event title,
description, date/time in Amsterdam, location, applicable member price and two
buttons: **View event** and **Get ticket**. Active-member discounts, member
promotions and early/late-bird prices follow the existing checkout pricing.
The quoted price is the price at send time; checkout uses current prices.

## Configuration

- `EVENT_ANNOUNCEMENTS_ENABLED`: defaults to true only when
  `NODE_ENV=production`; set `true` or `false` to override.
- `EVENT_TICKET_LINK_SECRET`: optional dedicated encryption secret, at least 32
  characters. Defaults to the existing `JWT_STRING` signing secret, which must
  also have at least 32 characters. Rotating it invalidates existing email links.
- `EVENT_ANNOUNCEMENT_API_URL`: defaults to
  `https://kanatitsa.bulgariansociety.nl/api/v1`. HTTPS is required in production;
  localhost HTTP is allowed for development.
- Existing `BGSNL_EMAIL_PROVIDER` and mail-provider configuration are reused.

## Checkout

`GET /api/v1/payment/event-ticket?token=e1....` decrypts and authenticates an
AES-256-GCM token containing the member ID, event ID, current email hash and
ticket deadline. No IDs appear in the URL path or in a readable token payload.
Each link uses a fresh random 96-bit IV and a 128-bit authentication tag. HKDF
with a dedicated context derives the encryption key from the configured secret;
the token version and purpose are authenticated as additional data. Modified,
truncated, expired and old plaintext/HMAC-format links are rejected.

Encryption hides the IDs; a stolen complete link remains a usable bearer
capability until it expires or the member/event becomes ineligible. Preventing
use of a stolen link would require an additional identity check.

The endpoint does not create a login session. It builds a trusted one-ticket
request and delegates to the usual ticket controller: member pricing, ticket
image generation, the existing checkout lease, return receipts and Stripe
webhook fulfillment are reused. Stripe receives the member's email so it is
prefilled. Repeated clicks reuse the open member Checkout session; an already
purchased member ticket redirects to the account instead of charging again.

The endpoint redirects straight to Stripe with HTTP 303 and sends no response
body containing the checkout URL. Request logging omits the encrypted URL and
member data. Responses disable caching and referrers. HEAD requests do not
create checkouts. Free tickets also require Stripe Checkout confirmation, so a
mail scanner visiting the GET link cannot issue a free ticket.

Closed, sold-out, hidden, past and expired-sale events cannot start a checkout.
Events with extra form fields, mandatory add-on choices or external ticketing
links use their existing website purchase flow to collect the necessary choices.
Invalid/expired capabilities and changed or ineligible accounts are rejected.

## Email scheduling

There is no separate announcement-delivery collection. Attempts are remembered
only by the running process, and the Event retains its existing overall
completion marker. An incomplete announcement can repeat after a process
restart because individual delivery tracking has been removed. Provider
failures are reported in process logs.

## Verification

Run `node --test tests/member-event-announcements.test.js` for publication,
audience, email content, authenticated encryption, expiry, redirect, account
eligibility and real checkout-controller tests. Stripe, ticket storage and delivery are mocked;
tests send no emails, charge no cards and require no live database.

Crypto API reference: https://nodejs.org/api/crypto.html#class-cipheriv

## Already-purchased tickets

The one-click email link checks the event's fulfilled, non-refunded tickets.
Matching uses the verified member's current ID, account aliases or normalized
email, including previous purchases at guest prices. If a ticket already exists,
the link creates an ordinary guest Checkout session at the event's guest price
and redirects directly to Stripe. The member's name, email and phone populate the
guest ticket details, and Stripe receives their email. Guest fulfillment issues
the additional ticket without claiming another member discount.

If the member Checkout detects a ticket purchased after the initial check, the
link retries once as a guest Checkout. Refunded tickets do not force guest pricing.
Member-only free admission does not make an additional guest ticket free; events
that are free for everyone still use Stripe confirmation before issuing a ticket.
Membership validation, closed/sold-out events and required event choices retain
their existing checks. No duplicate-ticket error toast is shown.
