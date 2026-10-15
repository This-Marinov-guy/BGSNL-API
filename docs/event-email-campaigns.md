# Regional event email campaigns

## Campaigns and audience

- `announcement`: invitation, with member and guest variants.
- `last-chance`: final booking reminder, manually selectable and automatically
  scheduled at 24 hours before `correctedDate || date`.
- `limited-offer`: current prices, applicable early bird, automatic discount,
  and optionally one explicitly selected promo code. Codes are only advertised
  to eligible ticket tiers. Checkout revalidates price and code eligibility.
- `guest-savings`: a manual membership invitation for opted-in guest ticket
  holders, available 72 hours after the event's corrected or original date.
  It uses the same server-side preview, one-step send action, campaign queue, and worker.

Audiences: `members`, `guests`, or `both`. Regional `marketingEmails` records
must have `unsubscribed: false` and `consent.granted: true`. The host plus the
direct neighbours in `util/config/nearby-regions.js` are included; combined-city
aliases are accepted. Any explicit opt-out record for an address wins across
regions. A current MemberUser is classified as a member; other consenting
addresses are guests. Membership/past purchases alone do not establish consent.
Member-only events exclude guests.

New event announcements also consider `guestMarketingEmails` records from
the current academic year for the host region and its direct nearby regions.
Those addresses need recorded marketing consent; an opt-out or an existing
member/alumni account excludes the guest record. Addresses already in the
regional marketing audience are sent only once. Publication-triggered
announcements include eligible guests as well as members, with the same
eligibility checks at preview and delivery.

Any existing guest-list ticket excludes its email and associated member/account
aliases, including refunded purchases. Addresses are trimmed, lowercased and
deduplicated before review. Existing publication announcements with only a
completion marker are conservatively excluded from repeat member announcements.

## Website

Event details → **Emails** → choose campaign and audience → check the eligible
email count → send. The count comes from a server-side preview; no email is sent
during that calculation. A selected promo code is advertised, not automatically
redeemed. When campaigns already exist, the modal shows a top banner with the
total accepted by the mailer and expandable recent history. History distinguishes
queued or sending campaigns from finished ones and shows accepted, skipped,
unconfirmed and not-sent counts. If history cannot be loaded, retry before sending.

At 90% capacity, review shows a warning. Closed sales, expired deadlines, full,
hidden, draft, archived, canceled or past events block sending. External-ticket
events are blocked because this platform cannot reliably exclude their buyers.

When editing a published event, adding/re-enabling an offer or code, activating
early bird, or reducing a price displays an optional **Prepare promotion email
after saving** checkbox. A successful save opens the same email modal; it never
sends automatically and a save failure cannot queue mail.

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

4. `GET /api/v1/event/:eventId/campaigns/history` returns the 20 most recent
campaign summaries for the event, including queued/sending campaigns, plus
`sentCount`, the cumulative number accepted by the mailer. The completed
summaries are saved in `Event.mailHistory`, and `Event.mailAcceptedTotal` preserves
the count beyond the 100 retained summaries. Older events initialize the total
from their retained summaries on their next completed campaign. The temporary
approved recipient list is removed from `Event.emailCampaigns` when the campaign ends.

Trusted server callers can inject/use `createEventCampaignService` with the
same preview/confirm flow. Do not bypass it with raw mass-mail loops.

## Worker and delivery safety

The parent `events` document stores approved recipient snapshots temporarily in
`emailCampaigns`, together with a campaign cursor and aggregate counts. It does
not store per-recipient delivery rows. A campaign-level lease keeps concurrent
workers from processing the same cursor. A deterministic Mailer operation ID
for the event, kind, offer version and normalized address lets the Mailer
recognize repeated handoffs. Previous campaign audiences block overlapping
campaigns of the same kind and version. A changed offer can be a new
limited-offer version; ordinary announcements and reminders retain version 1.

On completion or stop, the worker writes one aggregate summary to the event's
`mailHistory` and removes the temporary recipient list. Mailer delivery outcomes
are logged in its Google Sheet. The API rechecks consent, membership, tickets,
capacity and sales before each send; changed content or offer stops the campaign.
A purchase racing with provider acceptance may still receive that email.

A failed handoff pauses the campaign cursor and retries with the same operation
ID up to four attempts. The Mailer owns delivery idempotency and the exact
accepted payload. After the last failure, the cursor advances with an aggregate
failure count. A crash after provider acceptance can reissue the same operation
ID; there is no per-address delivery log in BGSNL.

The minute scheduler follows Amsterdam-independent UTC instants, with a one-hour
catch-up window after the 24-hour mark; it never sends catch-up blasts in the
last 23 hours. If sales are closed/full throughout that window, no reminder is
sent. Manual and scheduled `last-chance` runs share duplicate protection.

The Mailer receives bulk metadata and handles its own channel-specific
unsubscribes, bounce suppression, signed unsubscribe links and one-click
unsubscribe headers. Its suppression may reduce the final accepted count below
the API's preview count. No raw recipient list is returned to the browser.

## Guest audience by academic year

