# Account announcements

Members (`users`) and alumni (`alumniusers`) share a `campaignsSeen` string
array, defaulting to `[]`. Existing documents without this field are treated
as unseen; their first acknowledgement creates the array with `$addToSet`.
No bulk database migration is required. Membership conversions preserve and
merge this history.

The enabled release flag is `whats-new-version4`. Its Profile-tab modal has
four steps: website update, security, wallet cards, and help. Each step uses
its matching image from `/assets/images/campaigns/version4/`. The final action
is the gold “Let’s roll” button. The standalone dev preview remains available
at `/dev/whats-new` without changing account history.

Both account types store dismissal only in `campaignsSeen`. The `campaigns`
timestamp map and `mmmCampaign2025` fields are no longer part of the models.
Migration `009-remove-retired-account-campaign-fields` removes both fields
from `memberUsers` and `alumniUsers` on the next migration-enabled deployment.
It only matches documents with either retired field and preserves `campaignsSeen`.
The standard deployment runner handles tracking and rollback snapshots.

Authenticated routes (also available under `/api/v1`):

- `GET /api/user/campaigns/:campaign` returns `{ campaign, seen }`.
- `POST /api/user/campaigns/:campaign/seen` atomically adds the flag and returns
  `{ campaign, shouldShow }`. Only the first claimant receives `true`.

Both routes use the authenticated account; no caller-supplied account ID is
accepted. Locked and free alumni accounts can also see announcements. Allowed
flags are defined in `util/config/account-campaigns.js` to prevent arbitrary
array growth.

The website waits until account content is loaded, then starts a separate,
cancelable background request. Display waits for a visible page, no open
dialog/sidebar, and no active form input or recent interaction. Requests do
not trigger the global loader, toasts, or redirects. The modal is closable at
any step, uses the shared accessible shell and respects reduced motion.

Presentation only reads history. Closing at any step or choosing “Let’s roll”
persists dismissal, preventing repeat display on later visits or other devices.
An interrupted tour without dismissal remains eligible. Multiple tabs can show
an unread tour, but acknowledgement is idempotent and keeps a single flag.
Closing is immediate and acknowledgement runs in the background with fetch
keepalive. Read failures are silent; dismissal failures show an error toast
without reopening the modal. Viewing a campaign never changes email preferences.

For the next release, add a new immutable allowlisted flag in the API, update
`WHATS_NEW_CAMPAIGN` in the website's `account-campaign.mjs`, and update the
content in `WhatsNewModal.jsx`. Deploy the API flag before the website.

Verification:

```sh
node --test tests/account-campaigns.test.js tests/subscription-auth-and-migration.test.js
```

In the website checkout: `node --test scripts/account-campaign.test.mjs`.

## Local previews

Localhost and production both use persisted account history. The obsolete
`NEXT_PUBLIC_WHATS_NEW_IGNORE_SEEN` flag is ignored. Use `/dev/whats-new` for
a standalone preview without history writes, or the “Explore version 4”
banner to reopen the walkthrough regardless of its saved dismissal.
