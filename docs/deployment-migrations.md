# Deployment migrations and recovery

The production workflow tests the runner against MongoDB, builds the release,
checks out the tested commit on the VPS, and calls
`bash scripts/deploy-with-migrations.sh`.

## Deployment sequence

1. Acquire the host deployment lock and check the dedicated `bgsnl-storage`
   Redis service. Leave a healthy container untouched; otherwise recreate/start
   only `bgsnl-redis` and wait up to 60 seconds for health. The existing named
   data volume and private configuration are preserved. Build `bgsnl-api` and
   `bgsnl-worker`, then run an authenticated Redis PING from each release image
   while the current containers continue running. Missing configuration, failed
   recovery, or failed connectivity blocks deployment before stopping writers.
2. Save the current container IDs. Stop both services gracefully and verify
   they are stopped. This starts a maintenance window: **the API is unavailable
   during migration and restoration**. All other database writers, including
   manual scripts and other API replicas, must also be stopped.
3. Run every pending numbered migration from the new API image. A database lock
   prevents another migration batch from running concurrently. Before the first
   mutation of a collection, save its documents, indexes, and collection options.
4. Only after every migration and tracking write succeeds, replace the API and
   worker using those same images, with `--no-build`. Verify Redis connectivity
   again inside both running containers before reporting deployment success.

Redis uses `/root/bgsnl-redis/compose.yml` and its private `.env`, with Compose
project name `bgsnl-storage`. Override only the configuration directory with
`BGSNL_REDIS_COMPOSE_DIR` and the health wait with `BGSNL_REDIS_WAIT_SECONDS`.
The official Redis image has no custom build step; recovery uses Compose
`up --build --force-recreate --no-deps --wait`, which also supports a future
build-backed service. It never runs `down -v`, flushes Redis, changes passwords,
or touches Domakin services. Each authenticated connection probe has a seven-second
deadline and prints no credentials or stored data.

If a migration fails, restore the **entire pending batch**, including changes
made by earlier successful migrations, partially completed writes, collection
renames, indexes, and `_migrations` records. Previously applied migrations are
untouched. A nonzero migration exit blocks container replacement even when
rollback succeeds. Restart the exact previous container IDs only after the
runner writes a confirmed `rolled-back` result.

If restoration fails, the runner is killed, or the result cannot be persisted,
leave the API and worker stopped. Preserve the database lock and snapshots for
recovery. Never restart the old services against a partially migrated database.
An image-startup failure after migrations have committed is a separate deployment
failure: it does not automatically undo committed migrations or start old code.

## Logs and audit

Each deployment creates `/root/bgsnl-deploy-logs/run-<UTC timestamp>-<suffix>/`:

- `deploy.log`: build, stop, migration, rollback and container startup output.
- `migrations.log`: complete runner output, also visible in the failed GitHub
  Actions SSH step.
- `result/result.json`: run ID, status, and whether rollback permits the old API
  to resume. `result/rollback.status` exists only after confirmed restoration.
- `previous-containers.txt`: container IDs to use after successful recovery.

The whole rollback system lives in one collection, `migrationJournal`. Its
documents are distinguished by an `_id` prefix and a `kind` field: `lock:deployment`
is the exclusive batch lock, `run:<run id>` records the commit, migration IDs,
failure message/stack/code, snapshot manifest and restoration errors, and
`snap:<run id>:<snapshot index>:<sequence>` holds one snapshotted document each.
A deployment therefore adds exactly one collection to the database. Database
URIs, configured credentials and duplicate-key values are redacted from runner
error records.
Migrations must not log document contents or credentials themselves.

Snapshots are `kind: "snapshot"` documents in `migrationJournal`. Application
migrations cannot enumerate or modify that collection through the supplied
database facade. Restoration rebuilds each collection in place from the journal
rather than staging a temporary collection, so an interrupted rollback is simply
replayed: the journal still holds every document. Successful runs delete their
snapshot documents; failed runs retain them for investigation. After a resolved
failed run has been reviewed, an operator may delete that run id's snapshot
documents. Do not delete snapshots for an unresolved run, or clear a lock to
bypass a failure. Audit records and VPS logs are retained until
explicitly removed. Snapshots contain application data and need the same access
controls as the database; logs on the VPS are private to root.

