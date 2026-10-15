import assert from "node:assert/strict";
import test from "node:test";
import { buildGuestTicketSignupUrl, buildTicketTemplateVariables } from "../services/background-services/email-transporter.js";
import { verifyGuestSignupToken } from "../services/events/guest-signup-prefill.js";

test("ticket emails include the event poster and the first ticket link", () => {
  const result = buildTicketTemplateVariables({
    eventName: "Autumn Social", eventDate: "2026-10-17T17:00:00.000Z", guestName: "Alex",
    tickets: ["https://example.test/ticket-1", "https://example.test/ticket-2"],
    poster: "https://res.cloudinary.com/bgsnl/image/upload/v1/events/autumn-social.jpg",
    signupUrl: "https://example.test/groningen/signup?prefill=g1.sample",
  });
  assert.equal(result.template_variables.poster,
    "https://res.cloudinary.com/bgsnl/image/upload/v1/events/autumn-social.jpg");
  assert.equal(result.template_variables.ticketUrl, "https://example.test/ticket-1");
  assert.deepEqual(result.template_variables.tickets,
    ["https://example.test/ticket-1", "https://example.test/ticket-2"]);
  assert.equal(result.template_variables.eventDate, "17.10 | 19:00");
  assert.equal(result.template_variables.signupUrl,
    "https://example.test/groningen/signup?prefill=g1.sample");
});

test("guest ticket membership link encrypts the purchase details and event region", () => {
  const env = { GUEST_SIGNUP_LINK_SECRET: "test-guest-signup-secret-at-least-32-characters" };
  const now = Date.UTC(2026, 9, 9);
  const link = buildGuestTicketSignupUrl({ email: " ALEX@example.test ", name: "Alex van der Meer",
    phone: "+31612345678", region: "groningen" }, { env, now });
  const url = new URL(link);
  assert.equal(url.pathname, "/groningen/signup");
  assert.doesNotMatch(link, /Alex|31612345678|ALEX/);
  assert.deepEqual(verifyGuestSignupToken(url.searchParams.get("prefill"), { env, now }), {
    region: "groningen", name: "Alex", surname: "van der Meer",
    email: "alex@example.test", phone: "+31612345678",
  });
  assert.equal(buildGuestTicketSignupUrl({ email: "alex@example.test", name: "Alex",
    region: "netherlands" }, { env, now }), "");
});

test("ticket emails omit unsafe or missing poster URLs", () => {
  const input = { eventName: "Event", eventDate: "2026-10-17T17:00:00.000Z",
    guestName: "Alex", tickets: "https://example.test/ticket" };
  assert.equal(buildTicketTemplateVariables({ ...input, poster: "javascript:alert(1)" })
    .template_variables.poster, "");
  assert.equal(buildTicketTemplateVariables(input).template_variables.poster, "");
  assert.equal(buildTicketTemplateVariables(input).template_variables.ticketUrl,
    "https://example.test/ticket");
});
