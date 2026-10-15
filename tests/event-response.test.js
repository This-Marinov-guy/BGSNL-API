import test from "node:test";
import assert from "node:assert/strict";
import { eventResponse } from "../services/events/event-response.js";

test("event responses omit embedded recipient and retry records", () => {
  const source = { title: "Event", emailCampaigns: [{ recipients: [{ email: "private@example.test" }] }],
    emailDeliveries: [{ email: "private@example.test" }], cancellationDeliveries: [{ email: "private@example.test" }],
    feedbackDeliveries: [{ email: "private@example.test" }], feedbacks: [{ answers: { improvements: "Private" } }] };
  assert.deepEqual(eventResponse(source), { title: "Event" });
  assert.equal(source.emailDeliveries.length, 1);
});
