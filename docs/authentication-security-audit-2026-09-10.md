# Authentication and authorization review — 10 September 2026

Policy update: the subsequent [refresh-session implementation](refresh-sessions.md) supersedes this audit's original absolute-30-day/no-session-store design. It uses 15-minute access JWTs, rotating refresh grants and logout after day 30 only once inactive for an hour. Earlier findings/verification totals below describe their respective audit stages.

Scope: BGSNL Next.js website and BGSNL-API source, local build, isolated regression tests. No real account changes, reset emails, production probes or infrastructure changes were performed. This is a focused code review, not a guarantee that the application has no vulnerabilities. Existing unrelated work was preserved.

Follow-up: the user subsequently authorized HttpOnly-cookie transport and email-confirmed profile changes. Findings 2 and 6 below now reflect that implementation. Current follow-up validation is 299 selected backend tests, 186 website tests and a passing production build; the original verification totals at the end describe the earlier audit patch. See [deployment and confirmation details](cookie-sessions-and-profile-confirmation.md).

## Implemented in this update

| Finding | Severity | Change |
| --- | --- | --- |
| `/security/force-change-password` called a password-overwrite controller with no authentication or administrator check | Critical | Retired for all HTTP methods with 410; unsafe controller and optional/default-password validator removed. Both legacy and v1 URLs resolve through the same router. |
| Password-reset codes never expired; direct `/change-password` guesses bypassed the verification attempt counter; null records could cause errors | High | Crypto-random six-digit codes, HMAC-hashed storage, 15-minute runtime expiry, five atomic attempts shared by verification and final submission, one current challenge per account, transactional single-use consumption. |
| Password reset did not revoke existing JWTs | High | Password update increments the account's `sessionVersion` in the same transaction. Previous JWTs fail both authorization and refresh. Account status and benefits are not changed by reset. |
| Refresh accepted expired JWTs and restarted their lifetime, allowing indefinite authentication | High | Absolute 30-day deadline from login (`auth_time`); strict HS256, issuer, audience, version, identity and expiry validation. Refresh cannot extend that deadline or revive expired/revoked sessions. |
| Browser restoration/activity did not impose an absolute deadline | High | Saved-token validation, expiry timer, safe long-timeout chunks, focus/visibility checks after sleep, logout and private component reset. Routine refreshes do not create cross-tab reload loops. |
| Password login/reset lacked durable account-level throttling | High | Shared Mongo TTL counters for IP and normalized email. Account limits survive IP rotation. Both reset steps use the same bucket; limiter storage failures return 503 instead of bypassing protection. |

Password-reset protections follow the expiry, single-use, secure-randomness and revocation principles in [OWASP's reset guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html). The two-step UI is retained: successful verification also spends an attempt, and the final request must still present a valid code. Resending replaces the previous generation. Concurrent account migration, credential changes and replay are fenced by database transactions and current-account/password/version conditions.

New files: `util/auth/session-token.js`, `services/authentication/password-reset.js`, `models/PasswordResetChallenge.js`, `middleware/password-rate-limit.js`. Existing password-reset route names and response success fields remain compatible with the form.

## Requirements and present behavior

| Requirement | Status |
| --- | --- |
| Google sign-in after creating an account | Already implemented and regression-tested. Must connect in Settings after password confirmation. Verified Google subject must belong to that existing account; no automatic signup or email-only linking. Current product policy permits exact matching `@gmail.com` addresses only. |
| Passkey sign-in after creating an account | Already implemented and regression-tested. Registration requires an authenticated account and password confirmation. Server verifies signature, RP ID, exact origin, user presence/verification, challenge, ownership and counter/revision. |
| Signed role and account ID in JWT | Implemented. JWTs include signed `userId`, `roles`, `sessionVersion`, `auth_time`, `iat`, `exp`, `iss`, `aud` and auth version. Signed does not mean encrypted; avoid adding sensitive data. |
| JWT used to authorize requests | Protected routes verify the JWT and resolve the current account. Current DB roles/status/ownership and server-verified subscription benefits override stale JWT claims. Client decoding only controls presentation. |
| No DB login sessions | Preserved. There is no per-login session collection. The existing scalar account `sessionVersion` supports revocation. Passkey public keys, linked Google identity, short-lived challenges and TTL abuse counters are security records, not stored login sessions. |
| Browser persistence for 30 days after login | Implemented as a fixed maximum. Reloading, activity, token refresh, Google link/disconnect and passkey removal do not reset it. Expiry requires a new login. Revocation, deleted accounts, browser storage clearing or policy changes can end access earlier. |
| Website-only API access, explicit public paths and DDoS protection | Not fully met; see remaining findings below. No production firewall changes were authorized or applied. |

Google signature/audience/issuer validation uses Google's verification library, with additional verified-email, nonce and same-account checks. See [Google's ID-token verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token). WebAuthn tests exercise real generated P-256 signatures; browser/OS prompts still require device support and user presence.

