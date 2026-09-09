import test from "node:test";
import assert from "node:assert/strict";
import {
  isMemberPriceCheckout,
  isRestrictedTicketAccount,
  isExistingMemberTicket,
  memberTicketClaimKey,
  memberTicketDuplicateMatcher,
  normalizeCheckoutQuantity,
} from "../services/tickets/member-ticket-policy.js";

test("member checkout accepts exactly one ticket", () => {
  assert.equal(normalizeCheckoutQuantity(undefined, "member"), 1);
  assert.equal(normalizeCheckoutQuantity("1", "member"), 1);
  assert.equal(normalizeCheckoutQuantity("2", "member"), null);
  assert.equal(normalizeCheckoutQuantity(10, "guest"), 10);
});

test("only active accounts may retain member tickets", () => {
  assert.equal(isRestrictedTicketAccount({ status: "active" }), false);
  for (const status of ["locked", "frozen", "suspended", "payment_awaiting"]) {
    assert.equal(isRestrictedTicketAccount({ status }), true);
  }
  assert.equal(isRestrictedTicketAccount(null), true);
});

test("member price is distinguished from the guest-price fallback", () => {
  assert.equal(isMemberPriceCheckout({ normalTicket: "false" }), true);
  assert.equal(isMemberPriceCheckout({ normalTicket: "true" }), false);
  assert.equal(isMemberPriceCheckout({ memberPriceApplied: "false" }), false);
});

test("member claims are stable per event and account", () => {
  assert.equal(memberTicketClaimKey("event", "account"), "member-ticket:event:account");
});

test("duplicate matching supports stable account IDs and legacy email records", () => {
  const matcher = memberTicketDuplicateMatcher({
    userId: "account",
    userIds: ["previous-account"],
    email: "Member+test@example.com",
  });

  assert.equal(matcher.type, "member");
  assert.equal(matcher.refunded.$ne, true);
  assert.deepEqual(matcher.$or[0], { userId: "account" });
  assert.deepEqual(matcher.$or[1], { userId: "previous-account" });
  assert.equal(matcher.$or[2].email.$options, "i");
  assert.equal(matcher.$or[2].email.$regex, "^member\\+test@example\\.com$");
});

test("only unrefunded member-price records consume the account benefit", () => {
  const identity = { userId: "account", email: "member@example.com" };

  assert.equal(isExistingMemberTicket({ type: "member", userId: "account" }, identity), true);
  assert.equal(isExistingMemberTicket(
    { type: "member", userId: "previous-account" },
    { ...identity, userIds: ["previous-account"] }
  ), true);
  assert.equal(isExistingMemberTicket({ type: "member", email: "MEMBER@example.com" }, identity), true);
  assert.equal(isExistingMemberTicket({ type: "guest", userId: "account" }, identity), false);
  assert.equal(isExistingMemberTicket({ type: "member", userId: "account", refunded: true }, identity), false);
});
