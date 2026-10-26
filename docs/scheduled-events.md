# Scheduled background jobs

This file inventories recurring work configured in the API, its dedicated worker,
the website's GitHub Actions workflow, and the VPS systemd timer. A configured
schedule is not proof that its production process, feature flag, or external
workflow is currently enabled. Update this inventory whenever a schedule is
added, removed, or changes frequency.

Last reviewed: 26 October 2026.

Database-triggered work is inventoried in [triggers.md](triggers.md).

## API schedules

These start from `app.js` after API storage initialization. PM2 API worker 0
owns them except Billing maintenance, which uses a shared lease and due time
across API processes. Daily checks run at 10:00 `Europe/Amsterdam`, including
daylight saving changes. A startup after 10:00 runs that day's check immediately.

| Job | Schedule | Time zone | Enabled when | Main effect |
| --- | --- | --- | --- | --- |
| Weekly membership summary | Sunday at 18:00; no startup send or missed-run catch-up | `Europe/Amsterdam` | Internal notifications are enabled and the API is in production, or `WEEKLY_MEMBERSHIP_REPORT_ENABLED=true`; setting the flag to `false` disables it | Emails the preceding Sunday 18:00–Sunday 18:00 member counts by region and one national alumni count to every internal-notification subscriber |
| Regional new-member summary | Sunday at 18:00; no startup send or missed-run catch-up | `Europe/Amsterdam` | Same gates as the weekly membership summary; PM2 worker 0 only | Sends the same internal report template, restricted to one region, to its database contact; skips regions without new members |
| Monthly alumni supporter summary | Last calendar day at 23:59; no startup send or missed-run catch-up | `Europe/Amsterdam` | Production by default, or `MONTHLY_SUPPORTER_SUMMARY_ENABLED=true`; `false` disables it; PM2 worker 0 only | Thanks eligible active alumni and internal subscribers with hosted events, new-account counts, articles published that month, and optional community updates; see [monthly-supporter-summary.md](monthly-supporter-summary.md) |
| Academic-year statistics seed | On API startup and at 00:00 on 25 August; failed seed retries after one hour until halted | `Europe/Amsterdam` | PM2 worker 0 | Inserts missing event and member averages for the current academic year without overwriting existing values |
| Billing maintenance | Daily check at 10:00; catches up after a late startup; shared lease and persisted due time prevent duplicate sweeps | `Europe/Amsterdam` | `NODE_ENV=production` or `BILLING_WORKER_ENABLED=true`; `false` disables it | Recovers paid membership Checkout sessions, reconciles stale subscriptions, and sends eligible regional application payment reminders |
| Birthday greetings | Daily check at 10:00; catches up after a late startup | `Europe/Amsterdam` | `NODE_ENV=production` or `BIRTHDAY_EMAIL_WORKER_ENABLED=true`; setting the flag to `false` disables it | Sends one non-promotional birthday greeting to each current Member or Alumni account with a valid stored date of birth |
| Event email campaigns | Daily check at 10:00; automatic last-chance offer is eligible during an event's final 24 hours | `Europe/Amsterdam` check; UTC event instants | `EVENT_CAMPAIGNS_ENABLED=true` or production default; PM2 worker 0 | Queues and delivers publication announcements, last-chance offers, and queued manual campaigns; replaces the legacy announcement worker when enabled |
| Member event announcements, legacy | Daily check at 10:00; an authenticated Atlas notification can request an earlier pass | `Europe/Amsterdam` | `EVENT_ANNOUNCEMENTS_ENABLED=true` or production default, **and** event campaigns disabled | Delivers pending publication announcements with personal encrypted ticket links; recovers missed trigger notifications |
| Event cancellation recovery | Daily check at 10:00; failed event work stays eligible for a later check | `Europe/Amsterdam` check; UTC event instants | PM2 worker 0 | Finishes pending event refunds, archive cleanup, and cancellation emails |
| Event feedback follow-up | Daily check at 10:00; email becomes due 24 hours after the effective event date | `Europe/Amsterdam` check; UTC event instants | Production by default, or `EVENT_FEEDBACK_EMAIL_ENABLED=true`; `false` disables it; PM2 worker 0 only | Sends a ticket-specific Emailit campaign to consenting attendees who have not unsubscribed; stable operation IDs make event-level retries safe |
| First paid guest event campaign | Daily check at 10:00; due 24 hours after the first paid guest-ticket event in each region from 25 August, with a 14-day catch-up window | `Europe/Amsterdam` academic year; UTC event instants | Production by default, or `GUEST_CAMPAIGNS_ENABLED=true`; `false` disables it; PM2 worker 0 only | Sends that event's estimated savings and membership benefits to consenting paid-ticket guests through the Emailit campaign template, once per region and academic year |
| Guest term 2 recap | Daily check at 10:00; due after 23:59:59 on 15 February, with a 14-day catch-up window | `Europe/Amsterdam` | Same guest campaign flag; PM2 worker 0 | Sends current-year guests their event recap and possible savings, once per term and address |
| Guest term 3 recap | Daily check at 10:00; due after 23:59:59 on 15 May, with a 14-day catch-up window | `Europe/Amsterdam` | Same guest campaign flag; PM2 worker 0 | Sends current-year guests their event recap and possible savings, once per term and address |
| Event sitemap expiry | Daily check at 10:00 | `Europe/Amsterdam` check; UTC event instants | `NODE_ENV=production` or `EVENT_SITEMAP_EXPIRY_ENABLED=true`, with GitHub sitemap dispatch credentials; `false` disables it; PM2 worker 0 only | Requests a sitemap refresh when a public event passes the 48-hour post-start cutoff; retries until GitHub accepts the dispatch |
| Event archive | Daily at 03:15 UTC; checks every minute and catches up after startup | UTC event instants | `NODE_ENV=production` or `EVENT_ARCHIVE_ENABLED=true`; `false` disables it; PM2 worker 0 only | Archives published events at least 72 hours after their effective start time, deactivates Stripe prices and product, updates statistics, and retries incomplete archive cleanup |
| Event draft cleanup | Daily at 03:00; catches up later that day | `Europe/Amsterdam` | `NODE_ENV=production` or `EVENT_DRAFT_CLEANUP_ENABLED=true`; `false` disables it | Removes drafts created more than 30 days ago; drafts with media remain hidden until their annual media cleanup |
| Log and table retention | Daily at 03:05; catches up later that day | `Europe/Amsterdam` | `NODE_ENV=production` or `LOG_RETENTION_ENABLED=true`; `false` disables it | Removes completed migration journals and job records older than 30 days |
| Event media cleanup | Once per academic year after 25 August at 03:00; catches up after downtime and retries failed folders | `Europe/Amsterdam` | `NODE_ENV=production` or `EVENT_MEDIA_CLEANUP_ENABLED=true`; `false` disables it; PM2 worker 0 only | Removes Cloudinary assets of events from the past academic year, after a 72-hour post-event window |

