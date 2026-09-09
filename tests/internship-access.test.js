import assert from "node:assert/strict";
import test from "node:test";
import { requireBenefits } from "../middleware/authorization.js";

test("internship benefit guard rejects every non-active account despite old active claims", async () => {
  for (const status of ["locked", "payment_awaiting", "frozen", "suspended", "unknown"]) {
    const req = {
      account: { id: "test_member", status, roles: ["member"], expireDate: new Date(Date.now() + 86400000) },
      user: { status: "active", hasBenefits: true },
    };
    let error;
    await requireBenefits()(req, {}, (value) => { error = value; });
    assert.equal(error?.statusCode, 403, status);
    assert.equal(req.user.status, status);
    assert.equal(req.user.hasBenefits, false);
  }
});

test("the internship guard also rejects active accounts without benefits and anonymous requests", async () => {
  for (const account of [
    { id: "test_expired", status: "active", roles: ["member"], expireDate: new Date(0) },
    { id: "test_free_alumni", status: "active", roles: ["alumni"], tier: 0, expireDate: new Date(Date.now() + 86400000) },
  ]) {
    let error;
    await requireBenefits()({ account, user: { hasBenefits: true } }, {}, (value) => { error = value; });
    assert.equal(error?.statusCode, 403);
  }
  let error;
  await requireBenefits()({}, {}, (value) => { error = value; });
  assert.equal(error?.statusCode, 401);
});

test("active accounts with current membership benefits retain internship access", async () => {
  const req = {
    account: { id: "test_active", status: "active", roles: ["member"], expireDate: new Date(Date.now() + 86400000) },
    user: {},
  };
  let called = false;
  await requireBenefits()(req, {}, (error) => { assert.equal(error, undefined); called = true; });
  assert.equal(called, true);
  assert.equal(req.user.hasBenefits, true);
});
