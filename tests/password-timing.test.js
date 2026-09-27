import assert from "node:assert/strict";
import test from "node:test";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPasswordVerifier, passwordVerificationMinimumMs, PASSWORD_VERIFICATION_MIN_MS } from "../services/authentication/passwords.js";
import { createPasswordLogin } from "../controllers/security-controller.js";
import { verifyCurrentPassword } from "../services/authentication/google.js";
import { createPasswordRateLimit } from "../middleware/password-rate-limit.js";
import { loginValidators } from "../validation/form-validators.js";
import { validateRequest } from "../middleware/validate-request.js";

// Format-valid synthetic hashes; mocked derivation here tests deterministic
// control flow. Real bcrypt compatibility and HTTP timings have separate tests.
const hash = (cost = 12) => `$2a$${String(cost).padStart(2, "0")}$${"a".repeat(53)}`;
const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; }, set(key, value) { this.headers[key] = value; return this; } });
function harness({ duration = 250, matches = false, broken = false, lookupMs = 0 } = {}) {
  let clock = 100, derivations = [], comparisons = [], waits = [];
  const now = () => clock;
  const verify = createPasswordVerifier({ now, minimumMs: () => 750,
    wait: async (ms) => { waits.push(ms); clock += ms; },
    derive: async (value, salt) => {
      derivations.push({ value, salt }); clock += duration;
      if (broken) throw new Error("Derivation failed");
      return salt + (matches ? "a" : "b").repeat(31);
    },
    equal: (a, b) => { comparisons.push([a, b]); return timingSafeEqual(a, b); },
  });
  const findAccount = async (account) => { clock += lookupMs; return account; };
  return { verify, now, findAccount, derivations, comparisons, waits };
}

test("verification floor is server-configurable but cannot be disabled or made unbounded", () => {
  for (const value of ["", "0", "1", "749", "-50", "NaN", "Infinity", "5001"]) {
    assert.equal(passwordVerificationMinimumMs(value), PASSWORD_VERIFICATION_MIN_MS);
  }
  for (const value of ["750", "1200", "5000"]) assert.equal(passwordVerificationMinimumMs(value), Number(value));
  assert.equal(passwordVerificationMinimumMs("750.1"), 751);
});

test("short, long, Unicode and missing credentials do bcrypt work and share a deadline", async () => {
  for (const value of ["x", "normal-wrong-password", "x".repeat(72), "x".repeat(256), "б".repeat(128), " x ", "", null, {}, "x".repeat(5000), "б".repeat(4096)]) {
    for (const stored of [hash(), hash(4), undefined, "malformed"]) {
      const h = harness({ duration: stored === hash(4) ? 2 : 250 });
      assert.equal(await h.verify(value, stored), false);
      assert.equal(h.now(), 850);
      assert.equal(h.derivations.length, 1);
      assert.equal(h.comparisons.length, 1);
      for (const buffer of h.comparisons[0]) assert.equal(buffer.length, 60);
      assert.ok(Buffer.byteLength(h.derivations[0].value) <= 4096);
      if (!stored || stored === "malformed") assert.match(h.derivations[0].salt, /^\$2a\$12\$/);
    }
  }
});

test("successful comparisons and errors wait too; work over the floor is never skipped", async () => {
  const success = harness({ matches: true });
  assert.equal(await success.verify("password", hash()), true);
  assert.equal(success.now(), 850);
  const broken = harness({ broken: true });
  assert.equal(await broken.verify("password", hash()), false);
  assert.equal(broken.now(), 850);
  const slow = harness({ duration: 1100 });
  assert.equal(await slow.verify("password", hash(14)), false);
  assert.equal(slow.now(), 1200);
  assert.equal(slow.waits.length, 0);
});

test("a match against dummy work can never authenticate absent or malformed credentials", async () => {
  let calls = 0;
  const verify = createPasswordVerifier({ now: () => 0, minimumMs: () => 0,
    derive: async (value, salt) => { calls++; return `${salt}${"a".repeat(31)}`; }, equal: () => true });
  for (const [value, stored] of [["password", undefined], ["password", "corrupt"], ["", hash()], [null, hash()], ["x".repeat(5000), hash()]]) {
    assert.equal(await verify(value, stored), false);
  }
  assert.equal(calls, 5);
});

test("fixed-size native comparison checks every position; it cannot authenticate a prefix", async () => {
  for (const position of [0, 15, 29, 59]) {
    const different = [...hash()]; different[position] = different[position] === "z" ? "y" : "z";
    const verify = createPasswordVerifier({ now: () => 0, minimumMs: () => 0, derive: async () => different.join("") });
    assert.equal(await verify("password", hash()), false);
  }
  for (const derived of [null, "", hash().slice(1), `${hash()}x`]) {
    const verify = createPasswordVerifier({ now: () => 0, minimumMs: () => 0, derive: async () => derived });
    assert.equal(await verify("password", hash()), false);
  }
});

