import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { readFile } from "node:fs/promises";
import { validationResult } from "express-validator";
import { hashPassword, verifyPassword, validNewPassword, registrationPasswordHash, PASSWORD_COST } from "../services/authentication/passwords.js";
import { verifyCurrentPassword } from "../services/authentication/google.js";
import { loginValidators, signupCheckoutValidators, editUserValidators, changePasswordValidators } from "../validation/form-validators.js";
import { startMembershipSignup, reserveCheckout } from "../services/subscriptions/checkout.js";
import { MEMBERSHIP_PLANS } from "../util/subscriptions/policy.js";
import { encryptData } from "../util/functions/helpers.js";
import User from "../models/User.js";
import { readDatabaseCollection } from "../controllers/Integration/google-scripts-controllers.js";

process.env.CRYPTO_ENCRYPTION_KEY = "password-hashing-test-only-encryption-key";
const password = "  Password-fixture-123!  ";
const validate = async (validators, body) => {
  const req = { body }; for (const validator of validators) await validator.run(req);
  return { req, errors: validationResult(req).array() };
};
test("all new hashes use salted bcrypt at cost 12 and preserve the exact password", async () => {
  const a = await hashPassword(password), b = await hashPassword(password);
  assert.equal(bcrypt.getRounds(a), PASSWORD_COST); assert.notEqual(a, b);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword(password.trim(), a), false);
  assert.equal(await verifyPassword("incorrect", a), false);
  await verifyCurrentPassword({ password: a }, password);
});
test("existing bcrypt costs and compatible 2a/2b/2y prefixes still verify unchanged", async () => {
  for (const cost of [4, 10, 12]) {
    const original = await bcrypt.hash("oldpass", cost);
    for (const prefix of ["2a", "2b", "2y"]) {
      const stored = original.replace(/^\$2a/, `$${prefix}`);
      assert.equal(await verifyPassword("oldpass", stored), true);
      assert.equal(await verifyPassword("wrong", stored), false);
      assert.equal(bcrypt.getRounds(stored), cost);
    }
  }
});
test("new 72-byte limits do not lock out existing long or Unicode passwords", async () => {
  const legacy = "Ab1" + "б".repeat(60), original = await bcrypt.hash(legacy, 4);
  assert.equal(await verifyPassword(legacy, original), true);
  assert.equal(validNewPassword(legacy), false);
  await assert.rejects(hashPassword(legacy), (e) => e.statusCode === 422);
  const boundary = "Ab1!" + "б".repeat(34);
  assert.equal(Buffer.byteLength(boundary), 72); assert.equal(validNewPassword(boundary), true);
  assert.equal(validNewPassword(boundary + "a"), false);
  const pendingLegacy = await hashPassword(legacy, { legacyCheckout: true });
  assert.equal(await verifyPassword(legacy, pendingLegacy), true);
});
test("hash-looking user passwords are hashed normally, never adopted as trusted hashes", async () => {
  const raw = await bcrypt.hash("Password-123!", 4), stored = await hashPassword(raw);
  assert.notEqual(stored, raw);
  assert.equal(await verifyPassword(raw, stored), true);
  assert.equal(await verifyPassword("Password-123!", stored), false);
  for (const corrupt of [null, "plaintext", "$2a$12$broken", {}, 123]) assert.equal(await verifyPassword(password, corrupt), false);
});
test("only explicit trusted stored hashes are copied; old pending reservations remain compatible", async () => {
  const stored = await bcrypt.hash(password, 4);
  assert.equal(registrationPasswordHash({ passwordHash: stored }), stored);
  assert.equal(registrationPasswordHash({ password: stored }), stored);
  for (const record of [{}, { password: "plaintext" }, { passwordHash: "bad", password: stored }, { passwordHash: stored, password: "other" }]) {
    assert.throws(() => registrationPasswordHash(record));
  }
});
test("login does not trim passwords or apply new-password strength rules", async () => {
  for (const value of [password, "oldpass", "Ab1" + "б".repeat(60)]) {
    const { req, errors } = await validate(loginValidators, { email: "fixture@example.test", password: value });
    assert.equal(errors.length, 0); assert.equal(req.body.password, value);
  }
});
test("signup, reset and profile update share new-password policy including UTF-8 limits", async () => {
  for (const value of [password, "weak", "Ab1" + "б".repeat(60)]) {
    for (const [validators, input] of [[signupCheckoutValidators, encryptData(value)], [changePasswordValidators, value], [editUserValidators, value]]) {
      const { errors } = await validate(validators, { password: input });
      assert.equal(errors.some((error) => error.param === "password"), !validNewPassword(value));
    }
  }
});
test("paid signup hashes server-side before reserving checkout and ignores supplied hash/role fields", async () => {
  for (const plan of [MEMBERSHIP_PLANS.find((p) => p.type === "member"), MEMBERSHIP_PLANS.find((p) => p.type === "alumni")]) {
    let reservation;
    await startMembershipSignup({ method: plan.type === "member" ? "signup" : "alumni-signup", itemId: plan.priceId,
      email: "Fixture@example.test", password: encryptData(password), passwordHash: "attacker", roles: ["admin"], origin_url: "https://bulgariansociety.nl" }, null,
    { findAccount: async () => null, checkout: async (data) => { reservation = data; } });
    assert.equal(reservation.registration.passwordHash, undefined); assert.equal(reservation.registration.roles, undefined);
    assert.equal(await verifyPassword(password, reservation.registration.password), true);
    assert.equal(bcrypt.getRounds(reservation.registration.password), PASSWORD_COST);
  }
});
test("invalid pending password state cannot initiate Stripe checkout", async () => {
  let contacted = false;
  await assert.rejects(reserveCheckout({ registration: { password: "plaintext" }, dependencies: { withLease: () => { contacted = true; } } }));
  assert.equal(contacted, false);
});
test("public direct-signup routes remain disabled; hashing refactoring does not bypass payment", async () => {
  const routes = await readFile(new URL("../routes/security-routes.js", import.meta.url), "utf8");
  for (const path of ["signup", "alumni-signup"]) assert.match(routes, new RegExp(`"/${path}",\\s+postDirectSignupDisabled`));
  const sources = ["controllers/security-controller.js", "services/main-services/stripe-webhook-service.js", "services/subscriptions/checkout.js",
    "services/authentication/password-reset.js", "services/authentication/profile-change.js", "services/authentication/google.js"];
  for (const file of sources) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /passwords\.js/); assert.doesNotMatch(source, /bcrypt\.(hash|compare)\(/);
  }
});
test("the legacy user-data export excludes password hashes at the database query", async (t) => {
  t.mock.method(User, "find", () => ({ select: (projection) => {
    assert.doesNotMatch(projection, /password/i);
    return { lean: async () => [{ name: "Fixture" }] };
  } }));
  let result;
  await readDatabaseCollection({ params: { collection: "users" } }, { status(code) {
    assert.equal(code, 200); return { json(body) { result = body; } };
  } });
  assert.equal(result.data[0].password, undefined);
});
