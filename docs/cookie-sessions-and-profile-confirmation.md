# Cookie sessions and email-confirmed profile changes

Scope: account authentication in BGSNL and BGSNL-API. No production deployment, live account update, email delivery or infrastructure change was performed during implementation.

Follow-up: [refresh sessions](refresh-sessions.md) supersedes the initial fixed-lifetime/no-session-record design and its earlier verification totals below.

## Browser sessions

- Browser requests now use the website's same-origin `/api/...` routes. Only the Next.js server forwards the bearer JWT and server key to BGSNL-API. The API still verifies the JWT and current account permissions; public client session metadata is not an authorization credential.
- Production cookies are `__Host-bgsnl-session`, `__Host-bgsnl-refresh` and `__Host-bgsnl-csrf`: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. Development uses unprefixed cookies without Secure on localhost ports 3000–3002.
- Access JWTs last 15 minutes. Original login time is preserved; after day 30, logout occurs after an hour of inactivity, not during active use. Revocation can end it earlier. See the follow-up for rotation, idle tracking and single safe pre-handler retry.
- `/api/session/current` restores only API-verified public account state. Browser JWT responses and legacy localStorage account credentials are removed. Other existing browser storage, including preferences and guest-support conversation capabilities, is not an account session and has not been migrated in this change.
- `/api/session/csrf` issues a signed, one-hour, session-bound CSRF value. Unsafe requests require the matching cookie/header and an exact same-origin request. Login, anonymous submissions and logout are protected too. Expired checks return an actionable error; mutations are not automatically replayed.
- A small TTL-indexed refresh-grant record now supports rotation and per-device logout/replay revocation; it stores no raw credentials. Account-wide revocation still uses `sessionVersion`.

The transport uses an explicit method/path manifest in `BGSNL/src/util/auth/proxy-policy.mjs`, a fixed upstream host, bounded payloads, no arbitrary forwarded headers and no upstream redirects. Private responses are no-store. API HTML/SVG/text cannot execute as website documents. Add future browser endpoints to the manifest intentionally; a regression test compares it against the current API routers.

## Public routes and webhooks

| Caller | Behaviour |
| --- | --- |
| Public browser reads | Continue anonymously through the same-origin proxy. |
| Anonymous forms/checkout/support | Use CSRF but do not require an account unless the existing API route requires one. |
| SSR events/news/SEO | Continue using the existing server-side public API client. |
| Stripe webhooks | Continue calling the API directly, with existing raw-body/signature handling. No website cookie or CSRF requirement was added. |
| Google Scripts/mobile integrations | Existing direct API routes are unchanged and are not exposed through the browser proxy. |
| Payment return/invoice server routes | Keep their separate verified receipt-capability flow. No paid invoice-generation feature was enabled. |

This does not fix the separate audit findings concerning direct integration service-key checks, Origin-based firewall trust or global distributed/edge DDoS protection.

## Profile confirmation

1. The authenticated profile form submits to `PATCH /api/v1/user/edit-info`. Ordinary profile details save immediately. Proposed email/password changes stay pending; the existing credentials continue working.
2. An approval email goes to the **current** address. Its link opens `/account/confirm#token=...`. The page removes the fragment from the address bar and waits for an explicit confirmation click, so ordinary link scanners cannot apply changes by fetching the URL.
3. For an email change, approving the old-address link sends verification to the **new** address. No credential changes until that second confirmation. Password-only changes need the current-address approval alone.
4. Final confirmation atomically consumes the challenge, applies the credentials and increments `sessionVersion`. A changed email disconnects the old Google identity to preserve the same-email policy. Existing passkeys and account restrictions remain unchanged.
5. The page returns to `/user#profile` with a success/error/info toast. If the browser is not authenticated, it must sign in first; the profile notice survives that navigation. The requesting browser may retain its original login deadline. Opening a confirmation link elsewhere does not silently log that browser in.

`ProfileChange` stores one pending request per account, with an expiration/TTL index. Tokens have 32 random bytes and are HMAC-hashed at rest; proposed passwords are bcrypt-hashed before storage. Resending supersedes older links. Runtime expiry, single-use consumption and transaction fences are authoritative even before TTL cleanup. Email delivery uses the existing provider; no new email credentials or templates are required for the legacy provider. Domakin uses the existing generic notification template mapping.

Approval-email delivery failure cancels that pending generation without changing credentials. Failure of a post-change notification does not incorrectly report that a committed change failed. As with any remote write, a lost HTTP response is ambiguous; the UI asks the user to check their profile or request another link.

