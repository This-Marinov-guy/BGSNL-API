# Production event upgrade (007)

`007-upgrade-production-events` adapts existing documents in `events` to the
current event schema. It covers archived and open events, so historical links
remain stable. It does not publish drafts or create new events.

The existing migration runner discovers 007 automatically after 001–006. The
deployment workflow invokes that runner before replacing the API container.
The standalone command below provides a read-only preview of this migration.

## Changes

- Assign missing slugs with the same region, date-suffix and collision rules as
  event publication. Reserve existing slugs, including archived event URLs.
  Keep existing slugs and legacy ID links working.
- Normalize `breda`/`bread` to `breda_tilburg` and remove obsolete backgrounds.
  These operations are also covered by 003 and 005; repeating them is harmless.
- Finish migrating `lastUpdate` into `metadata`, preserving existing metadata
  and creation timestamps. Unknown creators remain null.
- Convert explicitly zoned early/late-bird ISO timestamps to BSON dates and
  remove empty timer strings. Ambiguous or malformed timestamps block preflight.
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
node --env-file=.env.prod scripts/upgrade-production-events.js --dry-run
```

Omitting `--dry-run` has the same read-only behavior. It does not create backup
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
node --env-file=.env.prod scripts/upgrade-production-events.js --apply
```

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

The full plan is validated before any write. Each affected event then gets a
backup in `eventProductionUpgradeBackups` before its atomic update. The backup
contains the original affected top-level fields, originally missing fields, and
the planned field-level update. Guest lists and attendee contacts are excluded.
Existing backup entries are never overwritten on retries.

Updates compare the original affected fields and slug inputs with the current
database record. A concurrent change stops the run instead of overwriting it.
Concurrent guest-list additions are unaffected. When running the standalone script, there is no collection-wide
transaction: if a later update fails, earlier successful updates remain and a
rerun processes the remaining records. The guarded deployment runner instead
restores the entire pending batch on failure.

Before manual restoration, compare each backup's update with the current event
and confirm which fields were actually migrated. A backup may exist for an
update that subsequently failed. Restore only the applicable migration changes,
never overwrite later administrative edits or replace the entire document.

## Production preflight, 22 September 2026

Read-only inspection using `.env.prod` found 90 events (84 archived, 6 opened).
The dry run completed with 90 pending documents and **0 modified**:

| Change | Events |
| --- | ---: |
| Missing regional slug | 90 |
| Member-promotion discount default | 90 |
| Remove obsolete background fields | 90 |
| Missing promo-code arrays | 13 |
| Existing promo-code configuration defaults | 2 |
| Mandatory add-on default | 16 |
| Breda region normalization | 13 |
| Legacy metadata conversion | 2 |

Seven bird timers are zoned ISO strings converted to dates; 211 empty timer
fields are removed. Counts for region/background cleanup may be lower when 003
and 005 have already run. This report describes the observed production records,
not a frozen list of IDs; the deployment preflight uses the records then present.

Verification:

```sh
node --test tests/event-production-upgrade.test.js tests/event-slugs.test.js tests/event-metadata.test.js tests/ticket-pricing.test.js tests/event-promo-codes.test.js
```
