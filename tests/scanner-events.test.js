import test from "node:test";
import assert from "node:assert/strict";
import { createScannerEventsHandler } from "../controllers/Events/scanner-events-controller.js";

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
  const r = await run({ roles: ["board_member"], region: "groningen" });
  assert.equal(r.error, undefined);
  assert.equal(r.filter.region, "groningen");
  assert.deepEqual(r.filter.status.$nin, ["archived", "draft"]);
  assert.equal(r.projection, "_id title region date correctedDate poster status");
  assert.equal(r.lean, true);
  assert.equal(r.data.events[0].id, "event-id");
  assert.equal(r.data.events[0].guestList, undefined);
  assert.equal(r.data.events[0].description, undefined);
  assert.equal(r.headers["Cache-Control"], "private, no-store");
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
