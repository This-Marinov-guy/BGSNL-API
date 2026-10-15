import test from "node:test";
import assert from "node:assert/strict";
import { createGuestSignupToken, verifyGuestSignupToken } from "../services/events/guest-signup-prefill.js";

const env = { GUEST_SIGNUP_LINK_SECRET: "test-guest-signup-secret-at-least-32-characters" };
const details = { region: "groningen", name: "Guest", surname: "Person", email: "Guest@example.test", phone: "+31612345678" };

test("guest signup details are authenticated, encrypted and expire", () => {
  const now = Date.UTC(2026, 9, 5);
  const token = createGuestSignupToken(details, { env, now });
  assert.doesNotMatch(token, /Guest|example|31612345678|groningen/);
  assert.deepEqual(verifyGuestSignupToken(token, { env, now: now + 86400000 }), { ...details, email: "guest@example.test" });
  const changed = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.throws(() => verifyGuestSignupToken(changed, { env, now }), { statusCode: 410 });
  assert.throws(() => verifyGuestSignupToken(token, { env, now: now + 91 * 86400000 }), { statusCode: 410 });
});
