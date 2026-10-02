# New event announcements and personal ticket checkout

Publishing a new event queues an announcement for active regular members in the
host region and its configured nearby regions whose `expireDate` is in the
future. Active VIP members in that same audience are eligible without a future
expiry date. Alumni accounts are excluded. Duplicate email addresses receive one
announcement. Expiry and account status are checked again when checkout opens;
Stripe-backed membership benefits are reconciled before granting member pricing.

## Regional audience

The single source of truth is
[`NEARBY_REGIONS`](../util/config/nearby-regions.js). The worker filters the
Member query by `event.region` plus its immediate neighbours, and checks each
returned member's region before sending. VIP/staff roles do not bypass this
geographic restriction. It never expands through neighbours of neighbours.

| Host region (always included) | Additional recipient regions |
| --- | --- |
| Amsterdam | Rotterdam, Leiden–The Hague |
| Breda–Tilburg | Eindhoven, Rotterdam, Leiden–The Hague |
| Eindhoven | Breda–Tilburg |
| Groningen | Leeuwarden |
| Leeuwarden | Groningen |
| Maastricht | None |
| Rotterdam | Amsterdam, Breda–Tilburg, Leiden–The Hague |
| Leiden–The Hague | Amsterdam, Breda–Tilburg, Rotterdam |

Policy reviewed 1 October 2026: normal station-to-station train journeys strictly
under 60 minutes, not door-to-door travel or a live journey-planner check. For
combined regions, a qualifying connection involving **either city** is enough
(explicitly confirmed). Amsterdam Zuid qualifies as an Amsterdam station.
Fast services that require a supplement can qualify. This is a maintained
audience map, not a guarantee for every departure, venue or member address.

Route references used to select the links:

