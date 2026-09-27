import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import express from "express";
import { createAtlasEventTriggerHandler } from "../controllers/Integration/atlas-event-trigger-controller.js";
import { createAtlasTriggerRouter } from "../routes/Integration/atlas-triggers.js";
import { firewall } from "../middleware/firewall.js";
import { apiVersionMiddleware } from "../middleware/api-version.js";
import { startMemberEventAnnouncementWorker, wakeMemberEventAnnouncementWorker } from "../services/events/member-event-announcements.js";

const eventId = "a".repeat(24);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const source = readFileSync(new URL("../atlas/functions/member-event-announcement.js", import.meta.url), "utf8");
const change = (patch = {}) => ({ operationType: "insert", documentKey: { _id: eventId }, fullDocument: { _id: eventId, status: "opened", hidden: false, memberAnnouncementQueuedAt: new Date() }, ...patch });
const functionHarness = ({ key = "t".repeat(64), statusCode = 202 } = {}) => {
  const calls = [];
  const sandbox = { Date, context: { values: { get: () => key }, http: { post: async (request) => { calls.push(request); return { statusCode }; } } } };
  vm.runInNewContext(source, sandbox);
  return { run: sandbox.exports, calls };
};

const handlerHarness = ({ pending = true, enabled = true, available = true } = {}) => {
  const calls = { queries: [], wakes: 0, errors: [] };
  const run = createAtlasEventTriggerHandler({
    EventModel: { exists: async (query) => { calls.queries.push(query); return pending; } },
    enabled: () => enabled,
    wake: () => { calls.wakes++; return available; },
  });
  const res = { set() { return this; }, status(value) { calls.status = value; return this; }, json(value) { calls.body = value; return this; } };
  return { calls, run: (body = { eventId }) => run({ body }, res, (error) => calls.errors.push(error)) };
};

test("Atlas function forwards only an event ID to the fixed production endpoint", async () => {
  const h = functionHarness();
  assert.equal((await h.run(change())).status, "queued");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://kanatitsa.bulgariansociety.nl/api/v1/integrations/atlas/member-event-announcement");
  assert.equal(JSON.stringify(h.calls[0].body), JSON.stringify({ eventId }));
  assert.equal(h.calls[0].headers["x-api-key"][0], "t".repeat(64));
  assert.equal(h.calls[0].encodeBodyAsJSON, true);
});

test("drafts, old events, completed announcements and ordinary edits never call the API", async () => {
  const h = functionHarness();
  for (const patch of [
    { operationType: "delete" },
    { fullDocument: null },
    { fullDocument: { ...change().fullDocument, status: "draft" } },
    { fullDocument: { ...change().fullDocument, status: "archived" } },
    { fullDocument: { ...change().fullDocument, hidden: true } },
    { fullDocument: { _id: eventId, status: "opened" } },
    { fullDocument: { ...change().fullDocument, memberAnnouncementCompletedAt: new Date() } },
    { operationType: "update", updateDescription: { updatedFields: { title: "An edit" } } },
    { operationType: "update", updateDescription: { updatedFields: { "guestList.0": {} } } },
  ]) assert.equal((await h.run(change(patch))).status, "ignored");
  assert.equal(h.calls.length, 0);
});

test("publication, pending replacements and revealing a queued hidden event can wake delivery", async () => {
  const h = functionHarness();
  for (const patch of [
    { operationType: "replace" },
    { operationType: "update", updateDescription: { updatedFields: { memberAnnouncementQueuedAt: new Date() } } },
    { operationType: "update", updateDescription: { updatedFields: { hidden: false } } },
    { operationType: "update", updateDescription: { updatedFields: { status: "opened" } } },
    { operationType: "update", updateDescription: { removedFields: ["hidden"] } },
  ]) assert.equal((await h.run(change(patch))).status, "queued");
  assert.equal(h.calls.length, 5);
});

test("Atlas configuration, invalid IDs and non-success API responses fail without logging secrets", async () => {
  for (const key of [null, "", "short"]) {
    const h = functionHarness({ key });
    await assert.rejects(h.run(change()), /not configured/);
    assert.equal(h.calls.length, 0);
  }
  const h = functionHarness();
  await assert.rejects(h.run(change({ documentKey: { _id: "b".repeat(24) } })), /document key/);
  assert.equal(h.calls.length, 0);
  for (const statusCode of [301, 400, 403, 429, 500, 503]) await assert.rejects(functionHarness({ statusCode }).run(change()), new RegExp(`HTTP ${statusCode}`));
  assert.equal((await functionHarness({ statusCode: 200 }).run(change())).status, "ignored");
});

