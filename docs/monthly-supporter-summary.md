# Monthly alumni supporter summary

## Schedule and audience

The API schedules this email for **23:59 on the last day of each calendar month**
in `Europe/Amsterdam`, including leap years and daylight-saving changes. The
snapshot covers month start inclusive up to the 23:59 cutoff exclusive; the final
minute cannot be included in a summary dispatched before the month has ended.
The email states its cutoff. Delivery to a large audience may finish after midnight.

The national summary goes to:

- Alumni with `status: active`, tier 1–4, current paid coverage (`expireDate` in
  the future, or existing VIP access), and existing email notification consent.
- When a subscription ID exists, its stored `hasBenefits` must be true and its
  `lockReason` empty. A cancelled subscription with paid benefits remaining is
  still eligible. Expired, tier-0, migrated and payment-locked accounts are not.
- Configured internal notification subscribers when internal notifications are
  enabled. The default internal address is `notifications@bulgariansociety.nl`.

Alumni must have `notificationTerms: true` and an email-capable
`notificationTypeTerms` (`email`, `whatsapp & email`, `Any`, or an unset legacy
channel). The job does not opt people in or change their subscription.
Addresses are normalized and deduplicated across both lists. Each recipient gets
a separate message, with no recipient list or member personal details exposed.
Eligibility uses the stored billing state; this informational report does not
grant benefits or make a live billing request per recipient.

## Content

- A thank-you for supporting Bulgarian Society Netherlands.
- Events whose corrected date (or original date when not corrected) falls within
  the period: poster, name and local date, plus a link to the event.
- Archived events are included; hidden, draft and cancelled events are excluded.
- New Member and Alumni counts use the existing internal weekly report’s
  `joinDate`/current-account filtering. These are counts, never names or emails.
- Up to 10 optional news items, each with a title, plain text and optional HTTPS
  link. HTML is escaped; empty news is omitted. An empty event month still sends
  a thank-you and the membership figures.

Poster limitation: the existing archive job deletes the event media folder.
This feature does not change that retention policy. Missing/invalid poster URLs
show “No poster”; an already-deleted image URL can only show its alt text in an
email client. Retaining archive images requires a separate retention decision.

## Staff editor

`/user/dashboard/monthly-summary` is available to the existing national
member-management roles (admins, national board and national committee, including
the existing legacy national board role). Regional-only staff cannot access it.

`GET /dashboard/monthly-summary/:month` returns the saved news, an email preview,
live aggregate recipient counts and scheduled date. It never returns recipient
addresses. The current month’s preview is provisional; figures are checked again
at send time. Past published content is frozen, but audience counts shown by the
editor are current eligibility counts, not historical delivery receipts.

`PATCH /dashboard/monthly-summary/:month` accepts `{ revision, news }`. Revision
checks prevent another editor’s changes being overwritten. Edits close at the
send cutoff and whenever the snapshot is frozen. There is no manual-send route.
Saving news does not send email. Past unprocessed months are not backfilled.

## Storage and delivery safety

`monthlySummaries` is keyed by `YYYY-MM`, storing optional news, its revision,
editor ID and a frozen content snapshot. The worker freezes the latest saved
news atomically at the cutoff. Existing users and events need no migration.

`monthlySummaryDeliveries` is keyed by month plus a SHA-256 hash of the normalized
email. An atomic unique `_id` claim precedes each send, preventing duplicate
attempts across concurrent workers and restarts. Receipts are `attempted`, `sent`
or `uncertain`; no raw recipient address is stored in this collection.

As with other email schedules, only PM2 worker 0 owns the timer. Startup schedules
the next future occurrence, with no immediate send or missed-month catch-up.
Timer delays are bounded to one day to avoid Node’s approximately 24-day timer
limit. The scheduler is observed as `monthly-supporter-summary`.

An uncertain provider result is not blindly retried, because the provider may
already have accepted the message. Inspect the provider and receipt before any
manual repair. A crash after claim but before acceptance can therefore leave a
recipient unsent; this is at-most-one automatic attempt, not guaranteed delivery.
Content and delivery receipts are retained for audit. No automatic deletion or
retention policy is introduced by this feature.

```dotenv
# Defaults true only in production; local development does not send.
MONTHLY_SUPPORTER_SUMMARY_ENABLED=true
INTERNAL_NOTIFICATIONS_ENABLED=true
INTERNAL_NOTIFICATION_SUBSCRIBERS=notifications@bulgariansociety.nl
```

Delivery reuses the existing configured provider and sender, with the category
`monthly-supporter-summary`. Do not enable the worker in development unless real
recipient delivery is explicitly intended. Deploying is separate from local
implementation; tests inject the sender and never send real emails.

```sh
node --test tests/monthly-summary.test.js tests/weekly-membership-report.test.js tests/regional-membership-report.test.js
```