They stop accepting new work during graceful API shutdown. The monthly and
weekly reports schedule the next future occurrence without a missed-run replay;
the billing, draft, log, archive, media, birthday, and academic-year jobs can catch up
after an API restart as described below.

Billing maintenance runs from
[`services/subscriptions/reminders.js`](../services/subscriptions/reminders.js).
It checks for missed paid membership Checkout completion, reconciles stale
subscription state with Stripe, and sends eligible regional application payment
reminders. Each phase observes a 50-second work budget. The shared Redis lease and
persisted next daily due time allow one sweep across API processes, including
after restarts. Signed webhooks remain the immediate update path, and Stripe
sends central payment-failure emails. Member revenue maintenance is queued by
the signed national Stripe webhook separately.

The academic-year seed runs from
[`services/background-services/academic-year-statistics.js`](../services/background-services/academic-year-statistics.js).
It inserts missing current-year event and member averages on startup and after
the 25 August boundary. The Sunday membership report separately refreshes
current-year member averages before emailing its counts; see
[regional statistics averages](regional-averages.md).

[`services/events/event-campaign-worker.js`](../services/events/event-campaign-worker.js)
polls for automatic last-chance campaigns, publication announcements, and queued
manual campaigns. When it is enabled, `app.js` does not start the separate
[`member-event-announcements.js`](../services/events/member-event-announcements.js)
poller. The event cancellation worker in
[`services/events/event-cancellation.js`](../services/events/event-cancellation.js)
checks pending cancellation requests daily at 10:00. A failed event becomes
eligible after five minutes and is attempted on the next daily check. Both use
PM2 worker 0.

