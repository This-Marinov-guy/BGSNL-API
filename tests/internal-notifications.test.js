import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEventCreatedNotification,
  buildInternshipApplicationNotification,
  buildSupportTicketNotification,
  buildSupportReplyNotification,
  createInternalNotificationService,
  createSupportTicketNotifier,
} from "../services/background-services/internal-notifications.js";
import {
  DEFAULT_INTERNAL_NOTIFICATION_SUBSCRIBERS,
  getInternalNotificationConfig,
  parseInternalNotificationSubscribers,
} from "../util/config/internal-notifications.js";

test("support replies go only to Vladislav, use reply-level keys and escape message HTML", () => {
  const messages = [];
  const config = { enabled: true, subscribers: ["someone-else@example.test"] };
  const service = createInternalNotificationService({ config, sendEmail: message => messages.push(message) });
  const ticket = { id: "ticket-1", reference: "ABC123", subject: "Help", contact: { name: "Guest" } };
  const reply = { id: "reply-1", author: "requester", text: "<script>unsafe</script>", createdAt: new Date(), attachments: [] };
  assert.equal(service.notifySupportTicketReplied(ticket, reply), 1);
  service.notifySupportTicketReplied(ticket, { ...reply, id: "reply-2", author: "staff" });
  assert.deepEqual(messages.map(message => message.receiver), ["vladislavmarinov3142@gmail.com", "vladislavmarinov3142@gmail.com"]);
  assert.notEqual(messages[0].entityId, messages[1].entityId);
  assert.match(messages[0].html, /&lt;script&gt;/);
  assert.doesNotMatch(messages[0].html, /<script>/);
  config.enabled = false;
  assert.equal(service.notifySupportTicketReplied(ticket, reply), 0);
  assert.equal(messages.length, 2);
});

test("reopened tickets get a clearly labeled notification and retain reply-level deduplication", () => {
  const ticket = { id: "ticket-1", reference: "ABC123", status: "open", subject: "Help" };
  const reply = { id: "reply-1", author: "requester", text: "Still broken", createdAt: new Date(), reopened: true };
  const notice = buildSupportReplyNotification(ticket, reply);
  assert.match(notice.subject, /^Support ticket reopened #ABC123/);
  assert.match(notice.html, /Support ticket reopened/);
  assert.match(notice.html, /open/);
  assert.equal(notice.entityId, "ticket-1:reply-1");
  assert.equal(notice.type, "support-ticket-replied");
});

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

test("new support tickets notify every internal subscriber with ticket diagnostics", () => {
  const messages = [];
  const notify = createSupportTicketNotifier({
    config: {
      enabled: true,
      subscribers: ["one@example.com", "two@example.com"],
    },
    sendEmail: (message) => messages.push(message),
  });
  assert.equal(notify({ id: "ticket-id", reference: "ABC12345", subject: "Checkout is stuck", pagePath: "/signup",
    contact: { name: "Test Member", email: "member@example.test" }, createdAt: "2026-09-07T10:00:00.000Z",
    environment: { deviceType: "Mobile", browser: "Safari", platform: "iOS", viewport: { width: 390, height: 844 }, devicePixelRatio: 3 } }), 2);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ receiver }) => receiver), [
    "one@example.com",
    "two@example.com",
  ]);
  assert.match(messages[0].subject, /ABC12345/);
  assert.match(messages[0].text, /Mobile · Safari · iOS/);
  assert.match(messages[0].text, /390 × 844 at 3×/);
});

test("event notifications include the website region badge, ticket tiers and public slug link", () => {
  const notification = buildEventCreatedNotification({
    _id: "event-1", slug: "autumn-evening", title: "Autumn evening",
    region: "groningen", date: "2026-10-10T17:00:00.000Z", location: "Groningen",
    product: { guest: { price: 15.5 }, member: { price: 12 }, activeMember: { price: 8 } },
  });
  assert.match(notification.text, /Title: Autumn evening/);
  assert.match(notification.text, /Region: Groningen/);
  assert.match(notification.text, /Date & time: 10 October 2026 at 19:00/);
  assert.match(notification.text, /Guest: €15\.50\nMember: €12\.00\nActive member: €8\.00/);
  assert.match(notification.html, /background-color:#ffe9e8;color:#b51e18/);
  assert.match(notification.html, /border:1px solid #ffbbb7/);
  assert.match(notification.html, /href="https:\/\/bulgariansociety.nl\/groningen\/event-details\/autumn-evening"/);
  assert.doesNotMatch(notification.text, /Visibility:|Audience:|Event ID:/);
});

test("event notification prices distinguish free, member-free, missing and external tickets", () => {
  assert.match(buildEventCreatedNotification({ isFree: true }).text, /Prices: Free\n/);
  const memberFree = buildEventCreatedNotification({ isMemberFree: true, product: { guest: { price: 5 } } });
  assert.match(memberFree.text, /Guest: €5\.00\nMember: Free\nActive member: Free/);
  const memberOnly = buildEventCreatedNotification({ memberOnly: true, product: { member: { price: 7 } } });
  assert.doesNotMatch(memberOnly.text, /Guest:/);
  assert.match(memberOnly.text, /Member: €7\.00\nActive member: €7\.00/);
  assert.match(buildEventCreatedNotification({}).text, /Guest: Not set/);
  assert.match(buildEventCreatedNotification({ ticketLink: "https://tickets.example.test" }).text, /Prices: See external ticket provider/);
});

test("event links fall back to the ID and unknown regions remain safely escaped", () => {
  const notification = buildEventCreatedNotification({ _id: "event-2", region: "breda_tilburg" });
  assert.match(notification.text, /Region: Breda Tilburg/);
  assert.match(notification.html, /href="https:\/\/bulgariansociety.nl\/breda_tilburg\/event-details\/event-2"/);
  const unknown = buildEventCreatedNotification({ region: '<img src=x onerror="alert(1)">', slug: '" onclick="alert(1)' });
  assert.doesNotMatch(unknown.html, /<img|href="[^"]*" onclick=/i);
  assert.match(unknown.html, /background-color:#f1f3f2/);
  assert.doesNotMatch(buildEventCreatedNotification({}).html, /href=/);
});

test("support ticket notifications follow the internal notification switch", () => {
  const messages = [];
  const notify = createSupportTicketNotifier({
    config: { enabled: false, subscribers: ["team@example.com"] },
    sendEmail: (message) => messages.push(message),
  });
  assert.equal(notify({ id: "ticket-id", subject: "Test" }), 0);
  assert.equal(messages.length, 0);
});

test("support-ticket notification HTML escapes reporter-provided content", () => {
  const notification = buildSupportTicketNotification({ id: "ticket", subject: "<img src=x onerror=alert(1)>", contact: { name: "<b>Name</b>" } });
  assert.doesNotMatch(notification.html, /<img src=x/);
  assert.match(notification.html, /&lt;img src=x/);
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