## Deployment checklist

- Deploy the API update before or together with the website update. Users with legacy localStorage sessions must sign in again. Removing local storage does not invalidate previously copied JWTs; rotate the coordinated auth version if an account-wide rollout invalidation is required.
- Website `BGSNL_SERVER_KEY` must equal API `SSR_SERVER_KEY`. Use a strong random secret (at least 32 random bytes); the website rejects missing or shorter-than-32-character configuration. Never prefix it with `NEXT_PUBLIC_`. Local configured keys were checked for presence, length and equality without printing or changing them. Production values were not inspected.
- Keep `AUTH_VERSION` / `NEXT_PUBLIC_AUTH_VERSION` aligned and `JWT_STRING` server-only. No JWT signing secret is needed in the website.
- Production website origins currently allow the apex and `www.bulgariansociety.nl`. Preview/custom hosts require an explicit coordinated origin policy; do not enable arbitrary reflected hosts. Cookies are intentionally host-only, so use a canonical website host.
- Ensure MongoDB transaction support and create the `ProfileChange` unique token-hash indexes and `expiresAt` TTL index, alongside existing authentication TTL indexes. No production indexes or data were changed by this work.
- Configure the mail provider and verify both email stages in isolated staging. Mail-provider acceptance is not proof of inbox delivery. Check tracking/link rewriting preserves the fragment and redirects to the expected canonical website origin.
- On Vercel the proxy uses the platform-overwritten client-IP header. Other hosting must set `BGSNL_TRUSTED_CLIENT_IP_HEADER` only to an ingress-overwritten, single-IP header, and prevent bypassing that ingress. The API accepts that forwarded address only alongside the matching server secret and proxy marker. Without trusted forwarding, rate limits can aggregate visitors under a server IP; do not trust arbitrary X-Forwarded-For headers.
- The application proxy bounds request bodies to 40 MiB and uses a 60-second upstream timeout. Hosting limits can be lower. Verify the deployed host accepts existing multipart upload sizes; hosts with smaller hard limits need a separately authorized direct-upload design, not exposed JWTs or a public service key.

## Remaining limitations

- HttpOnly/CSRF does not eliminate XSS, compromised browser extensions or compromised email accounts. Keep sanitization, CSP, dependency maintenance and sensitive-operation step-up authentication on the security roadmap.
- Member and alumni email uniqueness currently lives in separate collections. Confirmation checks both collections in its transaction, but a global cross-collection uniqueness guarantee against all concurrent signup/admin writes requires a shared email-identity registry used by every writer. That broader identity migration was not implemented here.
- A confirmed password change revokes sessions but does not delete registered passkeys or Google identities. Users recovering from suspected compromise should review their sign-in methods; email changes specifically remove the obsolete Google connection.
- Tests use isolated transactional/service doubles. They do not prove real-Mongo concurrency, actual email delivery, production proxy settings or device-native Google/passkey prompts. Staging verification remains necessary before rollout.

## Verification commands

```sh
# BGSNL
node --experimental-vm-modules --test scripts/*.test.mjs
npm run build

# BGSNL-API
node --test tests/jwt-refresh.test.js tests/profile-change.test.js tests/password-reset.test.js tests/google-auth.test.js tests/passkeys.test.js tests/subscription-*.test.js tests/api-version.test.js tests/form-validation.test.js tests/support-*.test.js tests/event-drafts.test.js tests/payment-return.test.js
```

The cookie suite exercises the real Next response/cookie handler with isolated upstream fixtures, including login methods, CSRF rejection, anonymous routes, route-manifest coverage, expiry/revocation, multipart forwarding, no token disclosure and fixed deadlines. Backend tests cover both email stages, replay, simultaneous confirmation, races with account changes, delivery failures and transaction rollback.

Final results: **186 website tests and 299 selected API tests pass**, and the Next.js production build passes. Changed authentication frontend modules and new API modules/tests pass lint (API environment-variable warnings remain informational). The broad worktree contains unrelated existing edits; no commit or push was made.

Read-only runtime checks returned 200 for anonymous session restoration, CSRF bootstrap, events (4) and articles (15). Browser checks confirmed the approval page renders, the token disappears from the URL, no global analytics scripts load there, and Cancel reaches the account sign-in screen. No approval was submitted against a real account. The only observed hydration warning came from browser-extension-injected Grammarly attributes.

Security design references: [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