## Recover an interrupted or failed rollback

Review the original error and `rollbackErrors` first. Resolve the cause (for
example database availability, permissions or free space). Recovery replays the
saved snapshots; it does not rerun the failed migration.

On the VPS, hold the same host lock throughout recovery and restart. Stop all
writers and ensure **no migration/recovery container is still running**. The
database lock intentionally has no timeout: an operator must confirm that the
previous runner has exited before taking over. Use the same release image and
the exact run ID from the failed deployment:

```sh
cd /root
exec 9>/root/bgsnl-deploy-logs/deploy.lock
flock -n 9 || exit 1
docker compose stop -t 90 bgsnl-api bgsnl-worker
# Inspect docker ps and stop any surviving one-off migration runner first.
docker compose run --rm --no-deps -T bgsnl-api \
  node migrations/run.js --writers-stopped --recover=<run-id>
```

Proceed only if recovery exits zero and reports `status: "rolledBack"` with
`safeToResume: true`. Restart the IDs recorded in that deployment's
`previous-containers.txt` using `docker start`, then fix the migration and deploy
again. A result of `succeeded` means the batch had already committed before the
interruption; deploy that release's new API/worker instead of starting old code.
Keep the lock until the recovery/startup sequence is complete, then close the
shell or run `flock -u 9`.

For a direct runner invocation, stop writers first and pass
`node --env-file=.env.prod migrations/run.js --writers-stopped`.
Use the deployment script for normal deployments so the stop, gate and restart
steps cannot be accidentally omitted. A failed runner always exits nonzero,
including when its automatic rollback was successful.

## Migration authoring and limits

Use only the supplied `db` argument, and await every operation. Do not import
application models, create separate database clients, or start detached tasks.
Do not call Stripe, email, Sheets, Redis or other external services: those side
effects cannot be restored by a MongoDB journal. The facade allows the collection
read/write, rename, index and create/drop operations used by migrations 001–010;
unsupported operations fail before proceeding. Extend it with tests before
adding new operation types.

This is a durable snapshot journal, not a MongoDB transaction: existing
migrations include collection renames and index changes. Rollback requires a
reachable database and enough storage for snapshots and temporary restoration.
Nonstandard collections (views, time series, clustered or encrypted collections)
are rejected before mutation. Snapshot/restore checks counts and preserves BSON
types and indexes; it cannot protect against other writers ignoring maintenance.
MongoDB TTL expiration must also be quiesced by the database operator if a touched
collection has a TTL index and exact retention of expiring documents is required.
Keep independent database backups for disaster recovery.

Host defaults can be changed using `BGSNL_COMPOSE_DIR` and
`BGSNL_DEPLOY_LOG_DIR`. The VPS needs Bash, `flock` (util-linux), Docker Compose,
permission to stop/build/start the two services, and a database user permitted
to create, copy, rename, index and drop collections. Snapshot writes go to the
journal, which has no schema validator, so `bypassDocumentValidation` is not
required; it is requested only when restoring into a collection that carries a
validator of its own. Granting `readWriteAnyDatabase` alone is enough for a
database whose collections have no validators. The result directory is
owned by UID 1000, matching the API Dockerfile's `node` user.

## Tests

```sh
BGSNL_MIGRATION_TEST_URL=mongodb://127.0.0.1:27017 npm run test:migrations
```

The integration tests accept only a loopback MongoDB URI without a database
name. Each test creates and deletes its own random `bgsnl_migration_test_*`
database. They never load production credentials. Without that environment
variable, integration tests are skipped; CI supplies a disposable MongoDB 7
service so rollback tests are mandatory before deployment.
