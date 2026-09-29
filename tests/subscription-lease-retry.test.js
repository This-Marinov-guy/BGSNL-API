import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { withWebhookBillingRetries, BillingLeaseBusyError } from "../services/subscriptions/lease-retry.js";
import { withBillingLease } from "../services/subscriptions/lease.js";
import { createWebhookErrorObserver } from "../middleware/webhook-error-notification.js";

function fixture(busyAttempts = 0) {
  let now = 0, attempts = 0, writes = 0, releases = 0;
  const waits = [], owners = [];
  const client = {
    set: async (_key, owner, options) => {
      assert.deepEqual(options, { NX: true, PX: 120000 }); owners.push(owner);
      return ++attempts > busyAttempts ? "OK" : null;
    },
    eval: async (_script, { arguments: args }) => { if (args.length === 1) releases++; return 1; },
  };
  const dependencies = { clientFor: async () => client, records: { findById: async () => null },
    fences: { updateOne: async () => { writes++; return { matchedCount: 1 }; } } };
  const options = { now: () => now, random: () => 0, wait: async delay => { waits.push(delay); now += delay; } };
  return { client, dependencies, options, waits, owners, advance: ms => { now += ms; },
    counts: () => ({ attempts, writes, releases }),
    run: work => withWebhookBillingRetries(() => withBillingLease("test-subscription", work, dependencies), options) };
}

test("a busy billing lock waits and then executes the callback exactly once", async () => {
  const h = fixture(3); let calls = 0;
  const value = await h.run(async ({ assertOwned }) => { calls++; await assertOwned(); return "saved"; });
  assert.equal(value, "saved"); assert.equal(calls, 1);
  assert.deepEqual(h.waits, [200, 400, 800]);
  assert.equal(new Set(h.owners).size, 1);
  assert.deepEqual(h.counts(), { attempts: 4, writes: 1, releases: 1 });
});

test("exhausted retries never execute work or release someone else's lock", async () => {
  const h = fixture(Infinity);
  await assert.rejects(h.run(() => assert.fail("Never owned the lease")), error => error instanceof BillingLeaseBusyError && error.statusCode === 409);
  assert.deepEqual(h.waits, [200, 400, 800, 1200, 1600, 2000]);
  assert.deepEqual(h.counts(), { attempts: 7, writes: 0, releases: 0 });
});

test("elapsed request deadline stops retrying, including an oversleep", async () => {
  const h = fixture(Infinity);
  h.options.wait = async () => h.advance(8001);
  await assert.rejects(h.run(() => assert.fail("Must not run")), BillingLeaseBusyError);
  assert.equal(h.counts().attempts, 1);
});

test("ordinary HTTP requests and background sweeps still fail fast", async () => {
  const h = fixture(Infinity);
  await assert.rejects(withBillingLease("test-subscription", () => assert.fail("Must not run"), h.dependencies), BillingLeaseBusyError);
  assert.equal(h.counts().attempts, 1); assert.deepEqual(h.waits, []);
});

test("Redis failures and business errors propagate without replaying work", async () => {
  const h = fixture(); const outage = new Error("Redis unavailable");
  h.client.set = async () => { throw outage; };
  await assert.rejects(h.run(() => assert.fail("Must not run")), error => error === outage);
  assert.deepEqual(h.waits, []);
  const next = fixture(); let calls = 0;
  const businessError = Object.assign(new Error("Conflicting plan change"), { code: 409 });
  await assert.rejects(next.run(() => { calls++; throw businessError; }), error => error === businessError);
  assert.equal(calls, 1); assert.deepEqual(next.waits, []); assert.equal(next.counts().releases, 1);
});

test("nested billing leases share one budget and never replay the outer callback", async () => {
  const h = fixture(2); let outer = 0, nested = 0, busy = 0;
  await assert.rejects(h.run(async () => {
    outer++;
    h.client.set = async () => { busy++; return null; };
    return withWebhookBillingRetries(() => withBillingLease("inner", () => { nested++; }, h.dependencies), h.options);
  }), BillingLeaseBusyError);
  assert.equal(outer, 1); assert.equal(nested, 0); assert.equal(busy, 5);
  assert.equal(h.waits.length, 6); assert.equal(h.counts().releases, 1);
});

test("concurrent webhook deliveries have independent retry budgets", async () => {
  const first = fixture(5), second = fixture(5);
  await Promise.all([first.run(() => "one"), second.run(() => "two")]);
  assert.equal(first.waits.length, 5); assert.equal(second.waits.length, 5);
  assert.equal(first.counts().writes, 1); assert.equal(second.counts().writes, 1);
});

test("a second delivery waits for the first owner and both complete without overlapping work", async () => {
  let owner, running = 0, completed = 0, unblock, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const client = {
    set: async (_key, next) => { if (owner) return null; owner = next; return "OK"; },
    eval: async (_script, { arguments: args }) => {
      if (owner !== args[0]) return 0;
      if (args.length === 1) owner = null;
      return 1;
    },
  };
  const dependencies = { clientFor: async () => client, records: { findById: async () => null },
    fences: { updateOne: async () => ({ matchedCount: 1 }) } };
  const first = withWebhookBillingRetries(() => withBillingLease("same-subscription", async ({ assertOwned }) => {
    running++; started(); await gate; await assertOwned(); running--; completed++;
  }, dependencies));
  await ready;
  let waits = 0;
  const second = withWebhookBillingRetries(() => withBillingLease("same-subscription", async ({ assertOwned }) => {
    assert.equal(running, 0); running++; await assertOwned(); running--; completed++;
  }, dependencies), { wait: async () => { waits++; unblock(); await first; }, random: () => 0 });
  await Promise.all([first, second]);
  assert.equal(completed, 2); assert.equal(waits, 1); assert.equal(owner, null);
});

test("recovered deliveries do not alert; persistent contention and genuine errors still do", async () => {
  for (const mode of ["recovered", "busy", "failure"]) {
    const h = fixture(mode === "busy" ? Infinity : 2), alerts = [];
    const res = new EventEmitter(); res.locals = { verifiedWebhookEvent: { eventId: "evt_fixture", eventType: "invoice.payment_failed" } };
    createWebhookErrorObserver(data => alerts.push(data), () => {})({}, res, () => {});
    try {
      await h.run(() => { if (mode === "failure") throw new Error("Processing failed"); });
      res.statusCode = 200;
    } catch { res.statusCode = 503; }
    res.emit("finish");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alerts.length, mode === "recovered" ? 0 : 1);
    if (alerts.length) assert.equal(alerts[0].status, 503);
  }
});

test("only verified webhook processing receives the retry scope; exhausted processing still returns 503", async () => {
  const source = await readFile(new URL("../controllers/Webhooks/stripe-wh-controllers.js", import.meta.url), "utf8");
  const scope = source.indexOf("return await withWebhookBillingRetries");
  assert.ok(source.indexOf("constructEvent(req.body") < scope);
  assert.ok(source.indexOf("Invalid Stripe webhook signature or configuration") < scope);
  assert.ok(scope < source.indexOf("await captureMemberRevenueEvent"));
  assert.match(source, /next\(new HttpError\("Webhook processing is temporarily unavailable\. Please retry\.", 503\)\)/);
});
