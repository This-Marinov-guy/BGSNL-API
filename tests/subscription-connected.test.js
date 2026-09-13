import assert from "node:assert/strict";
import test from "node:test";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { memberRevenueAllocation } from "../util/config/member-revenue.js";
import { hasMemberConnectAllocation } from "../services/subscriptions/connected.js";
import { backfillSubscriptionConnected, connectedBackfillChange } from "../scripts/backfill-subscription-connected.js";

const plan = MEMBERSHIP_PLANS.find(p => p.type === "member");
const subscription = { id: "sub_one", customerId: "cus_one", stripeRegion: "netherlands", priceId: plan.priceId };
const allocation = { ...memberRevenueAllocation(plan, "amsterdam", { MEMBER_REVENUE_SHARING_ENABLED: "true" }), subscriptionId: "sub_one", customerId: "cus_one" };

test("new Member/Alumni accounts explicitly default to connected false", () => {
  for (const Model of [User, AlumniUser]) {
    assert.equal(new Model().subscription.connected, false);
    assert.equal(Model.hydrate({ _id: "legacy", subscription: { id: "sub_old" } }).subscription.connected, false);
  }
});
test("Alumni cannot inherit true while Member documents retain a verified true value", () => {
  assert.equal(new User({ subscription: { ...subscription, connected: true } }).subscription.connected, true);
  const alumni = new AlumniUser({ subscription: { ...subscription, connected: true } });
  assert.equal(alumni.subscription.connected, false);
  alumni.subscription.connected = true;
  assert.equal(alumni.subscription.toObject().connected, false);
});
test("only a matching enrolled central Member subscription is connected", () => {
  assert.equal(hasMemberConnectAllocation(subscription, allocation), true);
  for (const [sub, data] of [
    [subscription, null], [subscription, { ...allocation, customerId: "cus_other" }],
    [subscription, { ...allocation, subscriptionId: "sub_previous" }],
    [subscription, { ...allocation, accountId: "acct_invented" }],
    [{ ...subscription, stripeRegion: "rotterdam" }, allocation],
    [{ ...subscription, priceId: MEMBERSHIP_PLANS.find(p => p.type === "alumni").priceId }, allocation],
    [{ ...subscription, priceId: undefined }, allocation],
  ]) assert.equal(hasMemberConnectAllocation(sub, data), false);
});
test("backfill corrects missing/stale flags and Alumni without altering billing fields", () => {
  const doc = { _id: "member", subscription: { ...subscription, connected: true } };
  assert.equal(connectedBackfillChange(doc, "member", allocation), null);
  const alumni = connectedBackfillChange(doc, "alumni", allocation);
  assert.deepEqual(alumni.update, { $set: { "subscription.connected": false } });
  assert.deepEqual(alumni.filter.subscription, doc.subscription);
  assert.equal(connectedBackfillChange(doc, "member", undefined).update.$set["subscription.connected"], false);
  for (const d of [{ _id: "missing" }, { _id: "null", subscription: null }]) {
    assert.deepEqual(connectedBackfillChange(d, "member").update, { $set: { subscription: { connected: false } } });
  }
});
function harness() {
  const writes = []; const backups = [];
  const collection = (docs) => ({ find: () => (async function* () { yield* docs; })(), updateOne: async (...args) => {
    assert.equal(backups.length, 1); writes.push(args); return { matchedCount: 1, modifiedCount: 1 };
  } });
  const deps = {
    members: collection([{ _id: "old", subscription: { id: "sub_old" } }, { _id: "split", subscription }]),
    alumni: collection([{ _id: "alumni", subscription: { ...subscription, connected: true } }]),
    records: collection([{ _id: "member-revenue-subscription:sub_one", data: allocation }]),
    saveBackup: async (...args) => backups.push(args),
  };
  return { writes, backups, deps };
}
test("dry-run is read-only; apply writes only the flag after creating a private backup", async () => {
  const h = harness();
  const dry = await backfillSubscriptionConnected(h.deps);
  assert.equal(dry.member.connected, 1); assert.equal(dry.alumni.connected, 0);
  assert.equal(h.writes.length, 0); assert.equal(h.backups.length, 0);
  const applied = await backfillSubscriptionConnected({ ...h.deps, apply: true, backupPath: "/tmp/test-connected-backup.json" });
  assert.equal(applied.modified, 3); assert.equal(applied.conflicts, 0);
  assert.equal(h.backups[0][2].flag, "wx"); assert.equal(h.backups[0][2].mode, 0o600);
  assert.deepEqual(h.writes.map(([, update]) => update.$set["subscription.connected"]), [false, true, false]);
});
test("backup failure prevents writes and concurrent account changes are reported", async () => {
  const h = harness();
  await assert.rejects(backfillSubscriptionConnected({ ...h.deps, apply: true, backupPath: "test", saveBackup: async () => { throw new Error("backup failed"); } }), /backup failed/);
  assert.equal(h.writes.length, 0);
  h.deps.members.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 });
  const result = await backfillSubscriptionConnected({ ...h.deps, apply: true, backupPath: "test" });
  assert.equal(result.conflicts, 2); assert.equal(result.modified, 1);
});
