import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAccountForDisplay } from "../services/subscriptions/reconcile.js";

const now = Date.parse("2026-10-21T12:00:00Z");
const account = (overrides = {}) => ({ id: "member_one", status: "active", subscription: {
  id: "sub_one", status: "active", hasBenefits: true,
  syncedAt: new Date(now - 5_000), currentPeriodEnd: new Date(now + 86_400_000),
  ...overrides,
} });

test("display reads reuse a recent persisted subscription while protected reads remain separate", async () => {
  let calls = 0;
  const user = account();
  const result = await reconcileAccountForDisplay(user, { now, reconcile: async () => { calls++; return { user }; } });
  assert.equal(result.cachedDisplay, true);
  assert.equal(calls, 0);
});

test("billing returns and stale snapshots force a current Stripe reconciliation", async () => {
  for (const [user, force] of [
    [account(), true],
    [account({ syncedAt: new Date(now - 31_000) }), false],
    [account({ syncedAt: undefined }), false],
    [account({ currentPeriodEnd: new Date(now - 1_000) }), false],
    [account({ cancelAt: new Date(now - 1_000) }), false],
    [account({ pendingUpdate: true }), false],
  ]) {
    let calls = 0;
    const fresh = { ...user, subscription: { ...user.subscription, status: "canceled", hasBenefits: false } };
    const result = await reconcileAccountForDisplay(user, { now, force, reconcile: async () => { calls++; return { user: fresh }; } });
    assert.equal(calls, 1);
    assert.equal(result.user.subscription.hasBenefits, false);
  }
});