## Remaining findings and recommended next work

### 1. Service-key access can fail open — high, potentially critical exposure

`middleware/pass-secure.js` checks the key only when `APP_ENV=prod`. If both the configured key and header are missing, its comparison also accepts the request. `/google-scripts` and `/mobile` are mounted before the normal firewall/rate limiter (`app.js`). `controllers/Integration/google-scripts-controllers.js` returns `User.find()` without a safe projection, including password hashes and private profile data.

Require a nonempty server key in every environment, fail closed on missing configuration, use constant-time comparison, scope keys per integration, add explicit output-field allowlists and separate throttles. Never export password hashes or authentication metadata. Confirm each integration's actual field needs before narrowing the contract. Production configuration and endpoint exposure were not tested.

### 2. Profile email/password changes — addressed in the cookie/confirmation follow-up

The original finding was that `patchUserInfo` changed credentials with only the existing bearer token. It now saves ordinary profile fields separately and holds email/password changes pending approval from the current email address. Changing email also requires verification of the proposed new address. Neither credential changes until all required confirmations complete.

Confirmation tokens are random, HMAC-hashed, single-use and expire after one hour. A transaction applies the change, consumes the challenge and increments `sessionVersion`, fenced against concurrent migration, password reset and account changes. Email changes disconnect the previous Google identity; passkeys remain registered. Final notifications go to the old and new addresses. The initiating browser can receive a replacement cookie with its original deadline; an email link does not automatically authenticate another browser. See [cookie sessions and profile confirmation](cookie-sessions-and-profile-confirmation.md) for deployment and residual limitations.

### 3. Origin allowlisting is not API authentication — high

