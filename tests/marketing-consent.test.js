import assert from "node:assert/strict";
import test from "node:test";
import { extractMarketingEmail } from "../middleware/capture-marketing-email.js";

test("successful forms do not become marketing recipients without explicit opt-in", () => {
  assert.equal(extractMarketingEmail({ email: "person@example.test", city: "groningen" }), null);
  assert.equal(extractMarketingEmail({ guestEmail: "person@example.test", region: "groningen", notificationTerms: "false" }), null);
});

test("recorded opt-in carries the consent evidence needed by the recipient model", () => {
  const entry = extractMarketingEmail({
    email: "person@example.test",
    city: "groningen",
    notificationTerms: "true",
    marketingConsentVersion: "terms-2026-09-10",
  });
  assert.equal(entry.email, "person@example.test");
  assert.equal(entry.city, "groningen");
  assert.equal(entry.consent.granted, true);
  assert.equal(entry.consent.textVersion, "terms-2026-09-10");
  assert.ok(entry.consent.recordedAt instanceof Date);
});