The event archive worker uses `correctedDate` when present, otherwise `date`.
It checks every minute and runs once the daily 03:15 UTC time has passed,
including after an API restart. An event that fails archival remains eligible
for the next check; pending cleanup on an already archived event is retried.
Each event holds its own lease. The website's protected endpoint remains
available for manual recovery, but Vercel no longer schedules it.

The guest campaign workers in
[`services/events/guest-lifecycle-campaigns.js`](../services/events/guest-lifecycle-campaigns.js)
run on PM2 worker 0 and keep Redis completion markers for each region's first
paid event and for each academic-year term recap. Their five-failure halt state
persists in MongoDB. Queued event email campaigns are processed by PM2 worker 0.
The campaign worker records failed campaign processing passes in the shared
five-failure policy. Individual recipient delivery uses five attempts in the
persisted campaign record; final failure creates one developer alert receipt
per campaign.
The Mailer routes the existing guest-savings template through Emailit and
checks its unsubscribe table when accepting each campaign message.

The feedback worker schedules future published events when it first sees them,
then persists the due time and an event-level retry time. It also enrolls an
event from the preceding 48 hours if it passed between daily checks; older
unscheduled events are not enrolled retroactively.
Archived events remain eligible; cancelled events and refunded tickets do not.
One email goes to each normalized address even when that address bought several
tickets. The link opens the form without a login. Responses live in each event's
`feedbacks` array; an atomic event update rejects another response for the same
ticket or normalized recipient address. The feedback email uses the Bulgarian
Society campaign template, including its unsubscribe button and one-click
header. The API checks recorded marketing consent and opt-outs across cities
before sending, and the Mailer checks its campaign suppression table again.

The event sitemap expiry worker checks the same effective date and visibility
filter as the public event list. It sends one GitHub dispatch for up to 100 newly
past events, then records each event's effective date. A failed dispatch leaves
the events eligible for retry; an event rescheduled to a different date can
trigger the worker again after its new cutoff. Publication, published edits and
archival request an immediate refresh through their event handlers.

## Redis spreadsheet worker

Source: [`workers.js`](../workers.js),
[`services/jobs/spreadsheet-sync-queue.js`](../services/jobs/spreadsheet-sync-queue.js)
and [`services/jobs/spreadsheet-sync-worker.js`](../services/jobs/spreadsheet-sync-worker.js).

The API places Google Sheets synchronization work in the durable Redis queue
after the database write succeeds. The `bgsnl-worker` Compose service consumes
it independently of the two API processes. Event, special-event, member,
alumni and internship exports are deduplicated by their affected record or
region, delayed briefly to coalesce rapid updates, and retried up to five times
with exponential backoff. Completed and failed jobs remain available for 30
days for operational inspection. A final failure emails the developer group.

The worker also schedules a guest-list reconciliation every six hours. Its first
run starts when the production worker boots. It requeues society and special
events with guests dated within the last 30 days, capped at 500 events per run.
This repairs missed enqueue attempts and stale sheets without holding up ticket
sales or check-in requests. Development runs it only when
`GUEST_LIST_RECONCILIATION_ENABLED=true` is set. The event writer quotes sheet
names, reuses its attendance formatting rule, and lets failed writes reach the
queue retry handler.
The monitoring Google Sheets probe checks both the national members sheet and
the event sheet. Both documents must grant the configured service account access.

