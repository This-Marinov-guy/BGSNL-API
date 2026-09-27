import test from "node:test";
import assert from "node:assert/strict";
import { ACCESS_1, ACCESS_2, ACCESS_3, ACCESS_4, ALL_EVENT_REGIONS_ACCESS, ALL_MEMBER_REGIONS_ACCESS, MEMBER_ADMIN_ACCESS, EVENT_MANAGEMENT_ACCESS, LIMITLESS_ACCOUNT } from "../util/config/defines.js";
import { SUPPORT_ROLES } from "../services/support/policy.js";
import { normalizeRoleNames } from "../util/config/account-roles.js";

test("renamed roles have exactly the legacy permissions", () => {
  for (const [oldRole, newRole] of [["board_member", "regional_board_member"], ["committee_member", "regional_committee_member"], ["society_board_member", "national_board_member"]]) {
    assert.deepEqual(normalizeRoleNames([oldRole]), [newRole]);
    for (const access of [ACCESS_1, ACCESS_2, ACCESS_3, ACCESS_4, SUPPORT_ROLES, LIMITLESS_ACCOUNT]) assert.equal(access.includes(oldRole), access.includes(newRole));
  }
});
test("national committee receives event and member administration without other staff privileges", () => {
  for (const access of [ACCESS_1, ACCESS_2, ACCESS_3, SUPPORT_ROLES, LIMITLESS_ACCOUNT]) assert.equal(access.includes("national_committee_member"), false);
  for (const access of [ACCESS_4, ALL_EVENT_REGIONS_ACCESS, ALL_MEMBER_REGIONS_ACCESS, MEMBER_ADMIN_ACCESS, EVENT_MANAGEMENT_ACCESS]) assert.equal(access.includes("national_committee_member"), true);
});
test("regional committee remains events-only; national board excludes support", () => {
  assert.equal(ACCESS_4.includes("regional_committee_member"), true);
  assert.equal(ACCESS_3.includes("regional_committee_member"), false);
  assert.equal(ACCESS_2.includes("regional_board_member"), false);
  assert.equal(ACCESS_2.includes("national_board_member"), true);
  assert.equal(SUPPORT_ROLES.includes("national_board_member"), false);
});
