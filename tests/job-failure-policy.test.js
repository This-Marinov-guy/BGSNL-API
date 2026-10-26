import test from "node:test";
import assert from "node:assert/strict";
import { createJobFailurePolicy } from "../services/monitoring/job-failure-policy.js";

function stateModel() {
  const states = new Map();
  const query = value => ({ lean: async () => value ? structuredClone(value) : null });
  return {
    states,
    findById: id => query(states.get(id)),
    find: () => ({ limit: () => ({ lean: async () => [...states.values()].filter(state => state.haltedAt && !state.alertedAt)
      .map(state => structuredClone(state)) }) }),
    findOneAndUpdate(filter, update) {
      let state = states.get(filter._id);
      if (update.$inc) {
        state ||= { _id: filter._id, failures: 0 };
        state.failures += update.$inc.failures;
        Object.assign(state, update.$set);
        states.set(filter._id, state);
        return query(state);
      }
      if (!state?.haltedAt || state.alertedAt || state.alertLeaseUntil && state.alertLeaseUntil > new Date()) return query(null);
      state.alertLeaseUntil = update.$set.alertLeaseUntil;
      return query(state);
    },
    async updateOne(filter, update, options) {
      let state = states.get(filter._id);
      if (!state && options?.upsert) {
        state = { _id: filter._id, ...update.$setOnInsert };
        states.set(filter._id, state);
      }
      if (!state) return { modifiedCount: 0 };
      if (filter.haltedAt === null && state.haltedAt) return { modifiedCount: 0 };
      if (filter.alertLeaseUntil && +state.alertLeaseUntil !== +filter.alertLeaseUntil) return { modifiedCount: 0 };
      Object.assign(state, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete state[key];
      return { modifiedCount: 1 };
    },
  };
}

test("five scheduler failures halt the job and send one developer alert", async () => {
  const model = stateModel();
  const alerts = [];
  const policy = createJobFailurePolicy({ model, notify: async value => { alerts.push(value); return 1; } });
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.equal(await policy.canRun("scheduler", "event-media-cleanup"), true);
    await policy.failure("scheduler", "event-media-cleanup");
    assert.equal(model.states.get("scheduler:event-media-cleanup").failures, attempt);
  }
  assert.equal(await policy.canRun("scheduler", "event-media-cleanup"), false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].attempts, 5);
  await policy.success("scheduler", "event-media-cleanup");
  assert.equal(await policy.canRun("scheduler", "event-media-cleanup"), true);
});

test("a failed alert remains eligible for the dedicated retry schedule", async () => {
  const model = stateModel();
  let attempts = 0;
  const policy = createJobFailurePolicy({ model, notify: async () => ++attempts === 1 ? 0 : 1 });
  for (let i = 0; i < 5; i++) await policy.failure("scheduler", "log-retention");
  assert.equal(await policy.canRun("scheduler", "log-retention"), false);
  assert.equal(attempts, 1);
  await policy.retryAlerts();
  assert.equal(attempts, 2);
  assert(model.states.get("scheduler:log-retention").alertedAt);
});

test("a final queue failure persists its alert and retries delivery after a provider error", async () => {
  const model = stateModel();
  let calls = 0;
  const policy = createJobFailurePolicy({ model, notify: async () => ++calls === 1 ? 0 : 1 });
  await policy.queueFailure("spreadsheet-sync", "event", "42", 5);
  const state = model.states.get("queue:spreadsheet-sync:42");
  assert.equal(state.failures, 5);
  assert.equal(state.alertedAt, undefined);
  await policy.retryAlerts();
  assert(state.alertedAt);
  assert.equal(calls, 2);
  await policy.retryAlerts();
  assert.equal(calls, 2);
});
