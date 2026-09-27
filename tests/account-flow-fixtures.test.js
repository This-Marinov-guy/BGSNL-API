import test from "node:test";
import assert from "node:assert/strict";
import { accountEntitlements, CURRENT_ACCOUNT_FILTER } from "../util/subscriptions/policy.js";
import {
  ALLOWED_DATABASE,
  FIXTURE_DOMAIN,
  assertSafeTarget,
  buildAccountFlowFixtures,
} from "../scripts/seed-account-flow-fixtures.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const fixtures = buildAccountFlowFixtures({ passwordHash: "already-hashed-test-password", now });
const byEmail = (email) => [
  ...fixtures.users.map((account) => ({ ...account, type: "member" })),
  ...fixtures.alumni.map((account) => ({ ...account, type: "alumni" })),
].filter((account) => account.email === email);

test("fixture database guard accepts only the dedicated flow-test namespace", () => {
  assert.equal(ALLOWED_DATABASE.test("bgsnl_flow_test_local"), true);
  assert.doesNotThrow(() => assertSafeTarget("bgsnl_flow_test_local"));
  for (const unsafe of [undefined, "test", "production", "bgsnl", "bgsnl-test"]) {
    assert.throws(() => assertSafeTarget(unsafe));
  }
});

test("every fixture is isolated, deterministic, and Stripe-network free", () => {
  const all = [...fixtures.users, ...fixtures.alumni];
  assert.equal(all.length, 13);
  assert.equal(new Set(all.map(({ _id }) => _id)).size, all.length);
  for (const account of all) {
    assert.equal(account.email.endsWith(`@${FIXTURE_DOMAIN}`), true);
    assert.equal(account.subscription.id, undefined);
    assert.equal(account.subscription.customerId, undefined);
  }
});

test("member fixtures cover current interactive states", () => {
  const current = fixtures.users.filter(({ status }) => !CURRENT_ACCOUNT_FILTER.status.$nin.includes(status));
  assert.deepEqual(new Set(current.map(({ status }) => status)), new Set([
    "active", "locked", "payment_awaiting", "frozen",
  ]));

  const active = current.find(({ status }) => status === "active");
  const locked = current.find(({ status }) => status === "locked");
  assert.equal(accountEntitlements(active, now.getTime()).memberDiscount, true);
  assert.equal(accountEntitlements(locked, now.getTime()).hasBenefits, false);
});

test("alumni fixtures cover free, paid, locked, awaiting, and frozen states", () => {
  const current = fixtures.alumni.filter(({ status }) => !CURRENT_ACCOUNT_FILTER.status.$nin.includes(status));
  const free = current.find(({ status, tier }) => status === "active" && tier === 0);
  const activePaid = current.find(({ status, tier }) => status === "active" && tier === 2);

  assert.ok(free);
  assert.ok(activePaid);
  assert.ok(current.some(({ status }) => status === "locked"));
  assert.ok(current.some(({ status }) => status === "payment_awaiting"));
  assert.ok(current.some(({ status }) => status === "frozen"));
  assert.equal(accountEntitlements(activePaid, now.getTime()).hasBenefits, true);
  assert.equal(accountEntitlements(free, now.getTime()).hasBenefits, false);
});

test("migration fixtures expose exactly one current account per shared email", () => {
  for (const localPart of ["migrated-to-alumni", "migrated-to-member"]) {
    const pair = byEmail(`${localPart}@${FIXTURE_DOMAIN}`);
    assert.equal(pair.length, 2);
    const current = pair.filter(({ status }) => !CURRENT_ACCOUNT_FILTER.status.$nin.includes(status));
    assert.equal(current.length, 1);
  }
});
