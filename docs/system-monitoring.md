# System monitoring

The administration page at `/user/dashboard/monitoring` is available to active
accounts with `developer`, `admin`, or `super_admin`. The API enforces the same
roles for `GET /api/v1/monitoring/overview`; page visibility alone is not the
access control. The developer role is protected in account editing and must be
assigned through the existing privileged account process.

## Axiom datasets

The site uses three event datasets:

| Dataset | Contents |
| --- | --- |
| `web` | Page views, browser errors, and Next.js server errors |
| `operations` | API request summaries, endpoint 5xx errors, service and worker exceptions, Stripe webhook deliveries and processing errors, API and Redis checks |
| `integrations` | Provider exceptions and live checks for Mailer, Stripe, WordPress, Google Sheets, Cloudinary, and AWS S3 |

`AXIOM_WEB_DATASET`, `AXIOM_OPERATIONS_DATASET`, and
`AXIOM_INTEGRATIONS_DATASET` can override these names. The three names must be
different. API ingestion requires `AXIOM_TOKEN` and `AXIOM_ORG_ID`. The token
never reaches the browser. For dashboard reads, set `AXIOM_QUERY_TOKEN` to a
read-only token with Query Read permission for the three datasets. If omitted,
the API tries the ingest token; an ingest-only token will show Axiom as
unavailable without hiding the service health checks.

Production ingestion is on unless `AXIOM_LOGGING_ENABLED=false`. Local
development ingestion is off; to test it deliberately, set
`AXIOM_LOGGING_ENABLED=true` outside the standard local launcher. The launcher
keeps this off so UI tests do not send synthetic records to Axiom. Unit tests
never ingest.

Website errors are sent to the website's same-origin event route, then to a
server-key-protected API route. Events have fixed fields. Request bodies,
cookies, tokens, email addresses, client IPs and full URLs with query strings
are excluded from Axiom. API traffic logs use only method, normalized path,
status and duration. Private payment, wallet, support and monitoring routes
remain excluded from generic traffic logging.

Service catches that return a fallback or continue in the background record a
sanitized error in `operations`. Failures from external providers record one in
`integrations`. Error events include a source, error name, validated error code,
and HTTP status when present; raw exception messages and stacks stay out of
Axiom. Fatal process exceptions are recorded on a best-effort basis before Node
terminates. Expected validation and business-rule responses are not exceptions.

## Health checks

Opening or refreshing the dashboard performs read-only checks. API checks its
database connection; Redis uses PING; Mailer calls `/health`; Stripe reads its
balance; WordPress reads a one-post listing; Google Sheets reads spreadsheet
metadata; Cloudinary uses its ping API; AWS S3 uses HeadBucket on the configured
ticket buckets. Checks have a five-second display timeout. S3 or provider
responses that reject the probe's permissions show `unverified`, not healthy.
The page displays the latest check, not a continuous uptime guarantee.

## Background jobs

The monitoring page shows a failed-jobs banner for retained BGSNL job failures.
The All jobs tab combines the durable spreadsheet sync and marketing-capture queues in Redis with a
privacy-minimal MongoDB history of scheduler runs, in-process mail dispatch,
and in-process Sheets work. It filters records by failed, pending, or completed
status. Pending includes waiting, delayed, and active work. Jobs are paged 20
at a time, up to the latest 1,000 entries; counts cover all retained entries.
Only job type, state, attempt count, timestamps, and validated error name
are returned; job payloads, failure messages, and stack traces stay on the
server. Failed jobs remain for
seven days and completed jobs for one day. If one source is unavailable, the
page shows the other source with an incomplete-data notice. A job source outage
does not hide the rest of System Monitoring.

Marketing capture runs in the API process as a BullMQ consumer (started after
MongoDB/Redis initialization). Once enqueued, jobs survive API restarts using
the existing Redis persistence configuration. Each capture gets an initial
attempt plus three retries, with exponential delays of 1, 2, and 4 seconds.
Each attempt has a 10-second deadline and MongoDB queries have a 5-second
server execution limit. Enqueueing has a 5-second deadline as well. Redis must
use persistence and `noeviction`, as for the existing spreadsheet queue.

An attempt timeout cannot retract a database command already sent; normalized
email/city uniqueness and the original consent timestamp make retries safe.
The same or older opt-in does not replace newer consent or re-enable an
unsubscribe on that recorded consent. Payloads contain only the email, city,
and consent evidence; monitoring never returns them. Retention is capped at
1,000 completed and 1,000 failed jobs as well as the age limits above.

Automatic capture still happens after successful opted-in form responses. If
Redis is unavailable before it accepts a job, enqueue failure is logged but the
successful form is preserved; there is no transactional outbox for that gap.
The explicit `/common/marketing-email` endpoint remains synchronous so it only
acknowledges consent after the database write succeeds. This policy does not
change retries for other background job types or replay historical failures.

Test with `APP_ENV=dev AXIOM_LOGGING_ENABLED=false node --test tests/marketing-*.test.js`.
For the opt-in Redis integration test, also set `BGSNL_STORAGE_TEST_REDIS=true`
and use an isolated local Redis database (for example `BGSNL_REDIS_URL=redis://127.0.0.1:6380/15`).
The integration test uses synthetic payloads and a random key prefix, not MongoDB.

The separate Domakin Mailer owns its delivery queue. BGSNL records the handoff
or dispatch result locally; delivery jobs after handoff are inspected in the
Mailer service. Existing failures also surface in the operations and
integrations Axiom datasets.

Set `MAILER_HEALTH_URL` if Mailer's health path differs from `/health` on
`MAILER_API_URL`. AWS HeadBucket requires `s3:ListBucket` on the checked
buckets; this permission is needed only to verify the bucket without writing.

Run focused tests with `node --test tests/monitoring.test.js`.
