import test from "node:test";
import assert from "node:assert/strict";
import { planCheckIn, checkInMutation } from "../services/tickets/check-in.js";

const guest = (id, changes = {}) => ({ _id: id, code: 123, name: "Test Guest", email: "test@example.com", status: 0, ...changes });
test("manual confirmation previews without reserving admission and rechecks on confirm", () => {
  const guests = [guest("a")];
  const preview = planCheckIn(guests, 123, undefined, { preview: true });
  assert.equal(preview.outcome, "confirm_required");
  assert.equal(preview.ids, undefined);
  assert.equal(preview.admitted, undefined);
  assert.equal(guests[0].status, 0);
  assert.equal(planCheckIn(guests, 123, 1).outcome, "present");
  guests[0].status = 1;
  assert.equal(planCheckIn(guests, 123, 1).outcome, "already_present");
  assert.equal(planCheckIn([guest("a"), guest("b")], 123, undefined, { preview: true }).outcome, "choose_quantity");
  assert.equal(planCheckIn([guest("a", { refunded: true })], 123, undefined, { preview: true }).outcome, "refunded");
});
test("check-in selects the exact purchase, not matching names", () => {
  const result = planCheckIn([guest("other", { code: 999 }), guest("target")], "123");
  assert.deepEqual(result.ids, ["target"]);
  assert.equal(result.status, 1);
});
test("group check-in requires an explicit quantity", () => {
  assert.equal(planCheckIn([guest("a"), guest("b")], 123).outcome, "choose_quantity");
  assert.deepEqual(planCheckIn([guest("a"), guest("b")], 123, 1).ids, ["a"]);
  assert.equal(planCheckIn([guest("a")], 123, 2).outcome, "invalid_quantity");
});
test("refunded, duplicate and unknown codes cannot admit guests", () => {
  assert.equal(planCheckIn([guest("a", { refunded: true })], 123).outcome, "refunded");
  assert.equal(planCheckIn([guest("a", { status: 1 })], 123).outcome, "already_present");
  assert.equal(planCheckIn([guest("a")], 999).outcome, "not_found");
  assert.deepEqual(planCheckIn([guest("a", { refunded: true }), guest("b")], 123).ids, ["b"]);
});
test("atomic update guards every selected seat against concurrent scans/refunds", () => {
  const mutation = checkInMutation({ _id: "event", region: "groningen" }, { ids: ["a", "b"] });
  assert.equal(mutation.filter.$and.length, 2);
  assert.deepEqual(mutation.filter.$and[0].guestList.$elemMatch, { _id: "a", status: { $ne: 1 }, refunded: { $ne: true } });
  assert.deepEqual(mutation.options.arrayFilters, [{ "guest._id": { $in: ["a", "b"] } }]);
  assert.equal(mutation.update.$set["guestList.$[guest].status"], 1);
});
