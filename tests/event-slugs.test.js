import assert from "node:assert/strict";
import test from "node:test";
import Event from "../models/Event.js";
import { uniqueEventSlug } from "../services/public-content/event-slug.js";
import { findPublicEvent } from "../services/public-content/find-public-event.js";
import migration from "../migrations/006-region-event-slugs.js";

const records = [
  { _id: "a".repeat(24), slug: "summer-party", region: "groningen", status: "opened" },
  { _id: "b".repeat(24), slug: "summer-party-2906", region: "groningen", status: "closed" },
];
const matches = (record, query) => Object.entries(query).every(([key, value]) => {
  if (value?.$ne !== undefined) return record[key] !== value.$ne;
  if (value?.$nin) return !value.$nin.includes(record[key]);
  return record[key] === value;
});
const model = rows => ({
  exists: async query => rows.some(row => matches(row, query)),
  findOne: async query => rows.find(row => matches(row, query)) ?? null,
  find: query => ({ limit: async count => rows.filter(row => matches(row, query)).slice(0, count) }),
});
const date = "2026-06-29T18:00:00Z";

test("the clean slug is available independently in each region", async () => {
  assert.equal(await uniqueEventSlug(model(records), "Summer Party", { region: "utrecht", date }), "summer-party");
});
test("a collision adds the event day and month", async () => {
  assert.equal(await uniqueEventSlug(model(records.slice(0, 1)), "Summer Party", { region: "groningen", date }), "summer-party-2906");
});
test("a reused date receives another index and historical links remain reserved", async () => {
  assert.equal(await uniqueEventSlug(model(records), "Summer Party", { region: "groningen", date }), "summer-party-2906-2");
});
test("the date suffix uses Amsterdam time and zero padding", async () => {
  assert.equal(await uniqueEventSlug(model(records), "Summer Party", { region: "groningen", date: "2026-06-30T22:30:00Z" }), "summer-party-0107");
});
test("excluding the current event does not cause a false collision", async () => {
  assert.equal(await uniqueEventSlug(model(records), "Summer Party", { region: "groningen", date, excludeId: records[0]._id }), "summer-party");
});
test("legacy dates use a numeric suffix and all generated slugs respect the length limit", async () => {
  assert.equal(await uniqueEventSlug(model(records), "Summer Party", { region: "groningen", date: "invalid" }), "summer-party-2");
  const base = "x".repeat(96);
  const slug = await uniqueEventSlug(model([{ slug: base, region: "groningen" }]), base, { region: "groningen", date });
  assert.equal(slug.length, 96);
  assert.ok(slug.endsWith("-2906"));
});
test("slug lookup selects the correct region and rejects ambiguous unscoped lookups", async () => {
  const other = { ...records[0], _id: "c".repeat(24), region: "utrecht" };
  const Event = model([...records, other]);
  assert.equal(await findPublicEvent(Event, "summer-party", "utrecht"), other);
  assert.equal(await findPublicEvent(Event, "summer-party", "groningen"), records[0]);
  assert.equal(await findPublicEvent(Event, "summer-party", "eindhoven"), null);
  assert.equal(await findPublicEvent(Event, "summer-party"), null);
  assert.equal(await findPublicEvent(Event, "summer-party-2906"), records[1]);
});
test("legacy IDs remain globally resolvable while private and archived events stay excluded", async () => {
  assert.equal(await findPublicEvent(model(records), records[0]._id, "utrecht"), records[0]);
  for (const overrides of [{ hidden: true }, { status: "archived" }, { status: "draft" }]) {
    const Event = model([{ ...records[0], ...overrides }]);
    assert.equal(await findPublicEvent(Event, "summer-party", "groningen"), null);
    assert.equal(await findPublicEvent(Event, records[0]._id, "groningen"), null);
  }
});
test("object-shaped input cannot become a Mongo query operator", async () => {
  assert.equal(await findPublicEvent(model(records), { $ne: "" }, "groningen"), null);
  assert.equal(await findPublicEvent(model(records), "summer-party", { $ne: "groningen" }), records[0]);
});
test("model uniqueness is enforced on region and slug, excluding legacy missing slugs", () => {
  const indexes = Event.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.region === 1 && keys.slug === 1 && options.unique && options.partialFilterExpression.slug.$type === "string"));
  assert.ok(!indexes.some(([keys, options]) => Object.keys(keys).length === 1 && keys.slug && options.unique));
});
test("migration builds the replacement index before dropping only the old global constraint", async () => {
  const calls = [];
  const collection = {
    createIndex: async (keys, options) => calls.push(["create", keys, options]),
    indexes: async () => [
      { name: "_id_", key: { _id: 1 }, unique: true },
      { name: "slug_1", key: { slug: 1 }, unique: true },
      { name: "event_region_slug_unique", key: { region: 1, slug: 1 }, unique: true },
    ],
    dropIndex: async name => calls.push(["drop", name]),
  };
  await migration.up({ collection: name => { assert.equal(name, "events"); return collection; } });
  assert.deepEqual(calls.map(call => call[0]), ["create", "drop"]);
  assert.equal(calls[1][1], "slug_1");
  assert.deepEqual(calls[0][1], { region: 1, slug: 1 });
});
