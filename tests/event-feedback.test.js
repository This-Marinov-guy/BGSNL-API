import test from "node:test";
import assert from "node:assert/strict";
import Event from "../models/Event.js";
import { createFeedbackReportHandler } from "../controllers/Events/event-feedback-controller.js";
import { createEventFeedbackService, feedbackDueAt, feedbackRecipientHash } from "../services/events/event-feedback.js";
import { buildFeedbackEmail, createEventFeedbackEmailService, eventFeedbackEmailsEnabled, feedbackRecipients } from "../services/events/event-feedback-email.js";
import { EVENT_CAMPAIGN_TEMPLATE } from "../services/events/event-campaign-email.js";

const eventId = "a".repeat(24);
const firstId = "b".repeat(24);
const secondId = "c".repeat(24);
const eventDate = new Date("2026-10-10T18:00:00Z");
const dueDate = new Date("2026-10-11T18:00:00Z");
const answers = { enjoyment: 5, organisation: 4, favoriteMoment: "Meeting everyone",
  improvements: "More room", futureEvents: "Yes", additionalComments: "" };
const ticket = (_id, email = "guest@example.org", other = {}) => ({ _id, email, ticket: "https://example.org/ticket", refunded: false, ...other });
const sampleEvent = () => ({ _id: eventId, title: "Society evening", poster: "https://example.org/poster.jpg", date: eventDate, region: "groningen",
  status: "archived", guestList: [ticket(firstId), ticket(secondId, "GUEST@example.org")], feedbacks: [] });
const marketingModel = (rows = [{ email: "guest@example.org", unsubscribed: false, consent: { granted: true } }]) => ({
  find: filter => ({ select: () => ({ lean: async () => rows.filter(row =>
    typeof filter.email === "string" ? row.email === filter.email : filter.email.$in.includes(row.email)) }) }),
});

test("event stores feedback responses in its feedbacks array", () => {
  assert.equal(Event.schema.path("feedbacks").instance, "Array");
});

test("event feedback report lists saved answers for an authorised region", async () => {
  const record = { _id: "d".repeat(24), ticketId: firstId, submittedAt: dueDate, answers };
  const feedbacks = [...Array.from({ length: 20 }, (_, index) => ({ _id: String(index).padStart(24, "0"),
    submittedAt: new Date(+dueDate + index + 1), ticketId: secondId, answers })), record];
  let reads = 0;
  const handler = createFeedbackReportHandler({
    EventModel: { findById: () => ({ select: () => ({ lean: async () => ++reads === 1
      ? { _id: eventId, title: "Society evening", region: "rotterdam" }
      : { guestList: [{ _id: firstId, name: "Guest One", email: "guest@example.org" }], feedbacks } }) }) },
  });
  let result, failure;
  const response = { set() { return this; }, status(code) { assert.equal(code, 200); return this; }, json(body) { result = body; return this; } };
  await handler({ params: { eventId }, query: { page: "2" }, regionScope: { event: "rotterdam" } }, response, error => { failure = error; });
  assert.equal(failure, undefined);
  assert.equal(reads, 2);
  assert.equal(result.total, 21);
  assert.equal(result.pages, 2);
  assert.deepEqual(result.responses[0], { id: record._id, ticketId: firstId, name: "Guest One", email: "guest@example.org",
    submittedAt: dueDate, answers });
});

test("event feedback report rejects another region before reading responses", async () => {
  let queried = 0;
  const handler = createFeedbackReportHandler({
    EventModel: { findById: () => ({ select: () => ({ lean: async () => { queried++; return { _id: eventId, region: "rotterdam" }; } }) }) },
  });
  let failure;
  await handler({ params: { eventId }, query: {}, regionScope: { event: "eindhoven" } }, {}, error => { failure = error; });
  assert.equal(failure?.code, 403);
  assert.equal(queried, 1);
});

test("feedback email worker defaults to production only", () => {
  assert.equal(eventFeedbackEmailsEnabled({ NODE_ENV: "development" }), false);
  assert.equal(eventFeedbackEmailsEnabled({ NODE_ENV: "production" }), true);
  assert.equal(eventFeedbackEmailsEnabled({ NODE_ENV: "production", EVENT_FEEDBACK_EMAIL_ENABLED: "false" }), false);
  assert.equal(eventFeedbackEmailsEnabled({ NODE_ENV: "development", EVENT_FEEDBACK_EMAIL_ENABLED: "true" }), true);
});

