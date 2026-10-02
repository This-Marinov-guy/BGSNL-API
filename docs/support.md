# Website support

The website widget, account Help section (`/user#help`) and staff inbox
(`/user/support`) use `/api/v1/support`. Unversioned `/api/support` requests
use the existing v1 URL rewrite, including dynamic conversation IDs.

## Access

- Signed-in requesters can list, read and reply to their own conversations.
  Identity/contact details are loaded from the server account, never from the
  submitted user ID, roles, email or subscription status. Account aliases keep
  reports accessible across member/alumni migrations. Locked members can ask
  for help without needing membership benefits.
- Guests provide a name and either email or phone. These details are **not**
  proof of identity and cannot be used to claim an account or report. Each
  conversation uses a separate random 256-bit browser key, sent only in the
  `X-Support-Token` header. Mongo stores its SHA-256 hash, not the key. Access
  expires after 90 days. Losing/clearing browser data loses guest access;
  knowing an ID or email does not restore it. Signing in does not automatically
  attach guest reports to the account.
- Only active `super_admin`, `admin` and dedicated
  `support` accounts can use `/inbox` endpoints. The `support` role does not
  inherit unrelated event or member-administration access. Local
  board/committee roles do not get access to private site-wide reports. Every
  API operation rechecks server-side authorization.

## Routes

| Method | Relative path | Purpose |
| --- | --- | --- |
| GET | `/profile` | Signed-in reporting identity and staff flag |
| GET | `/conversations` | Own reports, 25 per page |
| POST | `/conversations` | Create a report |
| GET | `/conversations/:id` | Read a private conversation |
| POST | `/conversations/:id/messages` | Reply as the requester |
| POST | `/conversations/:id/status` | Resolve or reopen an own report |
| GET | `/inbox` | Staff report list with status filtering |
| GET | `/inbox/:id` | Staff conversation/contact view |
| POST | `/inbox/:id/messages` | Staff reply |
| POST | `/inbox/:id/status` | Staff status update |

Create accepts `{id, subject, text, pagePath, contact: {name, email?, phone?},
environment?}`. The website supplies bounded browser, platform, device,
language, time-zone, viewport, screen, pixel-ratio and touch-point details;
the API takes the user-agent from the request header. Diagnostics are visible
only in staff responses.
`id` is a fresh UUID v4, retained on retries; authenticated contact is ignored.
Replies accept `{id, text}`, with a fresh UUID per message. Status changes
accept `{status, revision}` from the last response. List queries use `page`
(1–200) and `status` (`all` or a supported status). Conversation reads return
the newest 50 entries; `?before=<first-message-order>` loads older entries.

Statuses: `open`, `in_progress`, `waiting_for_you`, `resolved`, `closed`.
Staff replies set `waiting_for_you`; requester replies reopen resolved reports.
Closed conversations remain readable but reject new replies. Changes are
audited as chat entries.

## Persistence and safeguards

`SupportConversation` stores an indexed Mongo document per conversation.
Messages are bounded to 4,000 characters and 200 entries per conversation;
subjects to 140 characters, request bodies to 32 KB. Atomic revision checks
prevent concurrent replies/status updates from silently overwriting one
another. UUID-based replay handling makes ambiguous create/reply retries safe.

Database-backed rate limits use the existing `AuthRateLimit` TTL collection:
8 new reports per identity per 15 minutes, 200 creations site-wide per hour,
60 other writes per identity per 15 minutes and 180 reads per minute. They fail
closed when unavailable. These are basic abuse protection, not a substitute for
monitoring production traffic or hardening the API's inherited proxy trust.

Writes require JSON and an approved BGSNL browser origin. Responses are
private/no-store and noindex. Report text is plain text, not rendered HTML.
Support requests bypass marketing capture and request-body logging; parser and
upstream failures are sanitized before the generic error logger. Query strings,
fragments and account-access paths are stripped/redacted from the reported URL.
There is no report TTL deletion: guest access expiry does not delete the report.
Use the society's retention/deletion process for stored contact details.

## Deployment and verification

Deploy the API before or alongside the website. Startup initializes the support
indexes alongside the existing auth/billing indexes; no new environment secrets
or third-party support service is needed. Keep `X-Support-Token` allowed through
any additional reverse-proxy/CORS configuration.

