# Ticket QR and door check-in

New server-rendered tickets use `https://bulgariansociety.nl/t/{token}`. Tokens contain 128 random bits (22 base64url characters). A token lives on the guest-list entries it admits, as `Event.guestList.ticketToken`; there is no separate collection. Because one purchase may cover several guests, the same token is written to every entry sharing that purchase code, and the supporting index `guestlist_ticket_token` is therefore not unique: a unique multikey index would reject the repeated value inside a single event document. Issuance instead checks the event for an already-issued code and re-mints on the (vanishingly unlikely) token collision, so a code is never aliased to a second token. An event with QR tickets switched off never receives a token at all: `reserveTicketToken` takes the loaded event and returns nothing when `ticketQR` is false, without touching the database, so the rule holds for every call site rather than each one remembering to check. Checkout generates the purchase code server-side and passes the same code to image generation and payment fulfillment.

The existing ticket format is preserved: one purchase image/QR may represent multiple guest-list entries. It is not a separate QR per attendee in a group. A decision to split group purchases requires changing fulfillment and email attachments, not merely the scan page. Old long URLs and already-issued images still work without a backfill or reissue.

## Door workflow

Open an event's guest list and select **Scan tickets**. This locks the scanner to that event. A general scanner is also available at `/user/dashboard/guest-list`.

- Start the camera once, using HTTPS (or localhost). Camera code loads on demand; leaving the page or stopping the camera closes its stream.
- A single ticket is marked present immediately. Green confirmation is shown only after the API confirms the write.
- Group tickets show remaining admissions and require an explicit arrival count. Counts embedded in legacy URLs are ignored by the new scanner.
- Duplicate, wrong-event, invalid, refunded and permission errors cannot admit guests. Error results pause processing until staff resolve them or select **Next ticket**.
- After success, the camera can process a different QR without navigating away. Repeated frames of the same QR are suppressed.
- A manual token/link input is available if camera access is denied or unavailable. There is no offline success mode.

Only authenticated event-management staff can call the check-in API; region access is checked before any mutation. Exact purchase codes select guests—names and email addresses are never used as ticket identity. A single atomic conditional update protects all selected seats against simultaneous check-in/refund changes. A conflicting scanner receives HTTP 409, not a success. Manual attendance updates modify only the selected guest, not the entire event document. Spreadsheet sync is queued after the database write.

## Live guest-list UI

The guest-list modal and expanded analytics guest tables subscribe to authenticated SSE invalidations through the same-origin website cookie proxy. Redis pub/sub fans notifications out across API processes. The existing post-write event spreadsheet enqueue entry point also publishes an independent invalidation, including check-ins and ticket issuance; spreadsheet job completion is not required. No guest data or bearer tokens travel in stream messages or URLs.

Notifications, focus, reconnection and local edits trigger an uncached guest-list-only fetch. Rows merge by ID, preserving unchanged objects and the mounted table: no page refresh, loading skeleton on background updates, or scroll reset. Healthy streams suspend polling; disconnected streams retry and fall back to ten-second refreshes. Hidden tabs disconnect; closed/collapsed views clean up. Errors retain the last snapshot with a warning; authentication/access failures clear cached rows.

Deploy both API and frontend with the existing `BGSNL_REDIS_URL` and environment-specific `BGSNL_REDIS_PREFIX`. Redis must allow SUBSCRIBE/PUBLISH. The API streams heartbeats every 15 seconds and ends streams after 45 seconds; the dedicated Next route allows 60 seconds. Reconnects revalidate authorization and fetch a fresh snapshot (Redis pub/sub is not a durable event log). Reverse proxies must preserve streaming and disable buffering/compression for `text/event-stream`. Redis failure must not fail a committed attendance mutation. Verify two independent browsers and a simulated connection outage on staging before rollout.

Manual updates show a pending state until server confirmation. In-flight snapshots are invalidated during edits so an older response cannot overwrite a confirmed change. Read-only committee viewers use the existing analytics event scope: their region and non-draft/non-archived events only. Mutation permissions remain unchanged.

The shared `AppModal` shell includes a fullscreen/restore control next to Close, enabled by default. `maximizable={false}` opts out; `maximized` and `onMaximize` support controlled usage through both `AppModal` and the `Dialog` compatibility wrapper. Uncontrolled modals reset fullscreen when closed. Fullscreen is a viewport layout, not the browser Fullscreen API, and retains modal focus trapping and Escape-to-close behavior.

## Rollout and verification

1. Deploy the frontend short `/t/` redirect and scanner alongside the API changes; do not enable new ticket generation on the API before the short route is live on the canonical domain.
2. Apply migration `011-ticket-tokens-into-guest-list` through the existing migration runner before new ticket issuance. It creates the `guestlist_ticket_token` index, copies any tokens still held in the retired `ticketqrs` collection onto their guest-list entries, and then drops that collection. Attendance rows are otherwise untouched, and already-issued QR images keep working. It supersedes `008-ticket-qr-indexes`, which indexed the retired collection.
3. Test newly issued single/group tickets, old QR links, partial group arrivals, duplicate scans, refunds, wrong-region/event permissions, two simultaneous scanners, and network interruption on staging.
4. Verify camera permission, QR decoding, focus and stop/restart on a physical iPhone and Android device. Codes are generated directly at 140px with a four-module quiet zone, without the previous blurred 80px downsampling.

Automated checks cover the parser, exact-code selection, count limits, refunds, duplicates, conditional update predicates, controller authorization/conflicts, short-code mapping and checkout identity propagation. They do not replace physical device or live-database concurrency tests. No production migration, deployment or attendance mutation was performed during implementation.
