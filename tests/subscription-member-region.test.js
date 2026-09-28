import test from "node:test";
import assert from "node:assert/strict";
import { selectedMemberRegion, memberRegionMetadata, confirmedMemberRegion } from "../services/subscriptions/member-region.js";

test("membership region excludes the national billing account", () => {
  assert.throws(() => selectedMemberRegion({ type: "member" }, "netherlands", "amsterdam"));
  assert.throws(() => memberRegionMetadata("netherlands", "price_member"));
  assert.equal(selectedMemberRegion({ type: "member" }, "rotterdam", "amsterdam"), "rotterdam");
  assert.equal(selectedMemberRegion({ type: "member" }, undefined, "netherlands"), undefined);
  assert.equal(selectedMemberRegion({ type: "alumni" }, undefined, "amsterdam"), undefined);
});

test("region is applied once, only for a confirmed matching member plan", () => {
  const sub = { metadata: memberRegionMetadata("amsterdam", "price_member", "operation_test") };
  const state = { hasBenefits: true, plan: { type: "member", priceId: "price_member" } };
  assert.deepEqual(confirmedMemberRegion(sub, state, {}), { region: "amsterdam", operation: "operation_test" });
  assert.equal(confirmedMemberRegion(sub, state, { memberRegionOperation: "operation_test" }), null);
  assert.equal(confirmedMemberRegion(sub, { ...state, hasBenefits: false }, {}), null);
  assert.equal(confirmedMemberRegion({ ...sub, pending_update: {} }, state, {}), null);
  assert.equal(confirmedMemberRegion(sub, { ...state, plan: { type: "member", priceId: "price_other" } }, {}), null);
  assert.equal(confirmedMemberRegion(sub, { ...state, plan: { type: "alumni", priceId: "price_member" } }, {}), null);
  assert.equal(confirmedMemberRegion({ metadata: { ...sub.metadata, bgsnlMemberRegion: "netherlands" } }, state, {}), null);
});