The append-only data-pool export remains on its existing in-process path until
it has an idempotency key; retrying an append without one could duplicate rows.

## Event draft cleanup

Source:
[`services/background-services/event-draft-cleanup.js`](../services/background-services/event-draft-cleanup.js)

The draft cleanup becomes due at 03:00 in `Europe/Amsterdam`, including daylight
saving time. It checks on startup and every minute, catching up if the API starts
later that day. It starts after database/storage initialization and finishes any
in-flight deletion before shutdown. Failed attempts retry on the next tick.

Only `eventDrafts` records with `status: draft` and a creation date strictly older
than 30 × 24 hours are deleted. The immutable `createdAt` is authoritative;
`metadata.createdAt` is a fallback when that field is absent or null. Drafts
exactly 30 days old, newer drafts, undated records and published events are
retained. Editing a draft does not reset its age. Media files are retained,
because published events can share the same assets. Before hiding a draft,
the worker records its Cloudinary folder and annual cleanup due date on that draft. A draft without media is deleted immediately.

## Log and table retention

Source: [`services/background-services/log-retention.js`](../services/background-services/log-retention.js)

A separate daily job starts at 03:05 Amsterdam time. Scheduler and in-process
job history, completed and failed Redis queue records, completed migration
journals, and delivered queue-alert receipts are retained for up to 30 days.
The job explicitly removes old queue records because BullMQ's age limit is
applied lazily when new jobs finish.
The `LOG_RETENTION_ENABLED` flag controls only this job.

The migration journal cleanup removes `migrationJournal` run records and their
snapshot documents 30 × 24 hours after a successful migration or confirmed
rollback. A recovered rollback ages from its recovery time. Running and failed
rollbacks, runs without
a completion time, orphan snapshots, and the deployment lock are retained for
operator recovery or review. Snapshots are deleted before their run record, so
a failed cleanup can safely retry.

The last successful day is held only in process memory. A restart or another
server can repeat the idempotent deletion safely; no new database logs, delivery
records or permanent Redis keys are created. Only PM2 worker 0 runs this job.

```dotenv
# Enabled by default in production; disabled by default in local development.
LOG_RETENTION_ENABLED=true
```

This worker takes effect when the updated API is deployed and started. Adding
it to the repository does not run a cleanup against the live database.

## Event media cleanup

Source: [`services/events/event-media-cleanup.js`](../services/events/event-media-cleanup.js)

Archiving or manually deleting a published event leaves its Cloudinary assets
in place. The annual job uses the yearless academic-year boundary from
`util/config/academic-year.js` and becomes due at 03:00 Amsterdam time on
25 August.
Event folders and poster images are removed when the event ended at least 72
hours before that cutoff. A folder shared with a live draft or a later event
is deferred until a later August 25. The same job cleans folders on hidden, deleted draft records and removes those records after cleanup. Old archived posters that were copied to the shared
`archived-event-posters` folder are removed individually. Per-event due dates
and completion markers persist on the parent event and draft documents, so an interrupted job retries after
startup. Cloudinary failures retry after one hour. A Redis year marker prevents
another completed sweep for the same annual cutoff, and each sweep drains all
eligible batches. Only PM2 worker 0 runs it.

```dotenv
EVENT_MEDIA_CLEANUP_ENABLED=true
```

The flag is enabled by default in production. Adding this job to the repository
does not run it against the live database.

## Birthday greetings

Source:
[`services/background-services/birthday-emails.js`](../services/background-services/birthday-emails.js)

The worker resolves the current calendar date in `Europe/Amsterdam`, including
daylight-saving changes, and becomes eligible at 10:00. If the API was down at
that time, it catches up later on the same Amsterdam calendar day. It checks
both current Member and Alumni collections and skips accounts without a real
stored date of birth. Migrated/archived source copies are excluded and a shared
email address receives no more than one greeting.