`middleware/firewall.js` accepts allowed Origin/Referer values and trusts `do-connecting-ip`. Non-browser clients can supply those headers. `app.js` also sets `trust proxy=true`, so IP security depends on the actual ingress proxy overwriting forwarded headers and preventing direct-origin access. This must be verified, not assumed. [Express's proxy guidance](https://expressjs.com/en/guide/behind-proxies/) explains why the proxy configuration must match the deployment.

Recommended access split:

| Caller/path class | Protection |
| --- | --- |
| Website account requests | Same-origin Next.js backend-for-frontend; server-only service credential to the API **plus** the user's verified JWT and resource authorization. Reject open-proxy destinations and arbitrary forwarded headers. |
| Trusted integrations | Separate scoped service credentials or mTLS/network rules; not browser-domain claims. |
| Public news/events/SEO data | Explicit read-only, method/path allowlist with safe projections, caching and edge rate limits; no user data. |
| Stripe webhooks | Dedicated public ingress with raw-body Stripe signature verification, replay/idempotency protection and a suitable separate rate budget. Do not rely on Stripe Origin headers. |

Keep a precise browser CORS allowlist as browser policy, but not as the authorization boundary. Inventory old preview domains and remove those no longer controlled/needed. No secret should ever be shipped in `NEXT_PUBLIC_*`. A publicly reachable website proxy can still be called by bots: “website-only” means the API trusts the website server, not that only humans can call the website. See [OWASP REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).

### 4. Global abuse protection is incomplete — high

The existing `middleware/firewall.js` limiter skips GET, uses process-local memory, allows 100 writes/hour/IP and does not cover early-mounted service routes. It is neither a distributed limiter nor volumetric DDoS protection. The new password/account limiter mitigates credential attacks but does not fix this architecture or trusted-IP configuration.

Use managed edge DDoS/WAF protection and distributed rate limits with separate budgets for public reads, login, reset, support uploads, authenticated writes, expensive exports and service callbacks. Add bounded pagination, request/file size limits and timeouts. Keep legitimate callbacks out of low browser-write budgets; exempting a route from domain filtering must not exempt it from authentication/abuse protection. Mongo TTL counters still cost database work; edge rejection should happen first under attack.

### 5. Unprotected maintenance and reporting endpoints — high / medium

`routes/Events/events-routes.js` exposes `POST /event/sync-calendar-events` without admin authorization and the controller calls calendar synchronization. `routes/users-routes.js` has a commented-out admin guard on `GET /user/export-vital-stats`; the controller performs expensive queries/spreadsheet generation and writes a local report outside `APP_ENV=prod`. The export implementation aggregates statistics rather than deliberately returning named profiles, so this review does not label it a demonstrated full-profile leak.

Require appropriate admin or narrowly scoped job credentials for maintenance, restore authorization on reporting, validate allowed filters and throttle expensive operations. Inventory all public routes and explicitly test which need no authentication.

### 6. Browser token storage — addressed; residual XSS and logout limitations remain

Account JWTs now live in HttpOnly, Secure, host-only, SameSite=Lax production cookies. The website's same-origin API proxy forwards the JWT server-to-server, strips it from browser response bodies, and enforces signed session-bound CSRF plus exact-origin checks on mutations. An explicit method/path allowlist excludes integrations and webhooks. Legacy localStorage account credentials are purged, not imported. Redux holds public UI metadata only. No DB login-session store was introduced.

HttpOnly reduces JWT theft, but does not make XSS harmless: malicious same-origin code can still act through the browser. Audit CMS HTML sanitization and roll out a tested CSP. Global analytics are excluded from the new email-confirmation page; tokens use URL fragments, are removed from the address bar, and require an explicit approval button rather than a GET mutation. [OWASP's session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) supports server-enforced absolute deadlines and protected cookie handling.

Ordinary logout now clears this browser's HttpOnly cookies through a CSRF-protected POST; it does not revoke a previously stolen copy. Account-wide revocation increments `sessionVersion`. Per-device revocation requires additional state or a different token lifecycle; do not promise it with a completely stateless design. Thirty days is a product choice, not a recommended lifetime for unrestricted administrator operations; add short-lived step-up authentication for sensitive actions.

### 7. Further hardening

- Fail startup on missing/weak signing secrets and inconsistent production environment flags. Use at least 32 cryptographically random bytes for HS256 and a documented rotation procedure. Current secret strength was not disclosed or asserted by this review.
- Reset initiation now has identical success status/body for existing and nonexistent users, but work timing still differs. Login and `/security/check-email` also need an explicit enumeration/abuse policy. Add breached-password checks, consistent byte-length policy and notifications for sensitive account changes.
- Reset email currently uses the existing process-memory mail queue: API acceptance does not prove delivery, and queued mail can be lost during a restart. Use a durable/idempotent transactional email outbox and keep recovery failures observable without logging codes, passwords or recipient content.
- Current password reset revokes JWTs, not registered passkeys or Google identities. Document an account-recovery flow for reviewing/removing unfamiliar sign-in methods after suspected compromise.
- Verify edge TLS/HSTS, cache privacy, service scopes, production dependency advisories and audit-log retention as separate deployment checks. No live infrastructure or new dependency scan was performed here.

## Deployment and validation

Deploy API and website together. Previously issued JWTs lack the immutable login deadline and are deliberately rejected: **everyone must sign in once after rollout**. Old `TemporaryCode` records are no longer accepted; users with a pending old reset must request another code. No production rows were deleted. Remove the obsolete collection separately under an approved retention/cleanup plan.

Keep `JWT_STRING` private; keep `AUTH_VERSION` and `NEXT_PUBLIC_AUTH_VERSION` aligned. No new secret is needed for this patch. Ensure Mongo transaction support and the `PasswordResetChallenge.expiresAt` / `AuthRateLimit.expiresAt` TTL indexes are present. Runtime expiry checks remain authoritative even before TTL cleanup. Password resets use at most one current reset document per account. Throttles are 15-minute fixed buckets: send-reset 3/email, login 10/email, reset verify+complete 10/email; each also caps 30/IP per purpose. Counters expire after the bucket's additional cleanup window.

Verification commands:

```sh
# BGSNL-API: isolated DB/service doubles; API-version test needs loopback listening
node --test tests/jwt-refresh.test.js tests/password-reset.test.js tests/google-auth.test.js tests/passkeys.test.js tests/subscription-*.test.js tests/api-version.test.js tests/form-validation.test.js tests/support-*.test.js tests/event-drafts.test.js tests/payment-return.test.js

# BGSNL: dev-service tests start/stop only their own ephemeral fixtures
node --experimental-vm-modules --test scripts/*.test.mjs
npm run build
```

Results: all 268 selected backend tests and all 157 frontend tests pass; the Next.js production build passes. Loopback fixture tests were rerun with the required local-listener permission. Frontend changed-file lint and new API modules/tests pass. Broad controller lint still reports eight pre-existing errors in legacy functions; confirmed against HEAD, not introduced by this patch. No browser Google popup, hardware passkey ceremony, real reset email or production Mongo transaction was exercised. Real-Mongo concurrency and email-delivery checks belong in isolated staging before rollout.
