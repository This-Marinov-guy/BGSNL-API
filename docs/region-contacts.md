# Regional contact directory and weekly report

## Database directory

`regionContacts` holds one document per region, keyed by `_id` (for example
`groningen`), with `email`, `createdAt` and `updatedAt`. Migration
`012-region-contacts` seeds the eight regional inboxes plus `netherlands` and
`support`. It is additive and preserves existing database edits on reruns.

Apply this migration through the existing reviewed migration/deployment workflow
before publishing the website change. The migration runner requires stopped
writers and journals changes for rollback. Do not run all pending migrations
against production without reviewing them. No database migration is run merely
by starting the website or API.

The public, read-only `GET /common/region-emails` endpoint returns
`{ emails: { region: email } }`. It exposes only known keys and valid addresses.
There is no public write endpoint. Update contacts through an authorized database
operation, updating `updatedAt` alongside `email`.

The website uses `/api/v1/common/region-emails` for footer, contact, privacy and
account-support links. One shared browser request is cached for five minutes;
loading shows a skeleton and failure offers an icon-only retry. Existing page
content remains usable without the API. A failed refresh retains the last good
directory for that page session; there is no hardcoded address fallback.

## Regional reports

`services/background-services/regional-membership-report.js` runs independently
of national report delivery, every Sunday at **18:00 Europe/Amsterdam**. It uses
the same production/internal-notification enable flags, scheduling, email sender,
delivery provider and HTML template as the existing weekly membership report.

- The reporting interval is the previous Sunday 18:00 inclusive through the
  current Sunday 18:00 exclusive, respecting daylight saving.
- Counts use `joinDate`, excluding migrated/archived account copies.
- Send only when a region has at least one new **Member**. An alumni-only week
  does not trigger an email. When sent, the same table includes that region’s
  new-member and new-alumni counts, with a region total.
- Each report contains only its own region’s counts, no names or personal
  addresses, no neighbouring regions or national totals.
- Recipients are loaded fresh from the database each run. National and support
  directory entries do not receive regional reports. The existing national
  internal report and its subscriber configuration remain unchanged.
- A missing/invalid contact is skipped and reported as `missingContacts` in the
  observed job result; it never falls back to another inbox.
- As with the existing national report, PM2 worker 0 owns the schedule, with an
  in-memory once-per-region/week attempt guard. There is no startup catch-up,
  persisted delivery ledger or blind resend after an ambiguous provider timeout.
  This is not a globally exactly-once guarantee across independent schedulers.

Verify without real email or database writes:

```sh
node --test tests/region-contacts.test.js tests/regional-membership-report.test.js tests/weekly-membership-report.test.js
```
