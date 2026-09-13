import assert from "node:assert/strict";
import test from "node:test";
import { validationResult } from "express-validator";

import Event from "../models/Event.js";
import EventDraft from "../models/EventDraft.js";
import { buildEventDraftReminderEmail } from "../services/background-services/email-transporter.js";
import { eventDraftReminderValidators } from "../validation/form-validators.js";
import { EVENT_DRAFT_REMINDER_TEMPLATE } from "../util/config/defines.js";

const validateDraftReminder = async ({ email, eventId }) => {
  const req = { body: { email }, params: { eventId } };
  await Promise.all(
    eventDraftReminderValidators.map((validator) => validator.run(req))
  );
  return validationResult(req);
};

test("an incomplete event draft validates in its own collection", async () => {
  const event = new EventDraft({
    draftData: {
      title: "An idea in progress",
      location: "",
      earlyBird: { isEnabled: true },
    },
  });

  await assert.doesNotReject(event.validate());
  assert.equal(event.status, "draft");
  assert.equal(event.draftData.title, "An idea in progress");
  assert.equal(EventDraft.collection.collectionName, "eventDrafts");
});

test("submitting the same incomplete data keeps published validation", async () => {
  const event = new Event({ status: "opened" });

  await assert.rejects(event.validate(), (error) => {
    for (const field of [
      "region",
      "title",
      "date",
      "location",
      "ticketTimer",
      "ticketLimit",
      "text",
      "ticketImg",
      "poster",
      "folder",
      "sheetName",
    ]) {
      assert.ok(error.errors[field], `Expected ${field} to be required`);
    }

    return true;
  });
});

test("draft-only fields are not part of published event documents", () => {
  assert.equal(Event.schema.path("draftData"), undefined);
  assert.equal(Event.schema.path("draftOwner"), undefined);
});

test("published event validation still applies even if status is draft", async () => {
  const event = new Event({ status: "draft" });

  await assert.rejects(event.validate());
});

test("draft reminder validation requires a draft id and valid email", async () => {
  const valid = await validateDraftReminder({
    email: "team@example.com",
    eventId: "507f1f77bcf86cd799439011",
  });
  assert.equal(valid.isEmpty(), true);

  const invalid = await validateDraftReminder({
    email: "not-an-email",
    eventId: "not-an-id",
  });
  assert.deepEqual(
    new Set(invalid.array().map((error) => error.path ?? error.param)),
    new Set(["eventId", "email"])
  );
});

test("draft reminder email targets the Domakin Mailer template with a normalized title and continue link", () => {
  const message = buildEventDraftReminderEmail({
    eventTitle: "Board <planning>\r\nnight",
    continueUrl:
      "https://bulgariansociety.nl/user/edit-event/507f1f77bcf86cd799439011?from=email&draft=1",
  });

  assert.equal(message.templateId, EVENT_DRAFT_REMINDER_TEMPLATE);
  assert.deepEqual(message.templateVariables, {
    eventTitle: "Board <planning> night",
    continueUrl:
      "https://bulgariansociety.nl/user/edit-event/507f1f77bcf86cd799439011?from=email&draft=1",
  });
});
