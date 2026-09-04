import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEventCreatedNotification,
  buildInternshipApplicationNotification,
  createInternalNotificationService,
} from "../services/background-services/internal-notifications.js";
import {
  DEFAULT_INTERNAL_NOTIFICATION_SUBSCRIBERS,
  getInternalNotificationConfig,
  parseInternalNotificationSubscribers,
} from "../util/config/internal-notifications.js";

test("uses the requested internal subscribers and normalizes overrides", () => {
  assert.deepEqual(
    parseInternalNotificationSubscribers(),
    DEFAULT_INTERNAL_NOTIFICATION_SUBSCRIBERS
  );
  assert.deepEqual(
    parseInternalNotificationSubscribers(
      " FIRST@example.com,invalid,first@example.com, second@example.com "
    ),
    ["first@example.com", "second@example.com"]
  );
});

test("internal notifications require the explicit enabled setting", () => {
  assert.deepEqual(
    getInternalNotificationConfig({
      INTERNAL_NOTIFICATIONS_ENABLED: "true",
      INTERNAL_NOTIFICATION_SUBSCRIBERS: "team@example.com",
    }),
    { enabled: true, subscribers: ["team@example.com"] }
  );
  assert.equal(getInternalNotificationConfig({}).enabled, false);
});

test("queues a separate internship application notification for each subscriber", () => {
  const messages = [];
  const service = createInternalNotificationService({
    config: {
      enabled: true,
      subscribers: ["one@example.com", "two@example.com"],
    },
    sendEmail: (message) => messages.push(message),
  });

  const count = service.notifyInternshipApplicationCreated({
    _id: "application-1",
    name: "Ada Applicant",
    email: "ada@example.com",
    phone: "+31 6 12345678",
    companyName: "BGSNL",
    position: "Events intern",
    createdAt: "2026-09-03T09:00:00.000Z",
  });

  assert.equal(count, 2);
  assert.deepEqual(messages.map(({ receiver }) => receiver), [
    "one@example.com",
    "two@example.com",
  ]);
  assert.match(messages[0].subject, /Events intern/);
  assert.match(messages[0].html, /Ada Applicant/);
  assert.equal(messages[0].type, "internship-application-created");
});

test("queues a new-event notification with the operational event details", () => {
  const messages = [];
  const service = createInternalNotificationService({
    config: { enabled: true, subscribers: ["team@example.com"] },
    sendEmail: (message) => messages.push(message),
  });

  const count = service.notifyEventCreated({
    _id: "event-1",
    title: "Autumn networking night",
    region: "Amsterdam",
    date: "2026-10-10T17:00:00.000Z",
    location: "Amsterdam",
    hidden: false,
    memberOnly: false,
  });

  assert.equal(count, 1);
  assert.equal(messages[0].receiver, "team@example.com");
  assert.match(messages[0].subject, /Autumn networking night/);
  assert.match(messages[0].text, /Region: Amsterdam/);
  assert.equal(messages[0].type, "event-created");
});

test("does not enqueue mail when internal notifications are disabled", () => {
  let calls = 0;
  const service = createInternalNotificationService({
    config: { enabled: false, subscribers: ["team@example.com"] },
    sendEmail: () => {
      calls += 1;
    },
  });

  assert.equal(service.notifyEventCreated({ title: "Event" }), 0);
  assert.equal(calls, 0);
});

test("notification HTML escapes user-provided content", () => {
  const application = buildInternshipApplicationNotification({
    _id: "application-2",
    name: "<script>alert(1)</script>",
    position: "Developer",
  });
  const event = buildEventCreatedNotification({
    _id: "event-2",
    title: "<b>Event</b>",
  });

  assert.doesNotMatch(application.html, /<script>/);
  assert.match(application.html, /&lt;script&gt;/);
  assert.doesNotMatch(event.html, /<b>Event<\/b>/);
  assert.match(event.html, /&lt;b&gt;Event&lt;\/b&gt;/);
});