test("feedback opens one day after the event and accepts an issued ticket without a session", async () => {
  const event = sampleEvent();
  let current = new Date("2026-10-11T17:59:00Z");
  const service = createEventFeedbackService({
    EventModel: { findOne: async () => event, updateOne: async (_query, update) => {
      event.feedbacks.push(update.$push.feedbacks); return { modifiedCount: 1 };
    } },
    now: () => current,
  });
  assert.equal(+feedbackDueAt(event), +dueDate);
  assert.equal((await service.state(firstId)).state, "not_ready");
  assert.equal((await service.state(firstId)).eventPoster, "https://example.org/poster.jpg");
  await assert.rejects(service.submit(firstId, answers), /one day after/);
  current = dueDate;
  assert.equal((await service.state(firstId)).state, "ready");
  assert.equal((await service.submit(firstId, answers)).status, true);
  assert.equal(event.feedbacks[0].ticketId, firstId);
  assert.equal(event.feedbacks[0].answers.favoriteMoment, "Meeting everyone");
  assert.equal((await service.state(firstId)).state, "submitted");
});

test("invalid, refunded and cancelled tickets cannot submit", async () => {
  const event = sampleEvent();
  const service = createEventFeedbackService({ EventModel: { findOne: async () => event }, now: () => dueDate });
  await assert.rejects(service.state("d".repeat(24)), /not available/);
  event.guestList[0].refunded = true;
  await assert.rejects(service.submit(firstId, answers), /not available/);
  event.guestList[0].refunded = false;
  event.cancellationRequestedAt = new Date();
  await assert.rejects(service.submit(firstId, answers), /not available/);
});

test("atomic event update rejects a duplicate response for the same email", async () => {
  const event = sampleEvent();
  event.feedbacks.push({ ticketId: firstId, recipientHash: feedbackRecipientHash("guest@example.org"), answers });
  let query;
  const service = createEventFeedbackService({ EventModel: {
    findOne: async () => event,
    updateOne: async value => { query = value; return { modifiedCount: 0 }; },
    findById: () => ({ select: () => ({ lean: async () => event }) }),
  }, now: () => dueDate });
  await assert.rejects(service.submit(secondId, answers), /already been submitted/);
  assert.equal(query._id, eventId);
  assert.deepEqual(query.feedbacks.$not.$elemMatch.$or[1], { recipientHash: feedbackRecipientHash("guest@example.org") });
});

test("email recipients are deduplicated by address and exclude refunded tickets", () => {
  const event = sampleEvent();
  event.guestList.push(ticket("d".repeat(24), "other@example.org", { refunded: true }));
  const recipients = feedbackRecipients(event);
  assert.deepEqual([...recipients.keys()], ["guest@example.org"]);
  assert.equal(recipients.get("guest@example.org")._id, firstId);
  const email = buildFeedbackEmail({ ...event, title: "Society <evening>" }, firstId);
  assert.match(email.html, /Society &lt;evening&gt;/);
  assert.match(email.html, /class="bgsnl-event-preview"/);
  assert.match(email.html, />Groningen<\/span>/);
  assert.match(email.html, /https:\/\/example\.org\/poster\.jpg/);
  assert.match(email.text, new RegExp(`/event-feedback/${firstId}`));
});

test("future events are scheduled and a completed email is not sent again", async () => {
  const event = sampleEvent();
  let current = new Date("2026-10-09T18:00:00Z");
  const sent = [];
  const EventModel = {
    find: query => ({ select: () => ({ lean: async () => {
      if (query.feedbackEmailDueAt) return event.feedbackEmailDueAt && event.feedbackEmailDueAt <= current && !event.feedbackEmailCompletedAt ? [{ _id: eventId }] : [];
      return [event];
    } }) }),
    findById: async () => event,
    updateOne: async (_query, update) => Object.assign(event, update.$set),
  };
  const service = createEventFeedbackEmailService({ EventModel, MarketingModel: marketingModel(),
    send: async (...args) => sent.push(args), now: () => current });
  assert.equal(await service.schedule(), 1);
  assert.equal(+event.feedbackEmailDueAt, +dueDate);
  current = dueDate;
  const result = await service.process(eventId);
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], EVENT_CAMPAIGN_TEMPLATE);
  assert.equal(sent[0][1], "guest@example.org");
  assert.match(sent[0][2].text, new RegExp(firstId));
  assert.equal(sent[0][3].bulk.batchType, "event_feedback");
  assert.equal(sent[0][3].bulk.totalRecipients, 1);
  assert.match(sent[0][3].bulk.batchId, /^[0-9a-f-]{36}$/);
  assert.ok(event.feedbackEmailCompletedAt);
  await service.process(eventId);
  assert.equal(sent.length, 1);
});

