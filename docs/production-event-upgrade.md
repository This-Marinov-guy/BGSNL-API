# Active production event upgrade (007)

`007-upgrade-production-events` adapts **only active documents** in `events` to
the current event schema. Active means status `opened`, `closed`, or
`temporary closed`, with `correctedDate` (when present) or `date` at or after the
run's start time. This follows the dashboard's effective-date boundary, not
simply `status: opened`: past opened events are excluded. Closed ticket sales
do not exclude an upcoming event. Drafts, archived and cancelled events are
excluded; invalid/unknown event statuses and undated events are not guessed.

Inactive records are read to reserve existing regional slugs, but are not
normalized, updated or given per-event backups. Historical slugs are preserved;
missing historical slugs are **not** backfilled. No events are published or created.

The existing migration runner discovers 007 automatically after 001–006. The
deployment workflow invokes that runner before replacing the API container.
The standalone command below provides a read-only preview of this migration.

Production had no recorded migrations at the time of inspection. The event
branches of pending migrations 003 (region cleanup) and 005 (background cleanup)
also use the active-only filter so they cannot change historical events ahead
of 007. Their existing behavior for other collections is unchanged. Migration
006 changes collection-wide indexes, not historical document fields. Previously
applied migration IDs are still skipped; this does not undo earlier migrations.

## Changes

- Assign missing slugs with the same region, date-suffix and collision rules as
  event publication. Reserve existing slugs, including archived event URLs.
  Keep existing slugs and legacy ID links working.
- Normalize `breda`/`bread` to `breda_tilburg` and remove obsolete backgrounds.
  These operations are also covered by 003 and 005; repeating them is harmless.
- Finish migrating `lastUpdate` into `metadata`, preserving existing metadata
  and creation timestamps. Unknown creators remain null.
- Convert explicitly zoned early/late-bird, promotion and promo-expiry ISO
  timestamps to BSON dates and remove empty timer strings. Null/missing optional
  promotion dates remain unbounded (immediate start/no expiration). Ambiguous,
  malformed or impossible calendar timestamps block preflight.
- Fill missing disabled-stage flags, member-promotion discount (0), mandatory
  add-on flag (false), promo-code arrays and promo-code configuration defaults.
  Missing promo audiences become `guest` and `member`, matching the current API
  fallback. Existing explicit audience lists remain unchanged.

Prices, Stripe product/price/coupon IDs, promo spelling and limits, guest lists,
attendance, refunds, ticket images, questionnaire answers, event status and sale
closing settings are preserved. No announcements are queued. No Stripe, email,
Google Sheets or calendar calls are made.

Legacy global promo codes remain global (`customerScoped: false`). Restricting
them in Stripe requires editing the code through the normal application flow;
the migration does not claim a global code has become customer-restricted.
Missing optional active-member prices are left missing so existing price
fallbacks continue to apply; no ticket price is invented.

## Preview and application

Run from `BGSNL-API`, with the intended database configuration:

```sh
node --env-file=.env.prod scripts/audit-production-events.js
node --env-file=.env.prod scripts/upgrade-production-events.js --dry-run
```

The audit checks active event fields against the current Mongoose model before
and after normalization, reports the required field changes, and checks migration
records and regional slug indexes. It prints counts and validation paths, never
attendee data or field values. Model validation applies Mongoose casts/defaults;
it is not a verification of Stripe products, media URLs, calendar entries, or
attendee records. Neither command contacts those external services.

Omitting `--dry-run` from the upgrade command has the same read-only behavior. It does not create backup
collections, change indexes, or write migration tracking records.

After reviewing the preview, the normal deployment stops API/worker writers and
runs all pending migrations through the guarded deployment script. For a manual
invocation, first stop all database writers:

```sh
node --env-file=.env.prod migrations/run.js --writers-stopped
```

For a standalone application of 007, first ensure migrations 001–006 have run
(particularly the regional slug index), then use:

```sh
node --env-file=.env.prod scripts/upgrade-production-events.js --apply --writers-stopped
```

Application refuses to proceed unless the regional partial unique slug index
exists and the legacy global unique slug index has been removed by 006. The
standalone apply command also requires explicit maintenance acknowledgement.
Prefer the guarded deployment runner for whole-batch rollback. The full runner
also executes unrelated pending account/support migrations; review those
separately before deployment.

The standalone command does not mark `_migrations`; a subsequent deployment
will run 007 again, find no remaining changes and record it. Repeating the
migration is safe. Stop administrative event edits and older API writers during
application; older code could reintroduce legacy fields after migration.

## Backup and concurrency

The deployment runner wraps the full batch in a durable snapshot journal. If any
migration fails, it restores all changes from that batch, including 007 and its
backup collection, and blocks the API update. See [deployment migrations and
recovery](deployment-migrations.md) for the maintenance window, logs and recovery.

The following per-event behavior also applies to the standalone script, which
does **not** have the deployment runner's automatic whole-batch rollback.

The full active-event plan is validated before any write. Each affected event then gets a
backup in `eventProductionUpgradeBackups` before its atomic update. The backup
contains the original affected top-level fields, originally missing fields, and
the planned field-level update. Guest lists and attendee contacts are excluded.
Existing backup entries are never overwritten on retries.

Updates compare the original affected fields, status, effective-date inputs and slug inputs with the current
database record. A concurrent change stops the run instead of overwriting it.
Concurrent guest-list additions are unaffected. When running the standalone script, there is no collection-wide
transaction: if a later update fails, earlier successful updates remain and a
rerun processes the remaining records. The guarded deployment runner instead
restores the entire pending batch on failure.

Before manual restoration, compare each backup's update with the current event
and confirm which fields were actually migrated. A backup may exist for an
update that subsequently failed. Restore only the applicable migration changes,
never overwrite later administrative edits or replace the entire document.

## Production preflight, 27 September 2026

Read-only inspection using `.env.prod` found 91 events (84 archived, 7 opened).
At 20:48 UTC, **1 was active** and 90 were excluded (84 archived and 6 past
opened events). The active-only audit completed with 1 pending document,
zero current/normalized schema-validation errors and **0 modified**:

| Change | Events |
| --- | ---: |
| Missing regional slug | 1 |
| Member-promotion discount default | 1 |
| Remove the three obsolete background fields | 1 |
| Legacy metadata conversion/removal of `lastUpdate` | 1 |
| Remove empty early-bird expiry and late-bird start | 1 |

Production still has the old global unique slug index, not the regional index;
006 must run before applying 007. No event migrations are recorded as applied.
The active event needs no price, Stripe ID, region, add-on or promo-code changes.
Its promotion dates are already null and are preserved. No production changes
were applied. This report is a point-in-time observation, not a frozen list of
IDs; eligibility and pending changes are recalculated at execution time.

Verification: 111 tests passed, including the full migration/rollback sequence
against a disposable local MongoDB 7 database and preservation of historical
event documents. Changed JavaScript files also pass ESLint.

Focused regression command:

```sh
node --test tests/event-production-upgrade.test.js tests/event-production-audit.test.js tests/normalize-breda-region.test.js tests/event-slugs.test.js tests/event-metadata.test.js tests/ticket-pricing.test.js tests/event-promo-codes.test.js tests/promotion-scheduling.test.js
```