test("the endpoint only wakes an already committed pending announcement", async () => {
  const h = handlerHarness();
  await h.run({ eventId, memberId: "forged", price: 0, memberAnnouncementQueuedAt: new Date() });
  assert.equal(h.calls.status, 202);
  assert.equal(h.calls.wakes, 1);
  assert.equal(h.calls.queries[0]._id, eventId);
  assert.equal(h.calls.queries[0].memberAnnouncementQueuedAt.$exists, true);
  assert.ok(h.calls.queries[0].memberAnnouncementQueuedAt.$lte instanceof Date);
  assert.equal(h.calls.queries[0].memberAnnouncementCompletedAt.$exists, false);
  assert.equal(h.calls.queries[0].memberId, undefined);
  const done = handlerHarness({ pending: false });
  await done.run();
  assert.equal(done.calls.status, 200);
  assert.equal(done.calls.wakes, 0);
});

test("disabled/unavailable workers and invalid IDs cannot acknowledge queued delivery", async () => {
  const disabled = handlerHarness({ enabled: false });
  await disabled.run();
  assert.equal(disabled.calls.errors[0].statusCode, 503);
  assert.equal(disabled.calls.queries.length, 0);
  for (const eventId of [null, [], {}, "", "not-an-id"]) {
    const h = handlerHarness();
    await h.run({ eventId });
    assert.equal(h.calls.errors[0].statusCode, 400);
    assert.equal(h.calls.wakes, 0);
    assert.equal(h.calls.queries.length, 0);
  }
  const stopped = handlerHarness({ available: false });
  await stopped.run();
  assert.equal(stopped.calls.errors[0].statusCode, 503);
});

test("worker coalesces trigger deliveries and immediately rechecks after an in-flight pass", async () => {
  let count = 0, release;
  const stop = startMemberEventAnnouncementWorker({ enabled: true, intervalMs: 600000, process: async () => {
    count++;
    if (count === 1) await new Promise((resolve) => { release = resolve; });
    return { failed: 0 };
  } });
  try {
    await flush();
    for (let i = 0; i < 20; i++) assert.equal(wakeMemberEventAnnouncementWorker(), true);
    assert.equal(count, 1);
    release();
    await flush();
    assert.equal(count, 2);
    assert.equal(wakeMemberEventAnnouncementWorker(), true);
    await flush();
    assert.equal(count, 3);
  } finally { release?.(); await stop(); }
  assert.equal(wakeMemberEventAnnouncementWorker(), false);
});

test("shutdown discards pending wakeups and waits for active delivery", async () => {
  let count = 0, release;
  const stop = startMemberEventAnnouncementWorker({ enabled: true, intervalMs: 600000, process: async () => {
    count++;
    await new Promise((resolve) => { release = resolve; });
    return { failed: 0 };
  } });
  await flush();
  wakeMemberEventAnnouncementWorker();
  const stopped = stop();
  assert.equal(wakeMemberEventAnnouncementWorker(), false);
  release();
  await stopped;
  await flush();
  assert.equal(count, 1);
  await startMemberEventAnnouncementWorker({ enabled: false })();
  assert.equal(wakeMemberEventAnnouncementWorker(), false);
});

test("HTTP route enforces its own key even with an allowed Origin or another integration key", async () => {
  const names = ["ATLAS_EVENT_TRIGGER_SECRET", "GOOGLE_SCRIPTS_PASS", "KOKO_APP_PASS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ATLAS_EVENT_TRIGGER_SECRET = "t".repeat(64);
  process.env.GOOGLE_SCRIPTS_PASS = "g".repeat(64);
  let wakes = 0;
  const app = express();
  app.use(apiVersionMiddleware, firewall, express.json());
  app.use("/api/v1/integrations/atlas", createAtlasTriggerRouter({ EventModel: { exists: async () => true }, enabled: () => true, wake: () => { wakes++; return true; } }));
  app.post("/api/v1/unrelated", (_req, res) => res.sendStatus(200));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = "/api/v1/integrations/atlas/member-event-announcement";
    const call = (url, key, method = "POST", extra = {}) => fetch(base + url, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}), ...extra }, ...(method === "POST" ? { body: JSON.stringify({ eventId }) } : {}) });
    assert.equal((await call(path, process.env.ATLAS_EVENT_TRIGGER_SECRET)).status, 202);
    assert.equal((await call(path, "wrong")).status, 403);
    assert.equal((await call(path)).status, 403);
    assert.equal((await call(path, process.env.GOOGLE_SCRIPTS_PASS)).status, 403);
    assert.equal((await call(path, null, "POST", { origin: "https://bulgariansociety.nl" })).status, 403);
    assert.equal((await call(path, process.env.ATLAS_EVENT_TRIGGER_SECRET, "GET")).status, 403);
    assert.equal((await call("/api/v1/unrelated", process.env.ATLAS_EVENT_TRIGGER_SECRET)).status, 403);
    delete process.env.ATLAS_EVENT_TRIGGER_SECRET;
    assert.equal((await call(path, process.env.GOOGLE_SCRIPTS_PASS)).status, 503);
    assert.equal(wakes, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
