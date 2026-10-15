# Short access tokens and activity-aware refresh sessions

Current policy for BGSNL-API and the BGSNL Next.js cookie proxy. The original 30-day policy described in the initial authentication audit has been superseded.

## Lifetime policy

- Access JWT: at most **15 minutes**, signed with HS256, issuer/audience, account ID, roles, `sid`, `auth_time`, account `sessionVersion` and global auth version. API authorization always reloads the account and validates the refresh grant; signed client roles alone do not authorize access.
- Login age: `auth_time` is the original login time. Refresh rotation, member/alumni migration and approved sign-in-method changes never restart it.
- The login ends **14 days after the last recorded activity**. The server deadline is `lastActivityAt + 14 days`. There is no hard maximum for continuously active sessions.
- The server checks expiry **before** recording activity. Returning after that deadline cannot revive an expired login, even if Redis has not yet removed the grant.

The browser observes trusted foreground pointer, keyboard, wheel and touch input. Updates are coalesced to approximately once per minute, with a trailing update and a final flush when leaving the tab. Background API polling, focus, mount and token renewal do not count as activity. Server receipt time is authoritative; submitted timestamps/lifetimes are ignored. Heartbeats have normal network/throttling granularity, not second-perfect last-keypress precision. They demonstrate browser activity, not cryptographic proof of a human: compromised browsers can synthesize requests. HttpOnly/CSRF does not replace XSS defenses.

Examples: a new login with no further activity expires after 14 days. Activity on day 13 moves the deadline to day 27. Activity in any tab of the same login updates the shared server deadline; an idle tab checks that deadline before clearing UI state. Existing 30-day access claims remain structurally accepted during transition, but the server enforces the 14-day activity deadline against their refresh grant. The first website restoration renews a legacy token, extends a shorter old Redis expiry if needed, and issues cookies through the new deadline. A browser whose old cookies expired before its first visit cannot recover that login.

## Storage, rotation and revocation

`RefreshSession` stores one small record per login/device: account ID, versions, original login time, last activity, expiry, generation, current SHA-256 token hash and revocation/rotation timestamps. No raw refresh token or profile snapshot is stored. Redis keys have expiries; enforcement also checks the 14-day activity deadline. Legacy grants can retain their old Redis key expiry, but cannot authenticate after the new deadline. Logout/replay marks the record revoked and immediately eligible for cleanup.

Refresh credentials are `random UUID.generation.HMAC`, with domain-separated HMAC-SHA256 using the API signing key. Atomic compare-and-set rotation lets separate API workers return the same successor. A bounded **120-second concurrency grace** covers the website's 15-second renewal and 60-second resource response before the browser receives cookies. During grace, the immediate predecessor may obtain the current credential. A genuine older credential outside grace revokes that login; random forged values cannot revoke anything. This deliberately trades a short replay tolerance for parallel-tab/slow-response reliability. Security changes rotate without predecessor grace.

Logout revokes this device immediately, including outstanding access JWTs. Account password/reset/sign-in-method changes increment `sessionVersion`; other-device grants fail server-side. Approved changes can replace the initiating browser's grant while preserving its original login time. Global `AUTH_VERSION` changes also invalidate refresh grants. Account status/benefits remain governed by current database policy: refresh does not unlock billing/frozen/suspended accounts.

## Website transport and safe retry

Production cookies: `__Host-bgsnl-session`, `__Host-bgsnl-refresh`, `__Host-bgsnl-csrf`; HttpOnly, Secure, SameSite=Lax, Path=/, no Domain. Access-cookie retention follows the **session** deadline so the server can still use expired access claims as stable CSRF context, never as authorization. Neither credential is returned to JavaScript or stored in localStorage. UI metadata distinguishes `accessExp` from `exp` (session deadline).

The proxy renews access within 60 seconds of expiry before forwarding a resource request. If access expires while a request is being prepared, API authorization returns `401 / ACCESS_TOKEN_EXPIRED` before the business handler. Only that explicit response permits one server-side renew-and-retry with identical buffered bytes. Ordinary 401, 403, 422, timeouts and failed writes are **not** replayed. A processed checkout/write is never retried merely because the response was lost. Outages retain cookies and existing form state; they are not treated as logout. Initial session restoration retries transient failures while the loading overlay remains visible, and finishes only after a confirmed session, anonymous response, or 401. Same-process requests share an in-flight renewal; Redis coordinates other workers.

`POST /api/session/activity` and `/api/session/logout` are CSRF-protected website endpoints. They internally call `/api/v1/security/session/{activity,logout}`; silent renewal calls `/refresh`. All three API lifecycle endpoints require the real website server key and shared rate limiting. They are excluded from the browser's API path manifest. Their rate budget is separate from normal business writes.

The direct API's old `GET /user/refresh-token` returns 410. Possessing an access JWT alone cannot obtain a refresh credential or chain access-token renewals. The website preserves that compatibility URL by internally requiring its separate refresh cookie. Google/passkey/profile security-change replacements additionally require their existing password/email proofs.

CSRF binding uses the login ID and account security version, so ordinary access rotation or member/alumni migration does not break a pending form. Sign-in/security changes reset CSRF. Existing anonymous forms, public SSR discovery data, signed Stripe webhooks and service-only/payment-receipt routes keep their existing access policies; no refresh/cookie requirement was added to those direct API paths.

## Rollout and verification

1. Deploy API and website together. Keep the current signing key, auth versions and Redis data. Existing refresh grants with activity in the last 14 days remain valid; the first website restoration renews their old cookie and reconciles a shorter stored Redis expiry. Grants already idle for 14 days end under the new rule.
2. Keep strong server-only `JWT_STRING`, matching website `BGSNL_SERVER_KEY` / API `SSR_SERVER_KEY`, aligned auth versions and trusted-ingress client IP configuration. No new third-party service or secret is required.
3. Verify existing and new logins, native Google/passkey login, credential changes, multi-tab renewal and temporary API failure behavior with staging accounts before deployment. Unit/service doubles do not prove live Redis persistence, reverse-proxy settings, actual email delivery or device prompts.

Checks: API lifetime/replay/concurrency/revocation tests, actual Next cookie-handler tests with isolated upstream responses, browser activity and restoration tests with fake clocks, and a production Next build. Tests do not touch real users, Stripe or outbound email.

```sh
# BGSNL-API
node --test tests/jwt-refresh.test.js tests/profile-change.test.js tests/password-reset.test.js tests/google-auth.test.js tests/passkeys.test.js tests/subscription-*.test.js
# BGSNL
node --experimental-vm-modules --test scripts/*.test.mjs
npm run build
```
