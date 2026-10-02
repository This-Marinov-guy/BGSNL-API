import assert from "node:assert/strict";
import test from "node:test";
import { REGIONS } from "../util/config/defines.js";
import { NEARBY_REGIONS, eventAnnouncementRegions } from "../util/config/nearby-regions.js";

test("nearby-region map covers all regions with unique, symmetric, known neighbours", () => {
  assert.deepEqual(Object.keys(NEARBY_REGIONS).sort(), [...REGIONS].sort());
  assert.ok(Object.isFrozen(NEARBY_REGIONS));
  for (const [region, nearby] of Object.entries(NEARBY_REGIONS)) {
    assert.ok(Object.isFrozen(nearby));
    assert.equal(new Set(nearby).size, nearby.length);
    assert.ok(!nearby.includes(region));
    for (const neighbour of nearby) {
      assert.ok(REGIONS.includes(neighbour));
      assert.ok(NEARBY_REGIONS[neighbour].includes(region));
    }
    assert.deepEqual(eventAnnouncementRegions(region), [region, ...nearby]);
  }
});

test("audiences include only the host and immediate neighbours, not neighbours of neighbours", () => {
  assert.deepEqual(eventAnnouncementRegions("eindhoven"), ["eindhoven", "breda_tilburg"]);
  assert.deepEqual(eventAnnouncementRegions("maastricht"), ["maastricht"]);
  assert.deepEqual(eventAnnouncementRegions("groningen"), ["groningen", "leeuwarden"]);
  assert.deepEqual(eventAnnouncementRegions("amsterdam"), ["amsterdam", "rotterdam", "leiden_hague"]);
});

test("invalid hosts never expand the audience and returned arrays cannot mutate the map", () => {
  for (const region of [undefined, null, "", "unknown", "netherlands", "__proto__", "constructor", {}]) {
    assert.deepEqual(eventAnnouncementRegions(region), []);
  }
  eventAnnouncementRegions("maastricht").push("amsterdam");
  assert.deepEqual(eventAnnouncementRegions("maastricht"), ["maastricht"]);
});
