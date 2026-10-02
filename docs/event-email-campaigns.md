# Regional event email campaigns

## Campaigns and audience

- `announcement`: invitation, with member and guest variants.
- `last-chance`: final booking reminder, manually selectable and automatically
  scheduled at 24 hours before `correctedDate || date`.
- `limited-offer`: current prices, applicable early bird, automatic discount,
  and optionally one explicitly selected promo code. Codes are only advertised
  to eligible ticket tiers. Checkout revalidates price and code eligibility.

Audiences: `members`, `guests`, or `both`. Regional `marketingEmails` records
must have `unsubscribed: false` and `consent.granted: true`. The host plus the
direct neighbours in `util/config/nearby-regions.js` are included; combined-city
aliases are accepted. Any explicit opt-out record for an address wins across
regions. A current MemberUser is classified as a member; other consenting
addresses are guests. Membership/past purchases alone do not establish consent.
Member-only events exclude guests.

Any existing guest-list ticket excludes its email and associated member/account
aliases, including refunded purchases. Addresses are trimmed, lowercased and
deduplicated before review. Existing publication announcements with only a
completion marker are conservatively excluded from repeat member announcements.

## Website

Event details → **Emails** → choose campaign and audience → review counts,
regions, warnings and audience-specific previews → type `SEND` → confirm.
No email is sent during preview. Prices can differ between regular and active
member tiers. A selected promo code is advertised, not automatically redeemed.

At 90% capacity, review shows a warning. Closed sales, expired deadlines, full,
hidden, draft, archived, canceled or past events block sending. External-ticket
events are blocked because this platform cannot reliably exclude their buyers.

When editing a published event, adding/re-enabling an offer or code, activating
early bird, or reducing a price displays an optional **Review promotion email
after saving** checkbox. It is off by default. A successful save opens the same
review modal; it never sends automatically and a save failure cannot queue mail.

## Programmatic API

Use the normal authenticated API with event-management permissions. Regional
staff can only campaign for their own region's event, with its nearby audience;
national staff use the existing all-region permission. All routes are private.

1. `POST /api/v1/event/:eventId/campaigns/preview`

```json
{"kind":"limited-offer","audience":"both","promoCode":"EARLY10"}
```

`promoCode` is optional. The response contains `preview`, counts, regions,
warnings, preview HTML/text, available promo codes, and `review` with an expiry
and signature. Never accept browser-supplied recipients or email content.

2. Review that response, then `POST /api/v1/event/:eventId/campaigns/confirm`
with the same selection, the exact returned `review`, and a fresh UUID v4
`requestId`. Reviews expire after 10 minutes and bind the actor, selection,
event, availability and audience. Changed data returns 409 and needs new review.
Reuse the **same requestId** after a timeout or lost confirmation response.

3. `GET /api/v1/event/:eventId/campaigns/:campaignId` reports status and delivery
counts without exposing recipient addresses. `accepted` means accepted by the
Mailer, not proof that a person received/opened the message.

Trusted server callers can inject/use `createEventCampaignService` with the
same preview/confirm flow. Do not bypass it with raw mass-mail loops.

## Worker and delivery safety

Mongo collections `eventEmailCampaigns` and `eventEmailDeliveries` store approved
audience snapshots and permanent delivery keys. Unique campaign keys and
delivery `_id = hash(event, kind, offer-version, normalized email)` suppress
duplicates across overlapping audiences, regions, concurrent workers, restarts,
manual reminders and scheduled reminders. A changed price/offer can be a new
limited-offer version. Announcements/reminders do not reset when the event is edited.

The worker rechecks consent, membership classification, tickets, capacity and
sales before each send. Changed content/offer stops the campaign. An email
already accepted by the external provider cannot be recalled; a purchase racing
with provider acceptance may still receive that in-flight email.

Each delivery has a 5-minute claim lease, a stable Mailer operation UUID and
persisted envelope. The Mailer client times out at 95 seconds. Up to three
retries reuse the exact operation/payload, including after an uncertain timeout;
no fallback provider is used. Exhausted attempts are reported as unconfirmed,
not silently resent as a new campaign. Operations require administrator review
before recovery of stopped or exhausted campaigns.

The minute scheduler follows Amsterdam-independent UTC instants, with a one-hour
catch-up window after the 24-hour mark; it never sends catch-up blasts in the
last 23 hours. If sales are closed/full throughout that window, no reminder is
sent. Manual and scheduled `last-chance` runs share duplicate protection.

The Mailer receives bulk metadata and handles its own channel-specific
unsubscribes, bounce suppression, signed unsubscribe links and one-click
unsubscribe headers. Its suppression may reduce the final accepted count below
the API's preview count. No raw recipient list is returned to the browser.

## Deployment

1. Deploy the Mailer template `59f51c9c-88e0-49bc-9e62-b14c8aa4a71d`, registry and
   manifest before enabling the API worker.
2. Deploy API and website together. Mongoose initializes the two new collections'
   indexes before the worker starts; no existing event/account data is migrated.
3. Set `EVENT_CAMPAIGNS_ENABLED=true` to explicitly enable, or `false` to disable.
   Default: enabled only in production. Development previews work while sending
   is disabled. `EVENT_CAMPAIGN_REVIEW_SECRET` (32+ characters) can be set separately;
   otherwise the existing `JWT_STRING` is used.
4. While enabled, the new worker replaces the legacy publication worker and
   uses the same publication markers with the new consent and deduplication rules.

Tests use injected stores and delivery functions. Do not send real campaign
emails just to verify the feature.