The separate delivery collection has been removed. The scheduler remembers
attempted inboxes only in the running process, without outcomes or Mongo logs.
A restart can repeat a greeting; see [storage-and-redis.md](storage-and-redis.md).

Configuration:

```dotenv
# Production default: enabled
BIRTHDAY_EMAIL_WORKER_ENABLED=true
```

## Member revenue webhook work

The signed national Stripe webhook enqueues a deduplicated Redis job for paid
invoices, subscription changes, refunds, disputes and balance availability.
The dedicated worker rebuilds Stripe invoice state and settles regional shares.
Blocked or deferred transfers email the developer group with safe invoice and
connected-account references, with daily reminders while unresolved. They do
not fail or delay the shared queue job. A daily recovery sweep retries them
even if no new webhook arrives. Unexpected job errors fail after one attempt
and email the developer group; later webhook and daily jobs remain available.
The webhook returns an error
if it cannot persist the job, allowing Stripe to retry delivery.

## Failure alerts

API schedules that use `runObservedJob` stop after five consecutive failed runs.
Their failure count and halted state persist in MongoDB across restarts. A
developer email is sent when the fifth failure halts the job; failed alert
delivery is retried while the job is halted. The email omits exception messages
and payloads. After fixing the cause, an operator clears the corresponding
`JobFailureState`
record to resume the job. The academic-year seed also needs an API worker
restart after that reset because it schedules its next run in process memory.
Redis queue jobs and individual event campaign recipient deliveries also make
at most five attempts and email the developer group after final failure. Failed
email delivery is retried from a durable alert receipt during the hourly
weekday business-hour checks until accepted. Individual event campaign
recipient failures follow their separate persisted retry cursor. The GitHub
and systemd schedules use their own platform failure reporting.

Existing failed monitoring records are preserved and age out normally; deploying
this change does not retry the historical spreadsheet queue or clear failures.

## Weekly membership summary

Source:
[`services/background-services/weekly-membership-report.js`](../services/background-services/weekly-membership-report.js)

The report is scheduled for Sunday at 18:00 in `Europe/Amsterdam`, including
daylight-saving changes. It covers the preceding Sunday 18:00 inclusive to the
current Sunday 18:00 exclusive, so registrations are not omitted between weeks.
Startup only schedules the next future occurrence; it never sends immediately.
There is no catch-up after downtime. If the scheduler is unavailable at the
scheduled time (or delayed beyond that minute), that occurrence is skipped.

The message contains:

- new member count per configured city;
- one national new-alumni row, separate from the member regions;
- an `Unassigned` member row when matching records have no usable region.

Counts use `joinDate`. Migrated and archived account copies are excluded. The
report intentionally contains counts only, not member names or email addresses.

Recipients and delivery provider are inherited from the internal notification
configuration:

```dotenv
INTERNAL_NOTIFICATIONS_ENABLED=true
INTERNAL_NOTIFICATION_SUBSCRIBERS=notifications@bulgariansociety.nl

# Optional override. Production defaults to enabled when internal notifications
# are enabled. Set false to stop both national and regional weekly reports.
WEEKLY_MEMBERSHIP_REPORT_ENABLED=true
```

Each recipient receives a separate message.

Weekly delivery records have been removed. A process-local schedule guard avoids
repeating a week's sends during the same process lifetime. A restart schedules
only the next future Sunday, not a replay. Only the designated email scheduler
process owns the timer. There is no persistent delivery receipt; manual or
multiple independently configured scheduler processes are not globally deduplicated.

## Regional new-member summary

The regional variant uses the same weekly template and schedule, with recipients
loaded from `regionContacts`. It sends only for regions with new members and
shows only that region's member count, without the national alumni count. See
[Regional contact directory and weekly report](region-contacts.md) for migration,
routing and delivery semantics.

## Dedicated worker and external schedules

