# Event metadata

New event drafts and published events store an embedded `metadata` object:

```json
{
  "createdBy": "authenticated-account-id",
  "createdAt": "2026-09-14T10:00:00.000Z",
  "updatedBy": "authenticated-account-id",
  "updatedAt": "2026-09-14T10:00:00.000Z"
}
```

IDs are strings; timestamps are MongoDB Date values (UTC). The API obtains IDs from the authenticated account and generates timestamps server-side. Request-body metadata is never used for attribution. On creation, both actor fields identify the creator. Edits update only the latest editor and time. Publishing a draft preserves its original creator and creation time; the publishing account becomes the latest editor. Archiving also records the acting account.

Existing records acquire metadata on their next administrative save. Their existing creation timestamp and, for drafts, original owner ID are retained. An unknown historical creator stays `null`; the latest editor is not assumed to be the original creator. No bulk database migration is performed.

The top-level `createdAt` remains for compatibility. The old `lastUpdate` field is removed; exports and the sitemap use `metadata.updatedAt`. Public event responses expose only `metadata.updatedAt`, never account IDs. Background ticket and payment changes do not overwrite event editor attribution. No new collection or history log is created.

Validation: `node --test tests/event-metadata.test.js tests/event-drafts.test.js`.

To migrate existing events and drafts, run `node scripts/migrate-event-metadata.js` for a count preview, then add `--apply`. It uses the configured database, preserves existing metadata, copies legacy update details into missing metadata fields, and removes `lastUpdate`. Each document is updated atomically. Run again after deploying the API if older API instances were still writing during migration.
