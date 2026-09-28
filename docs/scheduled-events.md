# Scheduled background jobs

This file is the inventory of recurring work started by the BGSNL API process
or its dedicated worker service. Update it whenever a recurring worker, queued
job, cron job, or externally scheduled API task is added, removed, or changes
frequency.

Last reviewed: 15 September 2026.

Database-triggered work is inventoried in [triggers.md](triggers.md).

## Active schedule

| Job | Schedule | Time zone | Enabled when | Main effect |
| --- | --- | --- | --- | --- |
| Billing maintenance | Immediately after API startup, then every 60 seconds | Not calendar-based | `NODE_ENV=production` or `BILLING_WORKER_ENABLED=true`; `BILLING_WORKER_ENABLED=false` always disables it | Processes payment reminders, recovers Checkout sessions, and refreshes stale subscription state |
| Regional Member revenue | Within the billing worker, approximately every 60 seconds | UTC for monthly fee reports | Billing worker enabled and `MEMBER_REVENUE_SHARING_ENABLED=true` | Reconciles new Member invoice allocations, actual Stripe fees and regional Connect transfers; see [member-revenue-sharing.md](member-revenue-sharing.md) |
| Weekly membership summary | Sunday at 18:00; no startup send or missed-run catch-up | `Europe/Amsterdam` | Internal notifications are enabled and the API is in production, or `WEEKLY_MEMBERSHIP_REPORT_ENABLED=true`; setting the flag to `false` disables it | Emails the preceding Sunday 18:00–Sunday 18:00 member/alumni totals per city to every internal-notification subscriber |
| Birthday greetings | First check after API startup, then every minute; a daily greeting becomes due at 10:00 | `Europe/Amsterdam` | `NODE_ENV=production` or `BIRTHDAY_EMAIL_WORKER_ENABLED=true`; setting the flag to `false` disables it | Sends one non-promotional birthday greeting to each current Member or Alumni account with a valid stored date of birth |
| Member event announcements | Immediately after API startup, then every minute; an authenticated Atlas notification can request an earlier pass | Not calendar-based | `NODE_ENV=production` or `EVENT_ANNOUNCEMENTS_ENABLED=true`; `false` disables it | Delivers pending publication announcements with personal encrypted ticket links; recovers missed trigger notifications |
| Event draft cleanup | Daily at 03:00; checks every minute and catches up after startup later that day | `Europe/Amsterdam` | `NODE_ENV=production` or `EVENT_DRAFT_CLEANUP_ENABLED=true`; `false` disables it | Deletes event drafts created more than 30 days ago |

All workers start only after MongoDB and Redis are ready and the required
account/temporary-code indexes exist. In PM2 cluster mode, only worker 0 runs
birthday, weekly-summary, event-announcement and event-draft cleanup schedules. They stop accepting new work during graceful API shutdown.

## Redis spreadsheet worker

Source: [`workers.js`](../workers.js),
[`services/jobs/spreadsheet-sync-queue.js`](../services/jobs/spreadsheet-sync-queue.js)
and [`services/jobs/spreadsheet-sync-worker.js`](../services/jobs/spreadsheet-sync-worker.js).

The API places Google Sheets synchronization work in the durable Redis queue
after the database write succeeds. The `bgsnl-worker` Compose service consumes
it independently of the two API processes. Event, special-event, member,
alumni and internship exports are deduplicated by their affected record or
region, delayed briefly to coalesce rapid updates, and retried up to five times
with exponential backoff. Completed jobs remain available for one day and
failed jobs for seven days for operational inspection.

The append-only data-pool export remains on its existing in-process path until
it has an idempotency key; retrying an append without one could duplicate rows.

## Event draft cleanup

Source:
[`services/background-services/event-draft-cleanup.js`](../services/background-services/event-draft-cleanup.js)

The daily cleanup becomes due at 03:00 in `Europe/Amsterdam`, including daylight
saving time. It checks on startup and every minute, catching up if the API starts
later that day. It starts after database/storage initialization and finishes any
in-flight deletion before shutdown. Failed attempts retry on the next tick.

