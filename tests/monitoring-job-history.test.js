import test from "node:test";
import assert from "node:assert/strict";
import { jobNameFromKey, observeJob, runObservedJob } from "../services/monitoring/job-history.js";

test("queue keys yield a safe job type without recipient or record identifiers", () => {
  assert.equal(jobNameFromKey("addEventToDataPool:record-id:secret"), "add-event-to-data-pool");
  assert.equal(jobNameFromKey("ticket:person@example.test"), "ticket");
});

test("job history stores only fixed metadata and safe error descriptors", async () => {
  const created = [];
  const updated = [];
  const model = {
    create: async (record) => { created.push(record); return { _id: "record" }; },
    updateOne: async (_query, update) => { updated.push(update.$set); },
    deleteOne: async () => {},
  };
  const record = observeJob("mailer", "ticket:private@example.test", { model });
  record.start();
  await record.fail(Object.assign(new Error("token private-value"), { code: "E_CONN" }));
  assert.equal(created[0].name, "unknown");
  assert.equal(updated.at(-1).status, "failed");
  assert.equal(updated.at(-1).errorName, "Error");
  assert.equal(updated.at(-1).errorCode, undefined);
  assert.equal(JSON.stringify(created).includes("private@example.test"), false);
  assert.equal(JSON.stringify(updated).includes("private-value"), false);
});

test("a fast failure cannot be overwritten by a slower started update", async () => {
  const states = [];
  const model = {
    create: async () => ({ _id: "record" }),
    updateOne: async (_query, update) => {
      if (update.$set.status === "pending") await new Promise((resolve) => setTimeout(resolve, 10));
      states.push(update.$set.status);
    },
  };
  const record = observeJob("scheduler", "billing-maintenance", { model });
  record.start();
  await record.fail(new Error("failed"));
  assert.deepEqual(states, ["pending", "failed"]);
});

test("observed work marks result failures and preserves thrown errors", async () => {
  const states = [];
  const observe = () => ({ start: () => states.push("start"), complete: () => states.push("completed"),
    fail: () => states.push("failed"), discard: () => states.push("discarded") });
  const failurePolicy = { canRun: async () => true, success: async () => {}, failure: async () => {} };
  await runObservedJob("scheduler", "birthday-emails", async () => ({ status: "delivery-failed", failed: 1 }), { observe, failurePolicy });
  await runObservedJob("scheduler", "member-event-announcements", async () => ({ failed: 1, skipped: 2 }), { observe, failurePolicy });
  await runObservedJob("scheduler", "birthday-emails", async () => ({ status: "not-due" }), { observe, failurePolicy });
  await assert.rejects(runObservedJob("scheduler", "birthday-emails", async () => { throw new Error("failed"); }, { observe, failurePolicy }));
  assert.deepEqual(states, ["start", "failed", "start", "failed", "start", "discarded", "start", "failed"]);
});

test("skipped scheduler checks preserve the failure streak until work succeeds", async () => {
  let failures = 0;
  const policy = { canRun: async () => true, failure: async () => { failures++; },
    success: async () => { failures = 0; } };
  const observe = () => ({ start() {}, complete: async () => {}, fail: async () => {}, discard: async () => {} });
  await runObservedJob("scheduler", "event-media-cleanup", async () => ({ failed: 1 }), { observe, failurePolicy: policy });
  await runObservedJob("scheduler", "event-media-cleanup", async () => ({ skipped: true }), { observe, failurePolicy: policy });
  assert.equal(failures, 1);
  await runObservedJob("scheduler", "event-media-cleanup", async () => ({ cleared: 1 }), { observe, failurePolicy: policy });
  assert.equal(failures, 0);
});
