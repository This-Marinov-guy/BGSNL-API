# Google account linking and sign-in

## Enable the feature

1. Create/select a Google OAuth **Web application** client and configure the BGSNL branding/consent screen. Use only basic identity scopes; Gmail, Drive and Calendar access are not requested. Follow [Google's setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
2. Authorize the exact JavaScript origins `https://bulgariansociety.nl` and `https://www.bulgariansociety.nl`. For local testing add `http://localhost` and the actual development origin, such as `http://localhost:3000`. The API permits local ports 3000–3002 only outside production. Add authorized test users while the Google app is in testing mode.
3. Set `GOOGLE_SIGN_IN_CLIENT_ID` on the **API** to that public client ID and restart it. No Google client secret is needed or accepted by this ID-token/popup integration. The website obtains the client ID from the API when creating a challenge; there is no additional frontend environment variable.
4. Deploy the API before the website. MongoDB must support transactions (Atlas/replica set). Startup initializes the `AccountIdentity` unique indexes and TTL indexes for `AuthChallenge` and `AuthRateLimit` before accepting requests.
5. Ensure outbound HTTPS access to Google's signing-key endpoints. The existing `googleapis` dependency supplies Google's official ID-token verifier; no new dependency is required.

The implementation uses the Google Identity Services JavaScript popup/FedCM callback, not a redirect callback. There is no new OAuth redirect endpoint to register. Login/account pages preserve no-index headers, send only the origin on cross-origin production referrers, and permit the Google popup fallback. A hosting-layer CSP must also allow Google's GIS script, frame and connection URLs listed in the setup guide; this change does not replace a hosting-layer CSP.

If the client ID is absent, Settings explains that Google is not enabled and its connect button is disabled. Password login remains functional; the public login page does not show an unusable Google button.

## Account behaviour and security

- Settings → Sign-in methods → Connect Google first requires the current BGSNL password, then automatically starts Google's One Tap/FedCM prompt. Google's own button remains available if the browser suppresses the automatic prompt. Google consent is still required; no SDK button clicks are simulated. See [Google's JavaScript reference](https://developers.google.com/identity/gsi/web/reference/js-reference).
- Only BGSNL accounts whose email ends in **`@gmail.com`** can connect Google. The verified Google token must contain **the same address** as the current BGSNL profile. Comparison ignores capitalization and surrounding whitespace only; dot/plus aliases, `googlemail.com`, Workspace and other domains are not treated as matches. Google does not change the profile email, password, membership, tier, billing customer or benefits.
- Eligibility and address matching are enforced when preparing the challenge, consuming the verified credential, and inside the transaction saving the identity. The challenge binds the email as well as the password/session; changing the email invalidates a pending link. The API supplies the account email as `loginHint` to Google, but the hint is only a convenience, never authorization.
- Existing mismatched/non-Gmail identities are not deleted automatically, but cannot be used for new Google logins. The account owner can still sign in with their BGSNL password and disconnect the old identity. Current sessions are not bulk-revoked by this update.
- Google login is available only **after explicit linking**. There is no email-based auto-link, automatic signup, or bypass of the existing membership registration flow. Identity is keyed by Google's verified stable `sub`, not by an email supplied by the browser. See [Google's server verification guidance](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
- The backend verifies the Google signature, issuer, exact client audience/authorized party, expiry, issued-at, verified email and server nonce. Challenges last five minutes, are bound to the browser's random proof and origin, and are atomically single-use. Linking also binds the account and its password hash at password confirmation time.
- JSON-only mutation endpoints enforce an exact origin allowlist. No session or Google token is placed in a URL. No Google access token or refresh token is stored. Credentials, password proofs and challenges are redacted from application logs.
- Unique indexes prevent one Google subject from being connected to two accounts and prevent silently replacing an account's existing Google identity. Transactions fence concurrent profile/password changes and member/alumni migrations. The managed membership conversion updates identity ownership in the same transaction, preserving old ID aliases and session revocation counters.
- Disconnecting requires the BGSNL password. It deletes the local Google identity and increments the account session version, revoking old sessions (both password and Google sessions). The current browser receives a replacement token; password login remains available. Google's separate consent record can be removed in the user's Google account if desired.
- Member/alumni changes for accounts with connected sign-in history use account settings, not the legacy administrator conversion endpoints, which do not preserve identity/session history safely.
- Both login methods share subscription verification. Payment failures and administrative suspensions cannot be bypassed by switching login methods. Billing outages leave login available but benefits unavailable until verification succeeds.
- Account password confirmations are capped at five attempts per 15-minute bucket; Google challenge/credential requests are capped at 30 per IP bucket, stored durably across API processes. Keep the hosting proxy's client-IP forwarding trusted; the application retains its existing proxy configuration.

## Endpoints

All paths are relative to `/api/v1/security`. Only configuration and Google-login endpoints are public. Link, disconnect and connected-account status require the current bearer token.

| Endpoint | Body / result |
| --- | --- |
| `GET /google/config` | `{ enabled }` |
| `GET /connected-accounts` | Google `{ enabled, eligible, accountEmail, connected, email }`; passkeys `{ available: true }` |
| `POST /google/login/challenge` | `{ proof }` → server nonce, challenge ID, client ID, expiry |
| `POST /google/login` | `{ proof, challengeId, credential }` → existing BGSNL login response |
| `POST /google/link/challenge` | `{ proof, password }` → account/email-bound challenge and server-derived `loginHint` |
| `POST /google/link` | `{ proof, challengeId, credential }` → connection status and refreshed token |
| `POST /google/disconnect` | `{ password }` → disconnected status and replacement token |

## Verification

Run `node --test tests/google-auth.test.js tests/subscription-auth-and-migration.test.js`, then the complete API tests and website production build. In the website repo, also run `node --test scripts/google-connection.test.mjs`. Automated tests use deterministic identity/database/SDK doubles; they do not link real Google accounts or operate live subscriptions.

After configuring an authorized Google test client/user, verify the actual browser consent flow on desktop and mobile: connect, cancel the popup, sign out/in with Google, incorrect password, wrong/unlinked Google account, disconnect, password fallback, revoked-token rejection, member → alumni → member with the same Google connection, expired challenges, blocked popups, and disabled third-party cookies/FedCM fallback. Confirm a locked member remains locked after Google login. No real account was linked during implementation.

## Failure feedback and recovery

- Errors and recovery notices use the website's title-free toasts. Password, email mismatch, authorization, rate-limit and provider failures remain actionable; raw network errors and HTML/JSON parser failures are not shown.
- Google script loading has a 15-second limit. API requests have a 20-second timeout and are not automatically retried. A failed link response is not proof that the server did not save it; refresh Sign-in methods before retrying if the connection is uncertain. Saving the same verified identity again does not create duplicates.
- When Google reports an unavailable/skipped prompt, the user gets recovery instructions immediately. FedCM can omit these notifications entirely; after 12 seconds without a credential, a neutral **still waiting** notice explains how to allow Google sign-in/popups or use the fallback button. This is not treated as denial: the user can still finish an open Google consent window. Clicking the fallback button starts a fresh waiting watchdog.
- Cancellation/unmount clears timers and cancels One Tap where supported; late or duplicate credentials cannot submit another link. The five-minute challenge expiry ends the attempt with a retry message. A completed credential clears the prompt watchdog before API verification.
- If a content blocker prevented Google's script from loading, allow the script and refresh the page before retrying. Google browser consent, popup blocking, provider downtime and origin/client configuration cannot be bypassed by the website.

## Passkeys

Direct BGSNL passkey registration and sign-in are available independently of Google. See [Passkey sign-in](passkeys.md) for setup, security controls and recovery. A passkey used inside Google authentication belongs to the Google account and is separate from a BGSNL passkey.
