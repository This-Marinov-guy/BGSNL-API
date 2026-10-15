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
| `integrations` | Provider request outcomes, exceptions, and live checks for email delivery, Stripe, WordPress, Google Sheets, Google Calendar, Cloudinary, AWS S3, and GitHub sitemap dispatch |

`AXIOM_WEB_DATASET`, `AXIOM_OPERATIONS_DATASET`, and
`AXIOM_INTEGRATIONS_DATASET` can override these names. The three names must be
different and must exist in Axiom. The legacy `AXIOM_DATASET` setting does not
configure this three-dataset view. API ingestion requires `AXIOM_TOKEN`. `AXIOM_ORG_ID` is only required
for a legacy personal token; Axiom API tokens identify their organization and
the API ignores `AXIOM_ORG_ID` for those tokens. The
token must be able to ingest into all three datasets in that organization. A
token for a different organization can appear valid while writes fail with
`dataset not found`. The token never reaches the browser. For dashboard reads,
set `AXIOM_QUERY_TOKEN` to a read-only token with Query Read permission for the
three datasets. If omitted,
the API tries the ingest token; an ingest-only token will show Axiom as
unavailable without hiding the service health checks.
Local dev has no Axiom query token by default, so the card shows `not configured`
instead of reporting a provider outage. Query failures distinguish denied access,
missing datasets, and other failures. Individual cards expand to show their
latest check and details.

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

Completed provider requests also record `type=request` in `integrations`, with
provider, fixed operation name, direction, outcome, HTTP method/status when
available, and duration. This includes successful Stripe SDK calls, email handoffs, WordPress
and Sheets calls, Calendar operations, Cloudinary media calls, ticket image
downloads, S3 ticket uploads, and GitHub sitemap dispatches. Wrapped provider calls record network failures
as failed outcomes even when there is no HTTP status. Request URLs, resource IDs, email
addresses, headers, payloads, and response bodies are never included. Stripe
SDK retries may produce more than one request record for one application call.
Inbound Atlas, Google Scripts, Koko, and WordPress API requests also appear as
`direction=inbound` with fixed operation names. Their path parameters, query
strings, credentials, and bodies are omitted. Other API traffic remains in
`operations`; private payment, wallet, support, and monitoring routes remain
excluded from general request logging.

## Health checks

Opening or refreshing the dashboard performs read-only checks. API checks its
database connection; Redis uses PING; Mailer calls `/health` and uses the
Bulgarian Society Mailtrap transport and template readiness in that response;
unrelated Mailer email channels do not determine this card's health. Stripe reads its
balance; WordPress reads a one-post listing; Google Sheets reads spreadsheet
metadata; Cloudinary uses its ping API; AWS S3 uses HeadBucket on the configured
ticket buckets. Checks have a five-second display timeout. S3 or provider
responses that reject the probe's permissions show `unverified`, not healthy.
The page displays the latest check, not a continuous uptime guarantee.
Each Axiom and service health panel shows the completion time of its latest
check. An unavailable Axiom dataset does not hide other service checks.

## Usage

The Usage tab is read-only and restricted by the same monitoring role
check. It loads independently from service health and caches provider results
for five minutes; Refresh requests a new reading. A provider failure leaves the
other quota cards available. Reference limits are labeled and must not be read
as confirmed account-plan limits.

- Cloudinary uses the [Admin API `usage` response](https://cloudinary.com/documentation/admin_api#usage) for rolling 30-day credits
  and its reported limit.
- Mailtrap uses the Bulgarian Society Mailer's scoped, read-only quota endpoint.
  Configure `MAILER_API_URL` and the shared `MAILER_BULGARIANSOCIETY_SECRET` in
  the API runtime, and deploy the Mailer monitoring route. The local `dev:all`
  launcher injects both settings in memory.
  It reads the Mailtrap account Stats API for the current billing cycle when
  `MAILTRAP_BGSNL_BILLING_DAY` (1–28) is configured; otherwise the monthly
  count is labeled a calendar-month estimate. It also reads today's count
  against the free-plan 150-email daily reference. When
  Mailtrap does not return a sent count, delivered plus bounced is shown as an
  estimate. The [4,000-email free-plan allowance](https://mailtrap.io/pricing/) is a reference; set
  `MAILTRAP_BGSNL_MONTHLY_LIMIT` in the Mailer to record the account's actual
  monthly limit and `MAILTRAP_BGSNL_DAILY_LIMIT` for its daily limit.
  `MAILTRAP_BGSNL_STATS_TOKEN` can supply a separate token with
  Stats API read access; otherwise the Mailer tries its existing BGSNL token.
- MongoDB uses `dbStats` for the connected database's data plus indexes. It
  compares with the [Atlas M0 0.5 GB free-plan reference](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/); other databases and
  the cluster tier are not observable through this connection. Set
  `MONGODB_FREE_STORAGE_LIMIT_BYTES` when the account limit is confirmed.
- AWS S3 uses the account-level [GetFreeTierUsage API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_freetier_GetFreeTierUsage.html), showing every active S3
  offer returned by AWS. The configured AWS key needs
  `freetier:GetFreeTierUsage` and billing view access for those allowances. When
  billing access is missing or no offer is active, the API lists the configured
  application buckets and shows current-object bytes and count without a
  limit. That reading needs `s3:ListBucket` on each bucket and does not include
  older object versions, other buckets, or account-wide request and transfer usage.
- WordPress.com reads the configured site's [`quota` field](https://developer.wordpress.com/docs/api/1/get/sites/%24site/) from its site API.
  When total and used or available storage are reported, the page shows used,
  total, and available media space.
  If the public response omits it, the card shows the public published-post count
  from the WordPress REST API. That count is content usage, not media storage.
  Configure a site-authorized `WORDPRESS_API_TOKEN` to request the storage quota;
  the provider may still withhold it.

## Background jobs

The monitoring page shows a failed-jobs banner for retained BGSNL job failures.
The All jobs tab combines the durable spreadsheet sync and marketing-capture queues in Redis with `monitoringjobs` history in MongoDB. Scheduler runs and in-process mail and Sheets work are recorded there with safe job names, status, attempt count and timestamps. The queue view filters records by failed, pending, or completed
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

The separate Domakin Mailer owns its delivery queue. BGSNL logs the handoff
or dispatch result to Axiom; delivery jobs after handoff are inspected in the
Mailer service. Existing failures also surface in the operations and
integrations Axiom datasets.

Set `MAILER_HEALTH_URL` if Mailer's health path differs from `/health` on
`MAILER_API_URL`. AWS HeadBucket requires `s3:ListBucket` on the checked
buckets; this permission is needed only to verify the bucket without writing.

Run focused tests with `node --test tests/monitoring.test.js`.
