import assert from "node:assert/strict";
import test from "node:test";
import { jwtRefresh } from "../util/functions/helpers.js";

test("malformed refresh tokens are rejected without throwing", () => {
  assert.equal(jwtRefresh(null), null);
  assert.equal(jwtRefresh("not-a-jwt"), null);
  assert.equal(jwtRefresh("aaa.bbb.ccc"), null);
});
