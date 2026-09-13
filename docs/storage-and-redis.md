# Account storage and BGSNL Redis

MongoDB holds accounts and application content. Google identities and registered
passkeys are embedded in `users.identities` / `users.passkeys` and the same fields
on `alumniusers`. Credential fields are excluded from normal queries and JSON
responses. Member/Alumni switches move those fields, preserve old account IDs as
aliases, and delete the source profile in the same transaction. Archived copies
are no longer created.

| Data | Location | Lifetime |
| --- | --- | --- |
| Google identity, passkey public key/counter/handle | Current member or alumni document | Until disconnected/removed |
| Current membership entitlement snapshot | Account `subscription` | Refreshed from Stripe |
| Invoices, charges, refunds, transfers, fees and regional allocation | Stripe | Stripe history; no Mongo billing ledger |
| A pending transfer/reversal instruction | Stripe invoice metadata | Cleared after reconciliation |
| Refresh tokens (hashes), session generations/revocation | Redis | Session deadline: 30 days from login, then one hour after recorded activity; reads alone do not extend it |
| Rate-limit buckets | Redis | Original fixed-window expiry |
| Public counts/event caches | Redis | 24 hours |
| Pending checkout registration and coordination state | Redis | 30 days from reservation; completed state expires 30 days after completion |
| Current payment-reminder job | Redis | 30 days from episode start; resolution shortens this to at most one more day |
| Payment-return capability | Redis | Seven days |
| Google/passkey ceremonies, password resets and profile confirmations | `temporarycodes` | 5 minutes / 15 minutes / 1 hour |
| Transaction fencing markers | `temporarycodes` | One day after use |

Every Redis write has an expiry. The record store rejects missing or invalid
deadlines and cannot create a permanent key. Checkout polling and reminder retries
do not renew retention. A new checkout gets a new reservation deadline. Billing
leases expire after two minutes without their owner's heartbeat; caches and
active sessions can be renewed only through their existing write/activity flows.
Expired reminder jobs are not recreated for the same failure episode: the current
episode ID remains part of the account's subscription until recovery or cancellation.

The checkout recovery window is 30 days. If a paid registration is still unfulfilled
when that window ends, its temporary registration data is deleted and recovery
requires manual assistance. Stripe payment history remains available. Legacy pending
registrations receive one 30-day grace period when migrated, preserved on reruns.

The few tokens that must be consumed atomically with account writes stay in
`temporarycodes`, with namespaced IDs and a TTL index. Redis cannot participate
in a MongoDB transaction. Tiny expiring transaction markers also prevent a
worker that lost its Redis lease from overwriting a newer account update.

No birthday, weekly-report or event-announcement delivery collections are used.
Their scheduler guards are process-local and store no outcomes. As requested,
removing durable delivery tracking means process restarts/multiple enabled
workers can repeat an email; event completion still uses its existing marker.
Only PM2 worker 0 starts these email schedules. Across multiple API containers,
enable them on one container only. Restarts can still repeat an unfinished send.

## Local development

