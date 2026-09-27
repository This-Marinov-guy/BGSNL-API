# Passkey sign-in

BGSNL passkeys are independent of Google. Any existing Member or Alumni account can add one in **Settings → Sign-in methods → Passkeys** by confirming its current BGSNL password. Login offers **Sign in with passkey**, with no email entry required. Password and Google sign-in remain available. Passkeys do not create accounts or grant membership benefits.

## Deployment

- Deploy the API before the website, using `npm ci` in both projects. The API runtime is now Node 22+ (the Docker image uses Node 22). The pinned packages are `@simplewebauthn/server` 14.0.1 and `@simplewebauthn/browser` 14.0.0; see the [server](https://simplewebauthn.dev/docs/packages/server) and [browser](https://simplewebauthn.dev/docs/packages/browser) documentation.
- No OAuth client, subscription, passkey-provider account, client secret or extra environment variable is needed. WebAuthn uses the existing website and API.
- Production requires HTTPS on `https://bulgariansociety.nl` or `https://www.bulgariansociety.nl`; both use the RP ID `bulgariansociety.nl`. Development permits HTTP on `localhost:3000`, `:3001` and `:3002` only outside `NODE_ENV=production`. Local credentials use RP ID `localhost` and cannot sign in to production. Changing the production domain requires a planned passkey migration, not simply trusting a new Host header.
- MongoDB must support transactions (Atlas/replica set). Credentials are embedded on accounts; challenges share `temporarycodes`. Credential IDs remain globally unique through account indexes and a shared transaction marker. Challenge expiry has a TTL index and is checked on every verification. Run the migration in [storage-and-redis.md](storage-and-redis.md) before rollout.
- Use the website directly, not an iframe. A hosting-level Permissions-Policy must not disable `publickey-credentials-create` or `publickey-credentials-get` for the website itself. BGSNL does not enable cross-origin embedding for passkeys.

## Controls and recovery

- Device verification is required at creation and sign-in (fingerprint, face, device PIN or a compatible security key). Discoverable credentials are required. Biometric data and device PINs stay with the authenticator; the API stores the credential's public key, ID, opaque user handle, counter, label, transport/backup metadata and usage dates, never a private key.
- Challenges expire after five minutes, are bound to the exact approved origin, RP and a random browser proof, and are atomically single-use. Registration also binds the account, confirmed password hash and session version. Origin, RP, challenge, authenticator flags and signatures are verified on the server using SimpleWebAuthn. Cross-origin ceremonies are rejected.
- Each RP/account allows at most ten keys, checked again in the transaction. Credential revision and account writes prevent deletion, session revocation or membership migration from racing an in-flight authentication. Synced passkeys with zero counters remain supported.
- Removing a key requires the BGSNL password and ownership. It revokes other sessions and replaces the current session token. This removes BGSNL access, not the credential entry in the device's password manager; delete that entry there separately. Password sign-in is never disabled.
- Member ↔ Alumni subscription changes transfer ownership in the same transaction while preserving the authenticator's original user handle. Legacy conversion endpoints reject accounts with passkeys; use the managed subscription flow.
- Passkey login uses the same subscription/benefits verification as password and Google login. A locked/frozen/suspended account does not regain benefits by using a passkey.
- Password-confirmed operations are capped at five per account per 15-minute bucket; passkey requests at 30 per IP bucket. Limits are stored in the dedicated BGSNL Redis container. Proxy configuration must preserve a trusted client IP. Requests, signatures and challenge secrets are redacted from logs.
- Nothing prompts automatically on page load. API calls time out after 20 seconds; device prompts have a 70-second UI watchdog. Cancel/navigation stops the owned prompt and ignores late results. Errors use title-free toasts; cancelling or having no matching credential is not presented as a server outage. If a save/remove request loses its response, refresh Settings to inspect the actual stored state before retrying. Removing a key may have already revoked the session; use password sign-in if necessary.

## API

Paths are under `/api/v1/security`; the existing unversioned alias also defaults to v1. All mutation endpoints require JSON and an approved Origin. All responses are private/no-store. Registration, removal and listing require a valid current bearer session.

| Method/path | Request → response |
| --- | --- |
| `GET /passkeys` | Owned credential labels, IDs, RP IDs and dates |
| `POST /passkeys/login/options` | `{ proof }` → `{ challengeId, options, expiresAt }` |
| `POST /passkeys/login` | `{ proof, challengeId, credential }` → existing login response |
| `POST /passkeys/register/options` | `{ proof, password, name }` → registration options |
| `POST /passkeys/register` | `{ proof, challengeId, credential }` → updated owned list |
| `POST /passkeys/remove` | `{ password, credentialId }` → updated list and refreshed session token |

## Verification

Run `npm run test:passkeys` in both repositories, plus API `npm run test:subscriptions` and website `npm run build`. Backend tests use real generated P-256 signatures and CBOR authenticator responses with in-memory transaction doubles; no real accounts, devices, emails or subscriptions are changed.

Before production rollout, complete a real device smoke test: add a named passkey, sign out, sign in using it, cancel/retry, remove it, verify password fallback and test another supported device/browser. Also test a locked account, Member → Alumni → Member, a synced passkey, and a supported security key. Automated tests do not replace real biometric/PIN consent or a deployed Mongo transaction test.