test("daily feedback check catches a recent event that passed between checks", async () => {
  const event = sampleEvent();
  const current = new Date("2026-10-11T19:00:00Z");
  const sent = [];
  const EventModel = {
    find: query => {
      const rows = query.feedbackEmailDueAt
        ? event.feedbackEmailDueAt && !event.feedbackEmailCompletedAt ? [{ _id: eventId }] : []
        : [event];
      if (!query.feedbackEmailDueAt) assert(query.$or.some(item => item.date?.$gte && item.date?.$lte));
      const cursor = { lean: async () => rows, limit: () => cursor };
      return { select: () => cursor };
    },
    findById: async () => event,
    updateOne: async (_query, update) => Object.assign(event, update.$set),
  };
  const service = createEventFeedbackEmailService({ EventModel, MarketingModel: marketingModel(),
    send: async (...args) => sent.push(args), now: () => current });
  const result = await service.tick();
  assert.equal(result.scheduled, 1);
  assert.equal(result.accepted, 1);
  assert.equal(sent.length, 1);
  assert.ok(event.feedbackEmailCompletedAt);
});

test("feedback provider retry keeps the same operation ID without delivery rows", async () => {
  const event = { ...sampleEvent(), feedbackEmailDueAt: dueDate };
  let current = dueDate, attempts = 0;
  const operationIds = [], batchIds = [];
  const EventModel = {
    findById: async () => event,
    updateOne: async (_query, update) => {
      Object.assign(event, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete event[key];
    },
  };
  const service = createEventFeedbackEmailService({ EventModel, MarketingModel: marketingModel(), now: () => current,
    send: async (_template, _email, _content, options) => {
      operationIds.push(options.operationId);
      batchIds.push(options.bulk.batchId);
      if (attempts++ === 0) throw new Error("Acceptance timed out");
    } });
  assert.equal((await service.process(eventId)).failed, 1);
  assert.ok(event.feedbackEmailRetryAt);
  current = new Date(+current + 5 * 60_000);
  assert.equal((await service.process(eventId)).accepted, 1);
  assert.equal(operationIds.length, 2);
  assert.equal(operationIds[0], operationIds[1]);
  assert.equal(batchIds[0], batchIds[1]);
  assert.ok(event.feedbackEmailCompletedAt);
});

test("all consenting feedback recipients share one bulk campaign batch", async () => {
  const event = { ...sampleEvent(), feedbackEmailDueAt: dueDate };
  event.guestList.push(ticket("d".repeat(24), "second@example.org"));
  const sent = [];
  const service = createEventFeedbackEmailService({
    EventModel: { findById: async () => event, updateOne: async (_query, update) => Object.assign(event, update.$set) },
    MarketingModel: marketingModel([
      { email: "guest@example.org", unsubscribed: false, consent: { granted: true } },
      { email: "second@example.org", unsubscribed: false, consent: { granted: true } },
    ]),
    now: () => dueDate, send: async (...args) => sent.push(args),
  });
  assert.deepEqual(await service.process(eventId), { accepted: 2, failed: 0 });
  assert.equal(sent.length, 2);
  assert.equal(sent[0][3].bulk.batchId, sent[1][3].bulk.batchId);
  assert.equal(sent[0][3].bulk.totalRecipients, 2);
  assert.equal(sent[1][3].bulk.totalRecipients, 2);
});

test("feedback campaigns require consent and stop after an opt-out in any city", async () => {
  const event = { ...sampleEvent(), feedbackEmailDueAt: dueDate };
  let sends = 0;
  const rows = [
    { email: "guest@example.org", city: "groningen", unsubscribed: false, consent: { granted: true } },
    { email: "guest@example.org", city: "leeuwarden", unsubscribed: true, consent: { granted: false } },
  ];
  const service = createEventFeedbackEmailService({
    EventModel: { findById: async () => event, updateOne: async (_query, update) => Object.assign(event, update.$set) },
    MarketingModel: marketingModel(rows), now: () => dueDate,
    send: async () => { sends++; },
  });
  assert.deepEqual(await service.process(eventId), { accepted: 0, failed: 0 });
  assert.equal(sends, 0);
  assert.ok(event.feedbackEmailCompletedAt);
});

test("feedback campaign rechecks consent immediately before the Mailer handoff", async () => {
  const event = { ...sampleEvent(), feedbackEmailDueAt: dueDate };
  let reads = 0, sends = 0;
  const service = createEventFeedbackEmailService({
    EventModel: { findById: async () => event, updateOne: async (_query, update) => Object.assign(event, update.$set) },
    MarketingModel: { find: () => ({ select: () => ({ lean: async () => {
      reads++;
      return [{ email: "guest@example.org", unsubscribed: reads > 1, consent: { granted: true } }];
    } }) }) },
    now: () => dueDate, send: async () => { sends++; },
  });
  assert.deepEqual(await service.process(eventId), { accepted: 0, failed: 0 });
  assert.equal(reads, 2);
  assert.equal(sends, 0);
});
