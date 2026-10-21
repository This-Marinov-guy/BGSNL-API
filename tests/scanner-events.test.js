import test from "node:test";
import assert from "node:assert/strict";
import { createScannerEventsHandler, scannerPosterUrl } from "../controllers/Events/scanner-events-controller.js";

async function run(user, fail = false) {
  let filter, projection, order, lean = false, data, error;
  const headers = {};
  const handler = createScannerEventsHandler({ EventModel: { find(value) {
    filter = value;
    return { select(value) { projection = value; return this; }, sort(value) { order = value; return this; }, async lean() {
      lean = true;
      if (fail) throw new Error("offline");
      return [{ _id: "event-id", title: "Scanner event", region: "groningen", status: "opened", guestList: ["private"], description: "large payload" }];
    } };
  } } });
  await handler({ user, query: { region: "amsterdam" } }, { set(key, value) { headers[key] = value; }, status() { return this; }, json(value) { data = value; } }, value => { error = value; });
  return { filter, projection, order, lean, data, error, headers };
}

test("regional scanner lists are scoped and select only lightweight fields", async () => {
  const r = await run({ userId: "staff-1", roles: ["board_member"], status: "active", region: "groningen" });
  assert.equal(r.error, undefined);
  assert.equal(r.filter.region, "groningen");
  assert.deepEqual(r.filter.status.$nin, ["archived", "draft"]);
  assert.equal(r.projection, "_id title region date correctedDate poster status");
  assert.equal(r.lean, true);
  assert.equal(r.data.events[0].id, "event-id");
  assert.equal(r.data.events[0].guestList, undefined);
  assert.equal(r.data.events[0].description, undefined);
  assert.deepEqual(r.data.access, { userId: "staff-1", roles: ["board_member"], status: "active", region: "groningen" });
  assert.equal(r.headers["Cache-Control"], "private, no-store");
});
test("scanner poster URLs use a small Cloudinary delivery without rewriting other origins", () => {
  assert.equal(scannerPosterUrl("https://res.cloudinary.com/bgsnl/image/upload/v123/events/poster.jpg"),
    "https://res.cloudinary.com/bgsnl/image/upload/c_limit,w_400/f_auto/q_auto/v123/events/poster.jpg");
  assert.equal(scannerPosterUrl("https://images.example.com/poster.jpg"), "https://images.example.com/poster.jpg");
  assert.equal(scannerPosterUrl("https://res.cloudinary.com/bgsnl/image/upload/c_fill,w_800/v123/poster.jpg"),
    "https://res.cloudinary.com/bgsnl/image/upload/c_fill,w_800/v123/poster.jpg");
});
test("a reopened scanner queries only the selected event within its current region", async () => {
  const eventId = "507f1f77bcf86cd799439011";
  const filters = [];
  const EventModel = { find(filter) {
    filters.push(filter);
    return { select() { return this; }, sort() { return this; }, async lean() {
      if (filter._id && filter.region !== "groningen") return [];
      return [{ _id: filter._id || "another-event", title: "Event", region: filter.region }];
    } };
  } };
  const handler = createScannerEventsHandler({ EventModel });
  const call = async (region) => {
    let data;
    await handler({ user: { userId: "staff", roles: ["board_member"], status: "active", region }, query: { forEvent: eventId } },
      { set() {}, status() { return this; }, json(value) { data = value; } }, () => {});
    return data;
  };
  assert.equal((await call("groningen")).events[0].id, eventId);
  assert.equal(filters.length, 1);
  assert.equal(filters[0].region, "groningen");
  assert.equal(filters[0]._id, eventId);
  assert.deepEqual(filters[0].status.$nin, ["archived", "draft"]);
  assert.equal((await call("amsterdam")).events[0].id, "another-event");
  assert.equal(filters[1]._id, eventId);
  assert.equal(filters[1].region, "amsterdam");
  assert.equal(filters[2]._id, undefined);
  assert.equal(filters[2].region, "amsterdam");
});
test("admin and national committee retain cross-region access", async () => {
  for (const role of ["admin", "national_committee_member"]) {
    const r = await run({ roles: [role], region: "netherlands" });
    assert.equal(r.error, undefined);
    assert.equal(r.filter.region, undefined);
  }
});
test("unauthorized or unscoped accounts fail before querying", async () => {
  for (const user of [undefined, { roles: ["member"], region: "groningen" }, { roles: ["board_member"] }, { roles: ["board_member"], region: "netherlands" }]) {
    const r = await run(user);
    assert.equal(r.error.code, 403);
    assert.equal(r.filter, undefined);
  }
});
test("database failures return an error rather than an empty success", async () => {
  const r = await run({ roles: ["admin"] }, true);
  assert.equal(r.error.code, 500);
  assert.equal(r.data, undefined);
});
