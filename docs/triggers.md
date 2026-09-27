# Database trigger registry

Keep every BGSNL database trigger in this file, including disabled triggers.
Record its purpose, source, destination, credentials, delivery behavior and
current deployment status whenever a trigger is created or changed. Recurring
API workers are listed separately in [scheduled-events.md](scheduled-events.md).

Last reviewed: 11 September 2026.

## Inventory

| Trigger | Atlas project / cluster | Source | Effect | Status |
| --- | --- | --- | --- | --- |
| `member-event-announcement` | `PRODUCTION` / `BGSNL` | Published Events with a pending announcement marker | Wake the API's member announcement worker | **Created in Atlas; disabled** |

The production project showed the initial Triggers setup screen before this
change; no pre-existing triggers were listed. This registry covers the inspected
BGSNL production project, not unrelated Atlas projects.

## member-event-announcement

[Open the saved Atlas trigger](https://cloud.mongodb.com/v2/65acda8e2f61285c755319fc#/triggers/6aa3adb7da812828c8a8a224).
Created on 11 September 2026 and verified with Enable off on the saved Edit
Trigger page. API changes are local and have not been deployed.

### Files and destination

- Atlas Function: [`atlas/functions/member-event-announcement.js`](../atlas/functions/member-event-announcement.js).
- Match expression: [`atlas/triggers/member-event-announcement.match.json`](../atlas/triggers/member-event-announcement.match.json).
- API route: [`routes/Integration/atlas-triggers.js`](../routes/Integration/atlas-triggers.js).
- Handler: [`controllers/Integration/atlas-event-trigger-controller.js`](../controllers/Integration/atlas-event-trigger-controller.js).
- Email worker: [`services/events/member-event-announcements.js`](../services/events/member-event-announcements.js).
- Email, membership pricing and encrypted checkout details: [member-event-announcements.md](member-event-announcements.md).

```text
POST https://kanatitsa.bulgariansociety.nl/api/v1/integrations/atlas/member-event-announcement
Content-Type: application/json
x-api-key: (dedicated trigger secret)

{"eventId":"MongoDB ObjectId as a 24-character hexadecimal string"}
```

The Function sends only the event ID. The API reads committed event state and
uses its own recipient, price and link calculations. The webhook cannot choose
recipients, alter prices, or create/reset publication markers.

### Publication contract

Both supported API publication paths insert an Event with
`memberAnnouncementQueuedAt` in the same write/transaction. EventDraft saves
are in another collection and never queue announcements. External tools that
publish events must preserve this explicit publication contract; inserting an
unmarked document intentionally does not send emails.

The trigger responds to inserts and replacements with a pending publication
marker, and relevant updates that add that marker or make the pending event
public. Title edits, ticket sales, guest-list changes and completion-marker
writes do not invoke it. Replacements may wake an existing pending announcement
but cannot create a second announcement after completion. Old documents without
a marker are never mailed retrospectively. Hidden/draft/archived records are
excluded, and the worker checks event/ticket deadlines before delivery.

### Atlas settings

| Setting | Value |
| --- | --- |
| Name | `member-event-announcement` |
| Type / watch scope | Database / Collection |
| Project | `PRODUCTION` (`65acda8e2f61285c755319fc`) |
| Cluster | `BGSNL` |
| Database | `test` (the API connection uses the MongoDB driver default database) |
| Collection | `events` |
| Operations | Insert, Update, Replace |
| Full Document | On |
| Document Preimage | Off |
| Event Ordering | Off; API coalesces concurrent wakeups |
| Auto-Resume | On; the API poller recovers missed pending work |
| Skip Events On Re-Enable | On; the API still checks its durable queue |
| Match Expression | Contents of the checked-in match JSON |
| Project Expression | Empty; the Function needs the document and update description |
| Function | Contents of the checked-in Function JavaScript |
| Enabled | **Off — do not activate without a separate request** |

### Credentials and activation prerequisites

The API requires `ATLAS_EVENT_TRIGGER_SECRET`, a dedicated random secret of at
least 32 characters, in the `x-api-key` header. Atlas must expose the same value
through a Secret-backed Value named `ATLAS_EVENT_TRIGGER_SECRET`. Keep it
separate from `JWT_STRING`, `EVENT_TICKET_LINK_SECRET`, Google Scripts and mobile
integration credentials. Missing/short secrets disable the endpoint; other
integration keys cannot authorize it. The firewall admits this credential only
on this exact POST endpoint. Existing request logging redacts API-key headers.

This change creates the trigger disabled. API deployment and production secret
provisioning are separate prerequisites, not completed by creating the trigger.
Do not run the Atlas Function against a real pending production event as a test:
manual Function execution can invoke the API even while the trigger is disabled.

The existing worker remains controlled by `EVENT_ANNOUNCEMENTS_ENABLED` (enabled
by default in production). Disabling the Atlas trigger stops immediate database
notifications; it does not disable the independent email worker. To pause all
member announcements, set `EVENT_ANNOUNCEMENTS_ENABLED=false` in the API.

### Acknowledgement, failures and duplicates

- `202 queued`: the API found an existing committed pending marker and requested
  an immediate worker pass. This confirms queue acceptance, not email delivery.
- `200 ignored`: no eligible pending marker remains, including duplicate calls
  after completion, hidden events, missing events and historical records.
- `400`: invalid event ID. `403`: incorrect credential. `503`: missing credential,
  disabled announcements, or a worker that has not started/is shutting down.
- Atlas treats other HTTP statuses as Function errors. Inspect execution logs
  without including credentials or member details. Do not depend on automatic
  HTTP retries for recovery.

The worker starts after MongoDB and delivery indexes are ready, checks every
minute, and can now be woken between checks. Notifications received during a
running pass coalesce into one subsequent pass. A crash after `202`, an HTTP
failure, or missed Atlas changes leave the committed marker for the poller.

The shared unique delivery claims prevent retries, overlapping API instances
and trigger/poller races from sending the same event to an inbox twice. Provider
failures whose outcome is uncertain remain marked for manual delivery review;
they are not automatically resent. This prioritizes avoiding duplicate email
over an exactly-once delivery guarantee. A completed event marker means the
recipient pass finished, not that every recipient received an email.

### Verification and maintenance

```bash
node --test tests/atlas-event-trigger.test.js tests/member-event-announcements.test.js tests/service-key-security.test.js
```

These tests use mocked database, provider and Stripe calls, execute the actual
Atlas Function source with a mocked Atlas context, and exercise the mounted HTTP
route with a localhost server. No production events or emails are created.

When changing a trigger, update its Function, match expression and this registry
together. Check the deployed Enabled state after saving. Retain an inventory row
for disabled triggers; remove a row only when the trigger itself is removed.

References: [Atlas database triggers](https://www.mongodb.com/docs/atlas/atlas-ui/triggers/database-triggers/),
[Atlas Function context and HTTP client](https://www.mongodb.com/docs/atlas/atlas-ui/triggers/functions/context/),
and [secret-backed Values](https://www.mongodb.com/docs/atlas/atlas-ui/triggers/functions/values/).
