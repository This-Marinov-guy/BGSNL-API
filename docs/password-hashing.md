# Password hashing and signup compatibility

The shared implementation is `services/authentication/passwords.js`. No production passwords were migrated or reset. All database-backed verification uses the separate `bgsnl_flow_test_passwords` development database with synthetic accounts; Stripe and email calls are disabled/mocked.

## Hash once, preserve the hash

| Flow | Password handling |
| --- | --- |
| Current paid Member / Alumni signup | Decode the existing encrypted request on the API, validate the original password, hash with bcrypt cost 12, then reserve checkout. Only checkout references go to Stripe; the hash stays in the API database. |
| Current checkout webhook | Validate the trusted pending record contains a supported bcrypt hash and copy that exact hash into the account. Do **not** hash it again. Replays do not replace a password changed after account creation. |
| Internal non-payment creation handlers | Decode the request and use the same shared bcrypt helper before saving the account. Public direct-signup routes remain disabled; no payment bypass or new endpoint was enabled. |
| Pre-deployment Stripe checkout metadata | Retain the legacy decoder and hash the original password once. Only this compatibility path accepts historical password lengths; it cannot be selected by new signup requests. |
| Password reset / email-confirmed profile change | Use the same new-password validation and bcrypt cost. Confirmation copies the pending hash, applies existing transactional protections and revokes old sessions. |
| Password login / Google and passkey password confirmation | Verify the submitted original password using the stored bcrypt salt and work factor. Do not prehash before bcrypt, trim it, enforce new strength rules on old passwords, or rewrite existing hashes. |

The `registration.password` pending-checkout field remains compatible with older API instances during rolling deployment. Its value is a hash, never plaintext. The reader also supports an explicit `passwordHash` field; conflicting or malformed values fail closed. Successful completion removes the registration payload. Existing account migrations retain their existing hash unchanged.

Hash-looking **user input** is still an ordinary password and must be hashed. Accepting it directly because it resembles bcrypt would introduce a credential-injection bypass. Only a validated server-owned reservation may supply an existing hash.

## Policy and compatibility

- bcrypt cost 12 is retained across every writer; salts are generated independently by bcrypt. There is no algorithm migration or mass rehash. Existing `$2a$`, `$2b$` and `$2y$` hashes and earlier work factors remain verifiable.
- New passwords use the existing minimum of eight characters with uppercase, lowercase and a number, with a consistent maximum of **72 UTF-8 bytes**, not 72 characters. Spaces and Unicode are preserved. Signup and profile validation now apply the same bound as reset.
- Login validation no longer trims leading/trailing spaces. Existing weak or longer bcrypt passwords continue to verify under their original rules. bcrypt's historical 72-byte truncation cannot be retroactively fixed without the user choosing a new password; no automatic reset is imposed here.
- The legacy user-data export now excludes `password` at the query, so password hashes are not returned as profile data. Its separate service-key/access-policy findings still require the broader authentication-audit follow-up.
- Client-side AES encoding is not a substitute for TLS or server-side hashing. It remains only for existing request/legacy-checkout compatibility. Historical Stripe metadata is not edited by this work; review old sensitive metadata separately rather than breaking pending purchases.

Keeping bcrypt at cost 12 is a compatibility-focused choice for this existing application. OWASP prefers memory-hard algorithms for new designs and documents bcrypt's minimum work factor and 72-byte limitation; a future Argon2id migration should verify old hashes and upgrade only after successful password authentication, not rehash stored hashes. [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

