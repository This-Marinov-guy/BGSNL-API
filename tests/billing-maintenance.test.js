import test from "node:test";
import assert from "node:assert/strict";
import { matchesRecord, recordQuery, updateRecord } from "../services/storage/record-operations.js";
import { recoverMembershipCheckouts, recoverSubscriptions } from "../services/subscriptions/maintenance.js";
import { runCoordinatedSchedule } from "../services/jobs/coordinated-schedule.js";
import { recoveryDelay } from "../services/jobs/recovery-backoff.js";
import { BillingLeaseBusyError } from "../services/subscriptions/lease-retry.js";
import { startBillingWorker } from "../services/subscriptions/reminders.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
function memory(initial = []) {
  const rows = structuredClone(initial);
  return {
    rows,
    find: query => recordQuery(async () => rows.filter(row => matchesRecord(row, query)).map(row => structuredClone(row))),
    findById: async id => structuredClone(rows.find(row => row._id === id)),
    updateOne: async (query, update, options = {}) => {
      const index = rows.findIndex(row => matchesRecord(row, query));
      if (index >= 0) rows[index] = updateRecord(rows[index], update);
      else if (options.upsert) rows.push(updateRecord({ _id: query._id }, update, true));
    },
  };
}
const checkout = (id = "account-checkout:member_one") => ({ _id: id,
  data: { sessionId: "cs_one", stripeRegion: "amsterdam" } });
const payment = id => ({ mode: "subscription", status: "complete",
  metadata: { method: "membership_checkout", checkoutKey: id } });
const user = () => ({ _id: "member_one", id: "member_one", status: "active",
  subscription: { id: "sub_one", syncedAt: new Date(0) } });

test("membership recovery excludes ticket records before making provider requests", async () => {
  const records = memory([checkout(), checkout("signup:email-hash"), checkout("member-ticket:event:user")]);
  const completed = [], regions = [];
  let calls = 0;
  const result = await recoverMembershipCheckouts({ records, now: () => NOW,
    stripeFor: region => { regions.push(region); return { checkout: { sessions: { retrieve: async () => payment(records.rows[calls++]._id) } } }; },
    complete: async session => completed.push(session.metadata.checkoutKey),
  });
  assert.equal(result.failed, 0);
  assert.deepEqual(completed, ["account-checkout:member_one", "signup:email-hash"]);
  assert.deepEqual(regions, ["amsterdam", "amsterdam"]);
  assert.equal(records.rows[2].recovery, undefined);
});

test("missing region never falls back to the national payment account", async () => {
  const row = checkout(); delete row.data.stripeRegion;
  const records = memory([row]), errors = [];
  const result = await recoverMembershipCheckouts({ records, now: () => NOW,
    stripeFor: () => assert.fail("Must not choose a fallback account"), report: (...args) => errors.push(args) });
  assert.equal(result.failed, 1); assert.equal(errors.length, 1);
  assert.equal(records.rows[0].recovery.nextAttemptAt.getTime(), NOW + 300_000);
});

test("a non-membership or mismatched checkout is never fulfilled as a subscription", async () => {
  for (const override of [{ mode: "payment" }, { metadata: { method: "event" } },
    { metadata: { method: "membership_checkout", checkoutKey: "signup:other" } }]) {
    const records = memory([checkout()]);
    const result = await recoverMembershipCheckouts({ records, now: () => NOW,
      stripeFor: () => ({ checkout: { sessions: { retrieve: async () => ({ ...payment(records.rows[0]._id), ...override }) } } }),
      complete: () => assert.fail("Do not fulfill this payment"), report: () => {},
    });
    assert.equal(result.failed, 1);
    assert.equal(records.rows[0].completedAt, undefined);
  }
});

test("an invalid region never reaches the provider client's default fallback", async () => {
  const row = checkout(); row.data.stripeRegion = "unknown-region";
  assert.equal((await recoverMembershipCheckouts({ records: memory([row]), report: () => {},
    stripeFor: () => assert.fail("Unknown account must not be queried"),
  })).failed, 1);
});

test("missing resources back off for a day and survive a fresh worker instance", async () => {
  const records = memory([checkout()]); let calls = 0;
  const options = { records, now: () => NOW, report: () => {}, stripeFor: () => ({ checkout: { sessions: {
    retrieve: async () => { calls++; throw Object.assign(new Error("missing"), { code: "resource_missing" }); },
  } } }) };
  assert.equal((await recoverMembershipCheckouts(options)).failed, 1);
  assert.equal((await recoverMembershipCheckouts({ ...options })).failed, 0);
  assert.equal(calls, 1);
  assert.equal(records.rows[0].recovery.nextAttemptAt.getTime(), NOW + 86400_000);
  assert.equal(records.rows[0].completedAt, undefined);
});

test("transient errors back off exponentially, capped at six hours", () => {
  assert.deepEqual([1, 2, 3].map(n => recoveryDelay(n)), [300_000, 600_000, 1200_000]);
  assert.equal(recoveryDelay(1000), 6 * 3600_000);
  assert.equal(recoveryDelay(2, new BillingLeaseBusyError()), 60_000);
});

test("busy checkout locks are deferred, not counted as failures", async () => {
  const records = memory([checkout()]);
  const result = await recoverMembershipCheckouts({ records, now: () => NOW,
    stripeFor: () => ({ checkout: { sessions: { retrieve: async () => payment(records.rows[0]._id) } } }),
    complete: async () => { throw new BillingLeaseBusyError(); }, report: () => assert.fail("Expected contention is not an error"),
  });
  assert.equal(result.failed, 0); assert.equal(records.rows[0].recovery.attempts, 0);
  assert.equal(records.rows[0].recovery.nextAttemptAt.getTime(), NOW + 60_000);
});

