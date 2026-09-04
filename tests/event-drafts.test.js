import assert from "node:assert/strict";
import test from "node:test";

import Event from "../models/Event.js";
import EventDraft from "../models/EventDraft.js";

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
