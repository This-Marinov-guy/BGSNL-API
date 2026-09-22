import test from "node:test";
import assert from "node:assert/strict";
import { membershipAccountReady } from "../services/payments/account-readiness.js";

const session = { mode: "subscription", subscription: "sub_1", customer: "cus_1", metadata: { bgsnlFulfilled: "1" } };
const account = { _id: "member_1", status: "active", subscription: { syncedAt: new Date() } };
const wallets = { findOne: async () => ({ token: "a".repeat(22) }) };

test("readiness waits for webhook completion, account reconciliation and wallet persistence", async () => {
  let current = null;
  const findAccount = async (query) => {
    assert.deepEqual(query, { "subscription.id": "sub_1", "subscription.customerId": "cus_1", "subscription.stripeRegion": "netherlands" });
    return current;
  };
  assert.equal(await membershipAccountReady({ ...session, metadata: {} }, "netherlands", { findAccount: () => { throw new Error("must not query"); } }), false);
  assert.equal(await membershipAccountReady(session, "netherlands", { findAccount, wallets }), false);
  current = { ...account, status: "payment_awaiting" };
  assert.equal(await membershipAccountReady(session, "netherlands", { findAccount, wallets }), false);
  current = { ...account, subscription: {} };
  assert.equal(await membershipAccountReady(session, "netherlands", { findAccount, wallets }), false);
  current = account;
  assert.equal(await membershipAccountReady(session, "netherlands", { findAccount, wallets: { findOne: async () => null } }), false);
  for (let repeat = 0; repeat < 3; repeat++) assert.equal(await membershipAccountReady(session, "netherlands", { findAccount, wallets }), true);
  current = { ...account, status: "deleted" };
  assert.equal(await membershipAccountReady(session, "netherlands", { findAccount, wallets }), false);
});

test("database failures fail closed and expanded Stripe identifiers are supported", async () => {
  await assert.rejects(membershipAccountReady(session, "netherlands", { findAccount: async () => { throw new Error("offline"); } }));
  assert.equal(await membershipAccountReady({ ...session, customer: { id: "cus_1" }, subscription: { id: "sub_1" } }, "netherlands",
    { findAccount: async () => account, wallets }), true);
});
