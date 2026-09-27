# Live support tickets

## Reply permissions and reopening

Rejected tickets are read-only. Paused tickets (the frozen state; `frozen` is
accepted as an alias for `paused`) are read-only for clients, including guests.
Clients cannot bypass a lock by changing the ticket status themselves. Staff
can reopen tickets; staff updates on a paused ticket leave it paused.

The client replaces its composer with a status explanation. The API checks
permissions before attachment uploads and rechecks the status under revision
control when saving, covering concurrent freezes and stale browser state.
Idempotent retries of previously saved replies remain readable after a lock.

A new client reply or manual attachment on a resolved ticket changes it to
`open` in the same write as the message. It queues the existing support-reply
notification once with the subject “Support ticket reopened.” Notification
recipients and the internal-notification enable switch are unchanged. Automatic
diagnostic screenshots do not reopen tickets or trigger reply notifications.

## Live updates

The Help widget, account Help panel and staff inbox use the same live support
components. Saved creates, replies and status changes publish Redis invalidations
using the guest-list transport, isolated under `support:` scope keys.

`POST /support/live` authorizes either a specific conversation, the staff inbox,
the current account and its aliases, or up to 20 saved guest tickets. Guest keys
are carried in a header/body, never in URLs. Stream frames contain no ticket
content. Connections expire after 45 seconds so reconnects recheck permissions.

The website cookie/CSRF proxy passes through the SSE response. Clients refetch
only their active list or conversation, preserving drafts, history and unchanged
rows. Hidden views disconnect; focus, reconnection and local successful writes
reconcile missed updates. Disconnected streams retry and fall back to 10-second
polling. Redis failures do not reject successful ticket writes.

Deploy both API and website changes. Redis is the existing guest-list dependency;
no new environment variables or database migration are required.

Unread indicators use browser-local, account- and role-scoped seen revisions.
Opening a visible conversation records its current revision; listing tickets
does not. Same-tab events and storage events synchronize the widget and panel.
The closed Help launcher maintains a lightweight owner-only activity feed via
`GET /support/conversations/activity` (IDs, revisions and last author only).
Guest activity is read using each saved ticket's private access key. Read state
does not currently sync across devices.

Dashboard detail links use `/user/dashboard/support?ticket=<conversation-id>`;
normal staff authorization still applies. The chat initially requests 20 messages
and fetches older 20-message pages near the top of the scroll area. The oldest
cursor survives live refreshes, and prepending history preserves scroll position.
The composer stays outside the scrolling message area. Automatic bottom-follow
pauses when readers scroll up; Back to bottom resumes it. Loaded offscreen message
bodies use browser rendering containment, and attached images are lazy-loaded.