Run `npm run test:support` for policy, persistence-service and router tests.
These use Mongo-shaped in-memory fixtures plus real Mongoose schema validation,
not a live database. A separate database integration check is still required
in an approved staging environment before relying on production rollout.

For isolated browser verification (never start this as a production service):

```sh
APP_ENV=dev node tests/fixtures/support-server.mjs
```

Then start BGSNL with `NEXT_PUBLIC_TEST_SERVER_URL=http://localhost:8089/api/`
and `NEXT_PUBLIC_AUTH_VERSION=1` on port 3002. The test-only accounts are
`member@support.test.com` and `staff@support.test.com`, with password
`Support-preview-only-123!`. The fixture listens on loopback only, uses a random
ephemeral signing secret, stores all reports in memory and makes no Mongo,
email or Stripe writes. Stop it when finished; all fixture reports disappear.

This initial version is asynchronous in-site support: replies poll every 20
seconds while the relevant view is visible. Each newly created ticket queues a
deduplicated internal email only to the developer group configured by
`DEVELOPER_NOTIFICATION_SUBSCRIBERS` (defaults to
`vladislavmarinov3142@gmail.com`). Requester replies also notify only that
group. Both `INTERNAL_NOTIFICATIONS_ENABLED` and
`DEVELOPER_NOTIFICATIONS_ENABLED` must be enabled. Idempotent
create replays and later replies do not send another new-ticket email. It does
not provide live-agent availability, SMS or automatic guest recovery links.

The new-ticket email contains the reference, type, subject, reporter name,
email, device, submission time (Europe/Amsterdam), and the first message.
Its `View ticket` link opens `/user/dashboard/support?ticket=<conversation UUID>`
directly in the staff detail view; normal staff authentication and permissions
still apply. User-provided text is HTML-escaped, with message line breaks
preserved. Full diagnostics remain available in the ticket rather than the email.

Each newly saved staff reply also queues a transactional email to the ticket's
contact email (phone-only tickets are skipped), independently of the internal
notification switch. Its `Open ticket` button links to
`/?supportTicket=<conversation UUID>` and opens the Help widget to that thread.
The email excludes message contents and attachment URLs. Signed-out account
holders are prompted to sign in and return to their ticket; guests must use the
original browser with their saved, unexpired access key. The link itself grants
no access. Replayed reply requests, status changes and automatic screenshots do
not send another customer email. Delivery uses the existing background mail
queue and timeout; mail failure does not undo a saved reply.

Replies may include up to three JPEG, PNG or WebP photos, each no larger than
5 MB. The API authorizes access to the conversation before accepting file data,
then converts uploads to bounded WebP images in `support/<conversation-id>` in
Cloudinary. Stored message data contains only the resulting HTTPS Cloudinary
URLs; client-supplied attachment URLs are ignored. Content-addressed public IDs
keep retries idempotent.

Submitting a new report automatically starts a full-document screenshot in the
browser, without a permission prompt or confirmation step. After the report is
confirmed, the screenshot uploads in the background as an attachment message
using the same authenticated/guest access checks. Network/server upload failures
retry once with the same message ID and file. Capture/upload failure never blocks
the report; the customer gets a notice if its screenshot could not be attached.
The page remains usable while the attachment is being prepared. Leaving the site
before upload completes can interrupt this best-effort attachment.

The capture excludes the support widget, support desk and embedded frames/video;
form values and explicitly marked private content are masked in a detached clone.
It captures the rendered page from top to bottom, not browser chrome or other
applications. Images blocked by CORS, unloaded content and unsupported CSS may not
render exactly. Capture is bounded to 3 megapixels, 2,000 pixels wide, 8,192 pixels
tall and 5 MB; very long pages scale down. Support image storage now preserves up
to 8,192 pixels of height instead of shrinking tall screenshots to 2,000 pixels.
This requires deploying the API attachment-size change alongside the frontend.
The screenshot is not included in the initial new-ticket notification email.

Frontend tests: `node --test scripts/support-state.test.mjs scripts/support-screenshot.test.mjs`.

The conversation composer also has a one-click screenshot action. It captures
the currently visible website viewport (excluding the support widget itself)
and immediately posts the result as a photo-only message through the same
authorized Cloudinary upload path. It captures page content, not browser chrome
or other applications.
