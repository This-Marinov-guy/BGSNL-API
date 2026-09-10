# Account announcements

Members (`users`) and alumni (`alumniusers`) share a `campaignsSeen` string
array, defaulting to `[]`. Existing documents without this field are treated
as unseen; their first acknowledgement creates the array with `$addToSet`.
No bulk database migration is required. Membership conversions preserve and
merge this history.

The current release flag is `whats-new-2026-09`. Its website modal has three
steps: wallet card, new account design, and community campaigns. Wallet and
campaign copy describes upcoming features until their launch details are set.

The What's new campaign is currently paused: its entry in the website's
`ACTIVE_ACCOUNT_CAMPAIGNS` list (`src/elements/campaigns/account-campaign.mjs`)
is commented out. Uncomment `WHATS_NEW_CAMPAIGN` there to enable it again.
The background scheduler stays wired into the account page, but an inactive
campaign performs no requests, writes no seen flag and opens no modal—even
with the local ignore-seen override enabled. The standalone dev preview remains
available at `/dev/whats-new` without changing account history.

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

The flag is claimed immediately before opening, not at the end of the tour.
Closing or skipping therefore does not show it again on later visits or other
devices. A navigation or crash between the claim and presentation can consume
the announcement; this favors avoiding repeated popups. Request failures are
silent and may retry on a future visit. Viewing a campaign never changes email
subscription preferences.

For the next release, add a new immutable allowlisted flag in the API, update
`WHATS_NEW_CAMPAIGN` in the website's `account-campaign.mjs`, and update the
content in `WhatsNewModal.jsx`. Deploy the API flag before the website.

Verification:

```sh
node --test tests/account-campaigns.test.js tests/subscription-auth-and-migration.test.js
```

In the website checkout: `node --test scripts/account-campaign.test.mjs`.

## Local preview override

In the website's gitignored `.env.development.local`, set:

```dotenv
NEXT_PUBLIC_WHATS_NEW_IGNORE_SEEN=true
```

For an active campaign, this shows the announcement on each account entry/reload, even if already
seen. It bypasses both announcement API requests, leaving `campaignsSeen`
unchanged. The normal background delay and interaction/modal guards remain.
Closing it does not reopen it until the next account visit.
Set the flag to `false` to restore normal show-once behavior. Restart the local
dev server after changing the flag if it has not reloaded the environment.
The override only works in development; production builds always check the API.