Redis runs natively on the development machine, bound to `127.0.0.1:6380`.
Docker and a VPS connection are not required. Install the executable once with
`brew install redis` on macOS (or your Linux distribution's Redis package).

Set these values in `BGSNL-API/.env`:

```dotenv
BGSNL_REDIS_URL=redis://127.0.0.1:6380/0
BGSNL_REDIS_PREFIX=bgsnl:development:v1:
```

`npm run dev` in the API and `npm run dev:all` in the website ensure Redis is
reachable before starting the API. If the default local instance is stopped,
they start it. A custom URL must already be reachable; it is never replaced with
a different instance. Set `BGSNL_REDIS_SERVER` when the executable is not on PATH.

Standalone commands, run from `BGSNL-API`:

```sh
npm run redis:start
npm run redis:status
npm run redis:stop
npm run test:redis
```

The Redis integration suite uses local database 15 and unique temporary key
prefixes; it cleans up its own test keys afterward.

Data and configuration live in the git-ignored `.local/redis/` directory, with
append-only persistence, a 128 MiB limit and `noeviction`. All application TTLs
remain enforced. Redis stays running when the API stops; stopping Redis preserves
its data. The stop command refuses to stop an unrelated instance on port 6380.
This setup isolates Redis; the existing MongoDB and Stripe configuration is
unchanged. Do not delete the local data directory while testing pending checkouts.

## VPS container

The verified production host is available through the existing SSH alias
`vps.domakin.nl`. Its `bgsnl-api` container serves `kanatitsa.bulgariansociety.nl`.
The BGSNL hostname itself currently fails SSH host-key checking; use the trusted
alias rather than disabling host-key verification.

Dedicated configuration directory: `/root/bgsnl-redis`.

- `compose.yml`: dedicated Redis service and `bgsnl-storage` network.
- `docker/redis.conf`: authenticated Redis, append-only persistence with
  `appendfsync always`, 256 MiB data limit and `noeviction`.
- `.env`: private Redis password, mode `0600`.
- `bgsnl-api.env`: private API connection URL and key prefix, mode `0600`.
- `docker/api.redis.override.yml`: API environment/network integration. Applying
  this override requires the migrated API; it is not automatically activated.

Redis's host port is bound to **127.0.0.1:6380**, not the public interface. The API
uses `redis://default:<password>@bgsnl-redis:6379/0` over the private Docker network.
The existing `/root/docker-compose.yaml` remains the base configuration.

```sh
docker compose --project-name bgsnl-storage --env-file /root/bgsnl-redis/.env -f /root/bgsnl-redis/compose.yml up -d --wait
```

API-only environment keys:

```dotenv
BGSNL_REDIS_URL=redis://default:<password>@bgsnl-redis:6379/0
BGSNL_REDIS_PREFIX=bgsnl:v1:
```

Do not put either key in the Next.js public environment or Vercel client bundle.
For a local Redis instance, use its localhost URL and a separate prefix such as
`bgsnl:development:`. Cache reads fall back to their source on failure; auth and
billing coordination fail closed. Redis data is operational state, not a
throwaway cache: do not flush it or use an eviction policy. Back up its persistent
volume along with MongoDB. Lost pending registrations cannot be reconstructed
from Stripe, because password hashes are deliberately never sent to Stripe.

## Migration and cutover

### Production cleanup completed — 11 September 2026

All 16 obsolete collections listed below were removed from the live database.
Credentials were embedded in the current accounts and live temporary state was
moved to the VPS Redis container. The private pre-migration backup is
`/root/bgsnl-storage-cutover-20260911/database-before.ejsonl` (mode `0600`).

The production website still uses the older API, which does not reference those
collections. A narrow compatibility image preserves embedded credentials during
its existing account switches, excludes them from API responses, and expires
new legacy temporary codes. Its source snapshot and image are retained in
`/root/bgsnl-storage-cutover-20260911/legacy-source-before.tgz` and
`root-bgsnl-api:pre-storage-20260911`; the running compatibility image is
`bgsnl-api:storage-compat-20260911`. The same compatibility files were applied to
`/root/bgsnl-api` for subsequent builds. The full new API/frontend release remains
separate from this completed collection cleanup.

This cutover used `--keep-archived-accounts`: eight historical documents remain
inside `users`/`alumniusers` because the legacy website still looks up those IDs.
The separate `accountmigrationarchives` collection was deleted. Once the new
API supports aliases in production, run the migration without that flag to
remove the eight historical documents. Local development uses the dedicated
local Redis instance described above now that the separate collections are gone.

**The production Mongo database is named `test`. It is not a disposable test DB.**
The migration defaults to a read-only plan and requires an explicit database.

```sh
node scripts/migrate-account-storage.js --database=test
```

Before applying, install/build the new API version, ensure Redis is healthy,
and stop every old API writer, including local development instances connected
to this database. Keep all worker-enable flags unchanged. The Atlas event
announcement trigger must remain disabled.

```sh
node scripts/migrate-account-storage.js --database=test --apply --writers-stopped --drop-legacy --backup=/secure/bgsnl-storage-before.ejsonl
```

The script exclusively creates a `0600` EJSON backup, preserves active refresh
sessions, payment-return tokens and checkout reservations in Redis, embeds
credentials, merges missing historical profile data and arrays, preserves
aliases, verifies copies, creates account uniqueness/TTL indexes, then removes
the obsolete collections and archived source documents. Passwords, roles and
current billing state are never restored from an old archive. Conflicting
owners or changed records stop the migration before collection removal. A failure
during the final deletion phase may leave some collections already removed;
inspect the backup and resolve conflicts before resuming. Completed webhook
receipts are exported to Stripe before expired Redis state is discarded.

Removed collections: `accountidentities`, `passkeycredentials`,
`passkeychallenges`, `authchallenges`, `authratelimits`,
`passwordresetchallenges`, `profilechanges`, `refreshsessions`, `paymentreturns`,
`billingrecords`, `billingattentions`, `memberrevenueshares`,
`birthdayemaildeliveries`, `weeklymembershipreportdeliveries`,
`eventannouncementdeliveries`, `accountmigrationarchives`.

After migration, start the new API with both Compose files:

```sh
docker compose -f /root/docker-compose.yaml -f /root/bgsnl-redis/docker/api.redis.override.yml up -d --no-deps bgsnl-api
```

Use those same two files for subsequent deployments. Do not restart the old API
against migrated data. Rollback requires stopping writers, restoring the EJSON
backup into its original collections, and then restoring the previous API image;
retain Redis until the rollback is verified. Never perform a blind restore over
new account writes or replay already-completed Stripe transfers.

## Verification

The isolated Mongo replica-set tests cover cross-collection credential
uniqueness, atomic one-time challenge consumption, real signed passkey login
after Member/Alumni movement, profile preservation and archive removal. Redis
integration tests cover CAS concurrency, TTL, refresh rotation, logout, lease
loss and cache behavior. Migration tests rehearse the backup, copying, verification
and actual collection removal on synthetic local data. Stripe tests cover
renewals, Alumni credits, partial/full refunds, disputes, fee adjustments and
recovery after an ambiguous transfer with a completely rebuilt in-memory state.

Stripe reconstruction uses paginated subscriptions/invoices/transfers and reuses
existing Stripe report runs. Pending instructions and transfer-group searches
protect retries beyond the API's idempotency-key retention window. See
[Stripe idempotency](https://docs.stripe.com/api/idempotent_requests) and
[Redis lock ownership](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/).
