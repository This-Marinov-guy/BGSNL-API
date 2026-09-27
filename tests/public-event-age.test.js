import test from "node:test";
import assert from "node:assert/strict";
import { futureEventDateFilter, publicEventQuery } from "../services/public-content/event-publication.js";

test("public listings require an effective event date newer than the 48-hour cutoff", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.deepEqual(futureEventDateFilter(now), {
    $expr: { $gt: [{ $ifNull: ["$correctedDate", "$date"] }, new Date("2026-09-26T12:00:00Z")] },
  });
  assert.deepEqual(futureEventDateFilter(new Date(now)), futureEventDateFilter(now));
});

test("the future date cutoff does not change the event detail publication filter", () => {
  assert.deepEqual(publicEventQuery, {
    hidden: { $ne: true }, status: { $nin: ["archived", "draft"] },
  });
});