Stripe metadata is not a credential store. New checkout requests in the tests contain neither raw passwords, their transport-encrypted forms, nor bcrypt hashes. [Stripe metadata guidance](https://docs.stripe.com/metadata)

## Login timing protection

Previously, a missing account returned `401` without bcrypt work, and malformed hashes returned immediately. Valid accounts used bcryptjs's JavaScript string comparison; older work factors completed faster. The verifier now:

- Always performs a bcrypt derivation for credential attempts, using a cost-12 dummy hash for missing accounts or malformed stored hashes. Matching the dummy value can never authenticate an absent/invalid account.
- Derives with the existing salt and work factor, then uses Node's native `crypto.timingSafeEqual` on two fixed-length 60-byte hash buffers. The password itself is not compared character by character, padded, normalized or prehashed. Existing hashes remain compatible.
- Pads verification to a default **750 ms minimum**, using a monotonic clock and asynchronous timers (no busy wait). Password login starts the deadline **before account lookup**. Google/passkey password confirmation starts it at verification. Successful password checks, failures and derivation errors all pass through this padding.
- Returns the same `401 / Invalid credentials` for an unknown account, a bad password or an invalid stored hash. Session creation and billing reconciliation happen only after a successful credential check.
- Keeps malformed/oversized-input validation and the fail-closed IP/account rate limiter ahead of login's expensive work. Those `422`, `429` and infrastructure `503` responses need not resemble credential failures: they depend on request validity, request counts or availability, not whether a password prefix matches. Existing routes accept 1–256 characters for login; the shared verifier additionally bounds UTF-8 processing to 4096 bytes for internal compatibility.

`AUTH_PASSWORD_MIN_MS` is an **optional server-only** setting. It defaults to 750, accepts values from 750 to 5000, and falls back to 750 for invalid/out-of-range values. No environment files, production settings or browser configuration were modified. Set it above the deployment's measured high-percentile **lookup plus verification** time, with headroom, and remeasure after hardware/workload changes. Never expose it as a client-provided deadline or `NEXT_PUBLIC_` variable.

This mitigates observable timing discrepancies; it is **not a proof that the entire HTTP request is constant-time**. When DB latency, event-loop congestion or an unusually expensive legacy hash exceeds the floor, work must finish and the response will take longer. Successful logins also create sessions and may reconcile billing. A timer does not eliminate resource-contention side channels, replace rate limiting/WAF protections, or conceal other intentional account-availability APIs such as `/security/check-email`. Do not lower existing password work factors to meet a timing target or claim production timings from a localhost benchmark. [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [Node timingSafeEqual caveat](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)

## Verification

```sh
# Isolated unit/regression tests; no database or payment access
npm run test:passwords

# Deterministic timing, error, validation and rate-limit regression checks
npm run test:passwords:timing

# Isolated loopback HTTP benchmark; real bcrypt, synthetic account lookup only
npm run benchmark:passwords -- --samples=6

# Explicit opt-in: real development Mongo, synthetic accounts, no outbound HTTP
npm run test:passwords:dev-db
```

The development test refuses production mode, the application's default database (named `test`), all other database namespaces, non-fixture accounts and unexpected collections. It overrides signing/encryption keys in its own process, substitutes fake Stripe credentials and blocks outbound HTTP. It does not start the application/background workers. All writes are constrained to the dedicated database.

Database tests exercise real account persistence, login and refresh-grant creation, Member and Alumni checkout, duplicate/retried webhooks, legacy metadata, internal non-payment handlers, existing bcrypt fixtures, password reset and email-confirmation transactions. The simulated Stripe responses establish only application-flow correctness; no charge or real webhook delivery is performed. Existing real users' passwords were neither obtained nor tested.

After each run, only that run's uniquely named synthetic accounts and associated checkout/auth records are deleted and their removal checked. The empty development collections/indexes remain; the test never drops a database or collection. Do not run the legacy internal creation handlers as a public production signup API: the existing disabled-route policy and broader role/status review still apply.

The timing benchmark does not connect to any database, accepts no external target URL, blocks Stripe/email/Google and other outbound HTTP, and binds only an ephemeral loopback port. It runs the actual validators, controller, bcrypt derivation and native comparison against synthetic account records; session creation and rate-limit storage are excluded. It randomizes case order and reports medians/p95 plus a `reviewRequired` flag when the local spread or overhead is unexpectedly large. Its timing statistics are observations, not a security guarantee or production performance measurement.

### Local observation — 2026-09-10

Six randomized samples per case (72 failed requests), after warm-up, with the 750 ms default:

| Synthetic failed-login case | Median ms | Observed p95 ms |
| --- | ---: | ---: |
| Wrong password, 1 character | 753.58 | 765.29 |
| Wrong password, 16 characters | 753.43 | 759.78 |
| Wrong password, 72 characters | 752.57 | 753.92 |
| Wrong password, 256 characters | 753.20 | 754.46 |
| Wrong Unicode password | 753.40 | 763.14 |
| Near-match, wrong first character | 752.65 | 755.65 |
| Near-match, wrong last character | 753.39 | 757.77 |
| Unknown email | 752.83 | 753.64 |
| Missing stored hash | 754.28 | 772.82 |
| Malformed stored hash | 752.76 | 759.98 |
| Legacy bcrypt cost 4 | 752.84 | 760.25 |
| Legacy bcrypt cost 10 | 753.59 | 756.22 |

Median spread: **1.71 ms**; the benchmark's review flag was false. A synthetic successful login (without real session/billing work) took 752.00 ms. Small sample counts are smoke measurements, not statistically conclusive evidence against timing attacks. A separate initial raw bcrypt sample on this machine took approximately 255–280 ms across input lengths; the added latency is the deliberate verification floor, not increased hashing cost.