test("successful reads reset retry state; expired checkouts remove registration secrets", async () => {
  for (const status of ["open", "expired"]) {
    const row = checkout(); row.data.registration = { password: "synthetic" }; row.recovery = { attempts: 3 };
    const records = memory([row]);
    await recoverMembershipCheckouts({ records, now: () => NOW,
      stripeFor: () => ({ checkout: { sessions: { retrieve: async () => ({ ...payment(row._id), status }) } } }),
    });
    if (status === "open") assert.equal(records.rows[0].recovery.attempts, 0);
    else { assert.ok(records.rows[0].completedAt); assert.equal(records.rows[0].data.registration, undefined); }
  }
});

test("failure from an old checkout cannot postpone its replacement", async () => {
  const records = memory([checkout()]);
  await recoverMembershipCheckouts({ records, now: () => NOW, report: () => {},
    stripeFor: () => ({ checkout: { sessions: { retrieve: async () => {
      records.rows[0].data.sessionId = "cs_replacement"; throw new Error("old request failed");
    } } } }),
  });
  assert.equal(records.rows[0].recovery, undefined);
});

test("subscription recovery honors backoff and does not treat business 409s as lock skips", async () => {
  const model = memory([user()]); let calls = 0;
  const options = { models: [model], now: () => NOW, report: () => {}, reconcile: async () => {
    calls++; throw Object.assign(new Error("conflict"), { code: 409 });
  } };
  assert.equal((await recoverSubscriptions(options)).failed, 1);
  assert.equal((await recoverSubscriptions(options)).failed, 0);
  assert.equal(calls, 1); assert.equal(model.rows[0].subscription.recoveryAttempts, 1);
});

test("a concurrent successful webhook cannot be overwritten by failure backoff", async () => {
  const model = memory([user()]);
  await recoverSubscriptions({ models: [model], now: () => NOW, report: () => {}, reconcile: async () => {
    model.rows[0].subscription.syncedAt = new Date(NOW); throw new Error("stale error");
  } });
  assert.equal(model.rows[0].subscription.recoveryAttempts, undefined);
});

test("busy subscription leases are not failures and preserve verified access", async () => {
  const model = memory([user()]);
  assert.equal((await recoverSubscriptions({ models: [model], now: () => NOW,
    reconcile: async () => { throw new BillingLeaseBusyError(); }, report: () => assert.fail("No error"),
  })).failed, 0);
  assert.equal(model.rows[0].subscription.recoveryAttempts, 0);
  assert.equal(model.rows[0].status, "active");
  assert.equal(model.rows[0].subscription.syncedAt.getTime(), 0);
});

function coordinatorFixture() {
  const records = memory(), locks = new Set(), observed = [];
  let time = NOW;
  const options = { records, now: () => time,
    observe: async (_source, name, work) => { observed.push(name); return work(); },
    withLease: async (key, work) => {
      if (locks.has(key)) throw new BillingLeaseBusyError();
      locks.add(key);
      try { return await work({ record: await records.findById(key) || { _id: key }, assertOwned: async () => {} }); }
      finally { locks.delete(key); }
    },
  };
  return { records, observed, options, advance: ms => { time += ms; },
    run: work => runCoordinatedSchedule("billing-maintenance", work, options) };
}

test("two processes execute one sweep per interval, including fast and overlapping work", async () => {
  const h = coordinatorFixture(); let runs = 0;
  await Promise.all([h.run(async () => { runs++; }), h.run(async () => { runs++; })]);
  await h.run(async () => { runs++; });
  assert.equal(runs, 1); assert.equal(h.observed.length, 1);
  h.advance(60_000); await h.run(async () => { runs++; }); assert.equal(runs, 2);
});

test("scheduler failures remain errors, persist backoff, and recover when due", async () => {
  const h = coordinatorFixture();
  await assert.rejects(h.run(async () => { throw new Error("outage"); }), /outage/);
  h.advance(60_000);
  assert.deepEqual(await h.run(() => assert.fail("Too early")), { skipped: true });
  h.advance(240_000); await h.run(async () => {});
  assert.equal(h.records.rows[0].failures, 0);
});

test("coordinator does not swallow business errors or lost lease ownership", async () => {
  const h = coordinatorFixture();
  await assert.rejects(h.run(async () => { throw Object.assign(new Error("business"), { code: 409 }); }), /business/);
  const error = new Error("lease lost");
  h.options.withLease = async (_key, work) => work({ record: {}, assertOwned: async () => { throw error; } });
  await assert.rejects(h.run(() => assert.fail("Must not run without ownership")), error);
});

test("stopping recovery avoids further provider calls", async () => {
  const records = memory([checkout()]);
  assert.deepEqual(await recoverMembershipCheckouts({ records, shouldStop: () => true,
    stripeFor: () => assert.fail("Stopped"),
  }), { failed: 0, processed: 0 });
});

test("revenue errors back off independently and cannot block membership recovery", async () => {
  let tick, now = NOW, billing = 0, revenue = 0;
  const stop = startBillingWorker({ env: { NODE_ENV: "production" }, now: () => now,
    schedule: callback => { tick = callback; return { unref() {} }; }, cancel: () => {}, report: () => {},
    coordinate: async (name, work) => {
      if (name === "member-revenue-maintenance") { revenue++; throw new Error("reporting outage"); }
      billing++; return work({ assertOwned: async () => {} });
    }, reminders: async () => ({ failed: 0 }), checkouts: async () => ({ failed: 0 }), subscriptions: async () => ({ failed: 0 }),
  });
  await tick(); now += 60_000; await tick();
  assert.equal(billing, 2); assert.equal(revenue, 1);
  await stop(); now += 3600_000; await tick(); assert.equal(billing, 2);
});