`guestMarketingEmails` stores one normalized guest ticket address per academic
year and event region. The compound index on `academicYear`, `region`, and
`email` supports a direct regional/year lookup and deduplicates repeat ticket
purchases. Both paid and free guest tickets are recorded after fulfillment;
member and alumni signups remove their address from every year and region.
Migration `014-backfill-guest-marketing-emails` populates existing unrefunded
guest tickets and excludes existing member/alumni addresses. Academic years are
named `YYYY-YYYY` and begin on 25 August in Amsterdam time.

This collection identifies candidates only. Use
`findGuestMarketingAudience({ academicYear, region })` from
`services/events/guest-marketing-emails.js` when preparing a campaign: it
requires recorded consent, excludes any address unsubscribed in
`marketingEmails`, and rechecks member/alumni accounts. Sending still needs
the campaign's usual unsubscribe link and delivery safeguards.

## Guest savings invitation

For a past event, open **Emails** after 72 hours to review the guest savings
campaign. It selects distinct normalized addresses from that event's guest
tickets, requires recorded marketing consent, honors opt-outs in every city,
and excludes existing member and alumni accounts whose email cannot use the new
signup flow. Refunded tickets do not count, and free events add no savings.
A single campaign per event and a stable Mailer operation ID prevent another
send to the same email, including when one purchase created several guest-list rows.

Each person's estimated savings are the sum of positive differences between
stored standard guest and member ticket prices for their guest tickets at
events from 25 August in Amsterdam through the selected event. Old ticket
records have no paid-price snapshot, so the email says that promotional prices,
add-ons and actual amounts paid can differ. Events without both prices are
omitted from the calculation. The dedicated Mailer template
`e203c44d-d3a2-4661-8e40-e37698911c8b` owns the delivered HTML and text
copy. `services/events/guest-savings-email.js` supplies its dynamic values and
an equivalent preview. The Mailer injects its signed unsubscribe link. After
the membership action, the email lists posters for past, visible events in
the campaign event's region from the most recent 26 August through the send
date, newest first. The boundary uses Amsterdam time. Only valid HTTPS poster
URLs are used. Preview blocks if the region has more than 2,000 events in that
range, so a send never silently drops part of the gallery. Archiving retains the event's
Cloudinary folder and poster until the annual 25 August media cleanup. The
academic year runs from 25 August inclusive to the next 25 August exclusive;
the poster gallery intentionally starts on 26 August.
Posters from older archives whose media was already deleted cannot be shown
until those assets are restored.

The **Become a member** link contains a 90-day AES-GCM encrypted query token
with the ticket holder's region, name, email and phone. The website asks the
API to authenticate and decode it, opens the plan-selection step, and prefills
the details step. The person can edit those details. `GUEST_SIGNUP_LINK_SECRET`
may be configured as a separate server-only secret (32+ characters); otherwise
the existing `JWT_STRING` is used through a dedicated HKDF key context. Never
use a browser-exposed encryption key for these links.

## Automatic guest membership campaigns

Two additional campaign sends use the same Emailit-routed guest savings template
and its signed unsubscribe button. They require recorded marketing consent,
exclude unsubscribed addresses, and recheck that the recipient has not become a
member or alumnus immediately before each Mailer request.

- **First paid guest event:** the scheduler finds the earliest event in each
  region from 25 August onward that sold a paid guest ticket. Once the event
  has passed by 24 hours, it emails consenting, unrefunded paid-ticket guests
  about that event's estimated member-price savings and membership benefits.
  A 14-day catch-up window covers outages without mailing an old event. Its poster
  gallery is hidden. One Redis completion marker is kept per academic year and
  region; stable Mailer operation IDs protect recipient retries. Free guest
  tickets and later events in that region do not trigger this campaign.
- **End of term 2 and term 3:** at the end of 15 February and 15 May in
  Amsterdam, the scheduler gathers consenting guests from the current academic
  year across all regions. It sends one recap per address, listing visible
  events so far in the selected region and the savings across that person's
  unrefunded guest tickets since 25 August. A 14-day catch-up window covers
  outages. Redis holds one completed marker per term, not recipient delivery
  rows; stable Mailer operation IDs protect retries.

Both campaigns use the event's stored standard guest and member prices as an
estimate. The `GUEST_CAMPAIGNS_ENABLED` flag defaults to on in production and
off in development; `false` disables both sends. Enable the flag only when the
Mailer guest-savings template and Redis scheduler are available.

## Deployment

1. Deploy the Mailer templates `59f51c9c-88e0-49bc-9e62-b14c8aa4a71d` and
   `e203c44d-d3a2-4661-8e40-e37698911c8b`, registry and manifest before
   enabling the API worker.
2. Deploy API and website together. Run the numbered database migrations with
   writers stopped; they move existing media cleanup due dates to 25 August
   and backfill `guestMarketingEmails` from historical guest tickets. Mongoose
   initializes event indexes before the worker starts.
3. Set `EVENT_CAMPAIGNS_ENABLED=true` to explicitly enable, or `false` to disable.
   Default: enabled only in production. Development previews work while sending
   is disabled. `EVENT_CAMPAIGN_REVIEW_SECRET` (32+ characters) can be set separately;
   otherwise the existing `JWT_STRING` is used.
4. While enabled, the new worker replaces the legacy publication worker and
   uses the same publication markers with the new consent and deduplication rules.

Tests use injected stores and delivery functions. Do not send real campaign
emails just to verify the feature.