- [NS Intercity direct](https://www.ns.nl/reizen/treinen/intercity-direct):
  Amsterdam Zuid–Rotterdam under 40 minutes.
- [NS Amsterdam Zuid–Leiden](https://www.ns.nl/trajecten/amsterdam-zuid-naar-leiden):
  26 minutes.
- [NS Den Haag–Breda route announcement](https://nieuws.ns.nl/maandag-start-tests-met-nieuwe-intercity--den-haag---eindhoven/):
  49 minutes via Rotterdam; both Rotterdam legs are shorter parts of that route.
  This is an older operator reference, so recheck it when reviewing timetables.
- [NS Tilburg–Eindhoven](https://www.ns.nl/en/routes/tilburg-to-eindhoven):
  26 minutes.
- [Arriva Leeuwarden–Groningen](https://www.arriva.nl/kaartjes-abonnementen/acties-uitjes/noord/leeuwarden-groningen/):
  35–47 minutes.

Borderline/unverified sub-hour links such as Amsterdam–Breda and
Rotterdam–Eindhoven are not included. Maastricht currently has no qualifying
neighbour among the configured regions. Revisit the map when timetables or
supported regions change; do not round a 60-minute journey down.

Missing/unknown event regions (including `netherlands`, which is not a local
event region) leave the announcement pending and emit an operational error,
rather than falling back to all members. Members with missing/unknown profile
regions do not receive regional announcements. Correct the data before retrying.
Completed announcements are not reopened or resent by this change.

Verification: `node --test tests/nearby-regions.test.js tests/member-event-announcements.test.js`.

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
prefilled. For paid events, repeated clicks reuse the open member Checkout
session; an already purchased ticket uses guest checkout for an additional
ticket. One-click free links instead return success for an existing ticket.

The endpoint redirects straight to Stripe with HTTP 303 and sends no response
body containing the checkout URL. Request logging omits the encrypted URL and
member data. Responses disable caching and referrers. HEAD requests do not
create checkouts. Free-event and member-free email links with no ticket choices
issue the ticket immediately on a verified GET, then redirect to the signed
success page without confirmation or payment checkout. Repeated links and
concurrent claims never create an additional guest ticket: when an existing
ticket is verified, the user is redirected to success instead.

**Intentional one-click tradeoff (1 October 2026):** email scanners following
GET can also redeem the ticket and cause its normal ticket email to be sent.
HEAD requests remain inert, but GET cannot reliably distinguish a human click
from a scanner. This behavior follows the explicit one-click requirement.

Events with choices still use the existing preferences page. A zero-total
booking there uses **Get free ticket**; selected paid add-ons require payment.
If an immediate free action becomes paid or gains options before fulfillment,
it fails for review instead of silently opening a payment session.
The server validates the current price/options and membership, and atomically
checks the free seat claim against capacity, sale state and duplicate tickets.
Concurrent confirmations do not silently create additional guest tickets.

Closed, sold-out, hidden, past and expired-sale events cannot start a checkout.
Events with any extra form fields or enabled add-ons (including optional add-ons)
open the dedicated email-ticket preferences page first. External ticketing links
continue to use the existing website purchase flow.
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


## Email-ticket preferences

The email GET endpoint checks the current Event and verified member before it
chooses a destination. Events without choices still go directly to Stripe.
Events with custom fields or enabled add-ons redirect to
`/payment/event-ticket/start?token=e1.…` with a newly encrypted continuation
that expires after 30 minutes or the event sales deadline, whichever is sooner.
No database collection or additional server-side token store is introduced.

The website immediately redirects to `/payment/event-ticket/<random-id>` before
rendering HTML. It stores the encrypted capability in an HttpOnly, SameSite=Lax
cookie restricted to that checkout path, with a 30-minute lifetime and Secure
in production. The URL identifier is random and carries no identity; it does
not authorize checkout without the cookie. Each tab can hold its own checkout.
Both the token handoff and preferences responses disable caching, indexing and
referrers. HEAD does not issue a cookie or prepare a payment.

The isolated page reuses the normal checkout event summary and mobile summary,
shows the event's extra inputs and add-on choices, and has no website header,
footer, account widgets, authentication initialization or analytics. It receives
only public event details, the applicable ticket price, guest/member pricing
mode and a revision hash—not the member's name, email, ID, subscription or prior
answers. The member's details remain on the API and are supplied to the normal
checkout/ticket fulfillment there.

`POST /api/v1/payment/event-ticket/preferences` validates the capability and
returns this restricted view. `POST /api/v1/payment/event-ticket/checkout`
revalidates it, account status, current membership benefits, event availability,
required answers, allowed options and add-on IDs. Incoming identity, event ID,
price, ticket quantity, method and return URL cannot override verified records.
Add-on prices and ticket metadata are reconstructed from the Event. Changes to
visible prices/options require reviewing the page again. Stripe metadata size
limits are checked with a readable error instead of silently truncating answers.

The browser submits choices to its same-origin
`POST /payment/event-ticket/<random-id>/pay` endpoint. That endpoint checks
Origin, JSON content type and a bounded request size. It retrieves the scoped
cookie server-side and forwards only the choices and capability, without
forwarding account cookies or an account Authorization header. No endpoint
creates or renews an authentication session. The capability cannot be used at
account endpoints; those still require a normal authenticated session. A stolen
complete email link remains a bearer capability for this specific ticket flow,
never general account access.

An existing ticket produces a guest-price preview and guest checkout. A purchase
completed during the flow is checked again before checkout; the existing guest
fallback is preserved. Free event/member tickets still require Stripe
confirmation, and selected paid add-ons are charged normally. Member checkout
reuse now compares line items, answers and add-ons as well as promo eligibility;
a changed selection expires the old open session before preparing a new one.

Deployment requires both the API and Next.js changes. No new environment
variables are needed; existing ticket encryption and server-to-server API keys
are reused. An expired page asks the recipient to reopen the original email.
The existing Atlas announcement trigger is not activated by this work.

Verification (all external services mocked):

- API: `node --test tests/member-event-announcements.test.js tests/member-event-preferences.test.js tests/event-promo-codes.test.js`
- Website: `node --test scripts/event-ticket-preferences.test.mjs`

Stripe checkout session expiration reference:
https://docs.stripe.com/api/checkout/sessions/expire