Only `eventDrafts` records with `status: draft` and a creation date strictly older
than 30 × 24 hours are deleted. The immutable `createdAt` is authoritative;
`metadata.createdAt` is a fallback when that field is absent or null. Drafts
exactly 30 days old, newer drafts, undated records and published events are
retained. Editing a draft does not reset its age. Media files are retained,
because published events can share the same assets.

The last successful day is held only in process memory. A restart or another
server can repeat the idempotent deletion safely; no database logs, delivery
records or permanent Redis keys are created. Only PM2 worker 0 runs this job.

```dotenv
# Enabled by default in production; disabled by default in local development.
EVENT_DRAFT_CLEANUP_ENABLED=true
```

This worker takes effect when the updated API is deployed and started. Adding
it to the repository does not run a cleanup against the live database.

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

## Billing maintenance

Source: [`services/subscriptions/reminders.js`](../services/subscriptions/reminders.js)

The worker performs three bounded tasks on each one-minute tick:

1. **Payment-failure reminders**
   - Reads up to 50 due `BillingAttention` records.
   - Reconciles the current Stripe state before sending anything.
   - Sends the first reminder when the failure becomes due and, if still
     unresolved, a second reminder no earlier than 48 hours later.
   - Atomic claims ensure concurrent API instances do not send the same
     reminder slot twice.
2. **Checkout recovery**
   - Checks up to 25 incomplete Checkout records, oldest first.
   - Completes paid membership checkouts whose initial webhook was missed.
   - Closes expired sessions and removes their stored registration payload.
3. **Subscription reconciliation**
   - Checks up to 25 stale member records and 25 stale alumni records.
   - Refreshes subscription state from Stripe without granting benefits from
     unverified or stale local data.

Configuration:

```dotenv
# Production default: enabled
BILLING_WORKER_ENABLED=true
```

Related persistence:

- `billingattentions` stores reminder timing, attempts, and resolution state.
- `billingrecords` stores Checkout recovery records and distributed leases.

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
- new alumni count per configured city;
- combined city totals and an all-city total;
- an `Unassigned` row when matching records have no usable city.

Counts use `joinDate`. Migrated and archived account copies are excluded. The
report intentionally contains counts only, not member names or email addresses.

Recipients and delivery provider are inherited from the internal notification
configuration:

```dotenv
INTERNAL_NOTIFICATIONS_ENABLED=true
INTERNAL_NOTIFICATION_SUBSCRIBERS=first@example.com,second@example.com

# Optional override. Production defaults to enabled when internal notifications
# are enabled. Set false to stop only this weekly report.
WEEKLY_MEMBERSHIP_REPORT_ENABLED=true
```

Each recipient receives a separate message.

Weekly delivery records have been removed. A process-local schedule guard avoids
repeating a week's sends during the same process lifetime. A restart schedules
only the next future Sunday, not a replay. Only the designated email scheduler
process owns the timer. There is no persistent delivery receipt; manual or
multiple independently configured scheduler processes are not globally deduplicated.

## Operational timers that are not scheduled jobs

These timers support in-flight work and do not initiate periodic business
events:

| Timer | Duration | Purpose |
| --- | --- | --- |
| Billing lease heartbeat | Every 20 seconds while a protected billing mutation runs | Keeps the two-minute distributed lease owned by the active process |
| General email queue timeout | 60 seconds for the legacy provider; 100 seconds for Domakin Mailer | Prevents one delivery from blocking the in-memory mail queue indefinitely |
| Redis spreadsheet-job retry | Five attempts with exponential backoff, beginning at one second | Recovers transient Google Sheets or network failures without blocking API requests |

## Not automatically scheduled

The scripts in `scripts/`, including `send-non-society-final-reminder.js` and
the marketing/backfill utilities, run only when invoked manually. The GitHub
Actions workflow is triggered by pushes and pull requests; it has no cron
schedule. There is currently no operating-system cron or external scheduler
defined in this repository.

## Verification

Run the scheduler-specific tests without sending real email:

```bash
npm run test:weekly-membership-report
npm run test:birthday-emails
node --test tests/event-draft-cleanup.test.js
npm run test:subscriptions
```
