import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { getDeveloperNotificationConfig } from "../util/config/internal-notifications.js";
import { buildWebhookErrorNotification, createDeveloperNotifier } from "../services/background-services/developer-notifications.js";
import { createWebhookErrorObserver } from "../middleware/webhook-error-notification.js";

test("developer group is independent and defaults to the requested recipient", () => {
  assert.deepEqual(getDeveloperNotificationConfig({ INTERNAL_NOTIFICATIONS_ENABLED: "false" }), {
    enabled: true, subscribers: ["vladislavmarinov3142@gmail.com"],
  });
  assert.equal(getDeveloperNotificationConfig({ DEVELOPER_NOTIFICATIONS_ENABLED: "false" }).enabled, false);
  assert.deepEqual(getDeveloperNotificationConfig({ DEVELOPER_NOTIFICATION_SUBSCRIBERS: "" }).subscribers, []);
  assert.deepEqual(getDeveloperNotificationConfig({ DEVELOPER_NOTIFICATION_SUBSCRIBERS: " Dev@example.com,dev@example.com,invalid " }).subscribers, ["dev@example.com"]);
});

test("alerts contain safe diagnostics only", () => {
  const notification = buildWebhookErrorNotification({ status: 503, provider: "stripe", eventId: "evt_abc", eventType: "invoice.paid", livemode: false,
    body: { secret: "secret_value" }, error: new Error("secret_value"), headers: { authorization: "secret_value" } }, { APP_ENV: "dev" });
  assert.match(notification.text, /evt_abc/);
  assert.match(notification.subject, /dev.*503/);
  assert.doesNotMatch(JSON.stringify(notification), /secret_value/);
});

test("errors are throttled, successful responses never alert, and notifier failures cannot change responses", async () => {
  const messages = [];
  let now = 0;
  const notify = createDeveloperNotifier({ config: { enabled: true, subscribers: ["dev@example.com"] },
    sendEmail: (mail) => messages.push(mail), env: { APP_ENV: "test" }, now: () => now });
  const details = { provider: "stripe", status: 503, eventId: "evt_abc" };
  assert.equal(await notify(details), 1);
  assert.equal(await notify(details), 0);
  now = 900001;
  assert.equal(await notify(details), 1);
  const res = new EventEmitter(); res.statusCode = 200; res.locals = {};
  let calls = 0, next = 0;
  createWebhookErrorObserver(() => { calls++; throw new Error("private"); })({}, res, () => next++);
  res.emit("finish");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(next, 1);
  const failed = new EventEmitter(); failed.statusCode = 503; failed.locals = { verifiedWebhookEvent: { eventId: "evt_test" } };
  createWebhookErrorObserver((data) => { calls++; assert.equal(data.eventId, "evt_test"); })({}, failed, () => {});
  failed.emit("finish");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(failed.statusCode, 503);
});

test("invalid request floods are capped without trusting payload IDs", async () => {
  let calls = 0;
  const notify = createDeveloperNotifier({ config: { enabled: true, subscribers: ["dev@example.com"] }, sendEmail: () => calls++, env: {} });
  for (let i = 0; i < 100; i++) await notify({ provider: "stripe", status: 400, body: { id: `evt_${i}` } });
  assert.equal(calls, 1);
});

test("different events hit the global cap and disabled groups send nothing", async () => {
  let calls = 0;
  const notify = createDeveloperNotifier({ config: { enabled: true, subscribers: ["dev@example.com"] }, sendEmail: () => calls++, env: {} });
  for (let i = 0; i < 30; i++) await notify({ status: 503, eventId: `evt_${i}` });
  assert.equal(calls, 20);
  const disabled = createDeveloperNotifier({ config: { enabled: false, subscribers: ["dev@example.com"] }, sendEmail: () => calls++ });
  assert.equal(await disabled({ status: 503 }), 0);
  assert.equal(calls, 20);
});

test("webhook deliveries are recorded in operations without payloads or event IDs", () => {
  const records = [];
  const observer = createWebhookErrorObserver(() => {}, (event) => records.push(event));
  const success = new EventEmitter(); success.statusCode = 200;
  success.locals = { verifiedWebhookEvent: { eventId: "evt_private", eventType: "invoice.paid" } };
  observer({}, success, () => {}); success.emit("finish");
  const rejected = new EventEmitter(); rejected.statusCode = 400; rejected.locals = {};
  observer({ body: { secret: "private" } }, rejected, () => {}); rejected.emit("finish");
  assert.equal(records.length, 2);
  assert.equal(records[0].meta.source, "webhook.stripe");
  assert.equal(records[0].meta.eventType, "invoice.paid");
  assert.equal(records[1].level, "error");
  assert.equal(records[1].meta.verified, false);
  assert.doesNotMatch(JSON.stringify(records), /evt_private|private/);
});

test("alert delivery failures are contained and can be retried", async (t) => {
  t.mock.method(console, "error", () => {});
  let failed = true;
  const notify = createDeveloperNotifier({ config: { enabled: true, subscribers: ["dev@example.com"] },
    sendEmail: async () => { if (failed) throw new Error("private credential"); }, env: {} });
  assert.equal(await notify({ status: 503, eventId: "evt_retry" }), 0);
  failed = false;
  assert.equal(await notify({ status: 503, eventId: "evt_retry" }), 1);
  const res = new EventEmitter(); res.statusCode = 400; res.locals = {};
  createWebhookErrorObserver(async () => { throw new Error("private credential"); })({}, res, () => {});
  res.emit("finish");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 400);
  assert.doesNotMatch(JSON.stringify(console.error.mock.calls), /private credential/);
});