test("an early timer wake-up cannot release verification before the shared deadline", async () => {
  let clock = 0, waits = 0;
  const verify = createPasswordVerifier({ now: () => clock, minimumMs: () => 750,
    derive: async () => hash(), wait: async (ms) => { clock += ++waits === 1 ? ms - 1 : ms; } });
  assert.equal(await verify("password", hash()), true);
  assert.equal(clock, 750); assert.equal(waits, 2);
});

test("login pads from BEFORE lookup and returns identical errors for absent/invalid/legacy accounts", async () => {
  for (const account of [null, { password: hash() }, { password: hash(4) }, { password: "broken" }]) {
    for (const lookupMs of [0, 40, 250]) {
      const h = harness({ lookupMs, duration: account?.password === hash(4) ? 2 : 250 });
      let error, built = false;
      const login = createPasswordLogin({ now: h.now, verify: h.verify, findAccount: () => h.findAccount(account),
        buildResponse: async () => { built = true; } });
      await login({ body: { email: "synthetic@example.invalid", password: "wrong", startedAt: -99999 } }, response(), (value) => { error = value; });
      assert.equal(error.statusCode, 401); assert.equal(error.message, "Invalid credentials");
      assert.equal(h.now(), 850); assert.equal(h.derivations.length, 1); assert.equal(built, false);
    }
  }
});

test("login verifies after a lookup error and refuses to build sessions for missing accounts", async () => {
  const h = harness(); let error;
  const login = createPasswordLogin({ now: h.now, verify: h.verify, findAccount: async () => { throw new Error("DB unavailable"); } });
  await login({ body: { email: "synthetic@example.invalid", password: "wrong" } }, response(), (value) => { error = value; });
  assert.equal(error.statusCode, 503); assert.equal(h.derivations.length, 1); assert.equal(h.now(), 850);
  let built = false;
  const missing = createPasswordLogin({ findAccount: async () => null, verify: async () => true,
    buildResponse: async () => { built = true; } });
  await missing({ body: { email: "synthetic@example.invalid", password: "wrong" } }, response(), (value) => { error = value; });
  assert.equal(error.statusCode, 401); assert.equal(built, false);
});

test("successful login keeps the response contract and verifies before issuing credentials", async () => {
  const account = { id: "member_fixture", password: hash() }, h = harness({ matches: true, lookupMs: 80 });
  const login = createPasswordLogin({ now: h.now, verify: h.verify, findAccount: () => h.findAccount(account),
    buildResponse: async (user) => { assert.equal(user, account); assert.equal(h.now(), 850); return { token: "synthetic" }; } });
  const res = response();
  await login({ body: { email: "synthetic@example.invalid", password: "correct" } }, res, (error) => { throw error; });
  assert.equal(res.code, 201); assert.deepEqual(res.body, { token: "synthetic" });
});

test("Google/passkey reauthentication never bypasses verification for missing stored passwords", async () => {
  for (const [user, value] of [[{}, "password"], [null, "password"], [{ password: hash() }, ""], [{ password: hash() }, "x".repeat(257)]]) {
    let calls = 0;
    await assert.rejects(verifyCurrentPassword(user, value, async () => { calls++; return false; }), (error) => error.statusCode === 403);
    assert.equal(calls, 1);
  }
});

test("malformed login input and rate-limited requests are rejected before expensive password work", async () => {
  for (const password of ["", {}, "x".repeat(257)]) {
    const req = { body: { email: "synthetic@example.invalid", password } }, res = response(); let passed = false;
    for (const validator of loginValidators) await validator.run(req);
    validateRequest(req, res, () => { passed = true; });
    assert.equal(passed, false); assert.equal(res.code, 422);
  }
  const req = { body: { email: "synthetic@example.invalid" }, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  for (const unavailable of [false, true]) {
    let error;
    const limit = createPasswordRateLimit("login", { limits: { findOneAndUpdate: async () => {
      if (unavailable) throw new Error("Unavailable"); return { count: 999 };
    } } });
    await limit(req, response(), (value) => { error = value; });
    assert.equal(error.statusCode, unavailable ? 503 : 429);
  }
  const routes = await readFile(new URL("../routes/security-routes.js", import.meta.url), "utf8");
  assert.match(routes, /"\/login", loginValidators, validateRequest, createPasswordRateLimit\("login"\), login/);
});