| Job | Owner and timing | Enabled when | Main effect |
| --- | --- | --- | --- |
| Guest-list reconciliation | `bgsnl-worker` BullMQ scheduler, every six hours | `APP_ENV=prod` by default, or `GUEST_LIST_RECONCILIATION_ENABLED=true`; `false` disables it | Requeues recent society and special-event guest lists for Google Sheets sync |
| Developer failure-alert retry | `bgsnl-worker`, on each hour from 09:00 through 16:00, Monday–Friday | Dedicated worker running | Retries unsent developer emails for halted scheduled jobs and exhausted queue jobs from Mongo alert receipts |
| Public sitemap fallback | Website GitHub Actions at 06:17 UTC daily; also accepts dispatch and manual runs | `SITEMAP_REFRESH_ENABLED=true` repository variable for automatic runs | Revalidates the website's sitemap and checks the public sitemap and `llms.txt` |
| API memory sample | VPS systemd timer every five minutes, with persistent catch-up after downtime | `bgsnl-api-memory.timer` installed and enabled on the VPS | Writes PM2 worker RSS measurements to the system journal; see [API worker memory](api-memory-monitoring.md) |

Guest-list reconciliation is configured by [`workers.js`](../workers.js) and
[`services/jobs/guest-list-reconciliation.js`](../services/jobs/guest-list-reconciliation.js).
The alert retry timer is also in `workers.js`; it scans unsent receipts in
`JobFailureState` and calls the developer email provider directly. Its business
hours are `Europe/Amsterdam`, with an immediate catch-up check when the worker
starts during that window. Initial fifth-failure alerts are attempted at the
time of failure, including outside business hours.

The sitemap cron is defined in the sibling website repository at
`BGSNL/.github/workflows/refresh-sitemap.yml`; the API's sitemap expiry worker
can request an immediate workflow dispatch. The memory timer is defined in
[`ops/systemd/bgsnl-api-memory.timer`](../ops/systemd/bgsnl-api-memory.timer).
Neither repository configuration alone confirms the current GitHub variable or
VPS timer state.

## Operational timers that are not scheduled jobs

These timers support in-flight work and do not initiate periodic business
events:

| Timer | Duration | Purpose |
| --- | --- | --- |
| Billing lease heartbeat | Every 20 seconds while a protected billing mutation runs | Keeps the two-minute distributed lease owned by the active process |
| General email queue timeout | 60 seconds for the legacy provider; 100 seconds for Domakin Mailer | Prevents one delivery from blocking the in-memory mail queue indefinitely |
| Redis spreadsheet-job retry | Five attempts with exponential backoff, beginning at one second | Recovers transient Google Sheets or network failures without blocking API requests |

## Event-driven work and manual utilities

Member revenue maintenance is queued by the signed national Stripe webhook
and a daily recovery schedule. Spreadsheet synchronization and marketing
capture also consume jobs after API actions; guest-list reconciliation runs
every six hours. Member and alumni statistics recounts are requested
by subscription actions, not a calendar timer. The API's Docker CI/CD workflow
is triggered by pushes and pull requests; the website's separate sitemap
workflow has the daily cron listed above. Vercel has no configured cron in
`BGSNL/vercel.json`.

Marketing and backfill scripts in `scripts/` run manually. The exception is
`scripts/sample-api-memory.py`, invoked by the VPS timer listed above.

## Verification

Run the scheduler-specific tests without sending real email:

```bash
npm run test:weekly-membership-report
npm run test:birthday-emails
node --test tests/calendar-check.test.js tests/job-failure-policy.test.js tests/academic-year-statistics.test.js tests/event-campaigns.test.js tests/event-cancellation.test.js tests/event-feedback.test.js tests/guest-lifecycle-campaigns.test.js tests/guest-list-reconciliation.test.js
node --test tests/event-archive-worker.test.js tests/event-draft-cleanup.test.js tests/log-retention.test.js tests/event-media-cleanup.test.js tests/sitemap-expiry.test.js
node --test tests/billing-maintenance.test.js
```
