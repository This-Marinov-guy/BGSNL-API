import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { issuePasswordReset, verifyPasswordReset, completePasswordReset, RESET_LIFETIME_MS, RESET_ATTEMPTS } from "../services/authentication/password-reset.js";
import { createPasswordRateLimit } from "../middleware/password-rate-limit.js";
import PasswordResetChallenge from "../models/PasswordResetChallenge.js";

process.env.JWT_STRING = "isolated-password-reset-tests-not-a-real-secret";
const invalid = (error) => error.statusCode === 400;
function matches(row, query) {
  if (!row) return false;
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((entry) => matches(row, entry));
    if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([operator, operand]) => {
      if (operator === "$gt") return row[key] > operand;
      if (operator === "$exists") return (row[key] !== undefined) === operand;
      if (operator === "$nin") return !operand.includes(row[key]);
      throw new Error(`Unexpected operator ${operator}`);
    });
    return row[key] === value;
  });
}
function harness() {
  let clock = 1800000000000, row = null;
  let live = { _id: "member_fixture", id: "member_fixture", email: "fixture@example.test", password: "old-password-hash", sessionVersion: 0, identityRevision: 0, status: "locked" };
  let tail = Promise.resolve();
  const clone = (value) => structuredClone(value);
  const update = (target, changes) => {
    Object.assign(target, changes.$set);
    for (const [key, amount] of Object.entries(changes.$inc || {})) target[key] = (target[key] ?? 0) + amount;
    return clone(target);
  };
  const Model = { findOneAndUpdate: async (query, changes, options) => {
    assert.ok(options.session);
    return matches(live, query) ? update(live, changes) : null;
  } };
  const user = () => ({ ...clone(live), constructor: Model });
  const challenges = {
    findOneAndUpdate: async (query, changes, options) => {
      if (options.upsert) { assert.ok(options.session); row ??= { _id: query._id }; }
      return matches(row, query) ? update(row, changes) : null;
    },
    findOneAndDelete: async (query, options) => {
      assert.ok(options.session);
      if (!matches(row, query)) return null;
      const result = row; row = null; return result;
    },
  };
  const dependencies = { challenges, now: () => clock, hashPassword: async () => "new-password-hash", startSession: async () => ({
    endSession: async () => {},
    withTransaction: (run) => {
      const result = tail.then(async () => {
        const before = { row: clone(row), live: clone(live) };
        try { await run(); } catch (error) { row = before.row; live = before.live; throw error; }
      });
      tail = result.catch(() => {}); return result;
    },
  }) };
  return { user, dependencies, row: () => row, live: () => live, advance: (amount) => { clock += amount; } };
}

test("reset codes are hashed, time-limited and replaced on resend", async () => {
  const h = harness();
  const first = await issuePasswordReset(h.user(), h.dependencies);
  assert.match(first, /^\d{6}$/);
  assert.equal(h.row().code, undefined);
  assert.equal(h.row().codeHash.length, 64);
  assert.equal(h.row().attemptsLeft, RESET_ATTEMPTS);
  const generation = h.row().generation;
  await issuePasswordReset(h.user(), h.dependencies);
  assert.notEqual(h.row().generation, generation);
  h.advance(RESET_LIFETIME_MS);
  await assert.rejects(verifyPasswordReset(h.user(), first, h.dependencies), invalid);
});
test("correct verify then reset is single-use and revokes previous sessions", async () => {
  const h = harness(), code = await issuePasswordReset(h.user(), h.dependencies);
  await verifyPasswordReset(h.user(), code, h.dependencies);
  await completePasswordReset(h.user(), code, "New-password-123", h.dependencies);
  assert.equal(h.live().password, "new-password-hash");
  assert.equal(h.live().sessionVersion, 1);
  assert.equal(h.live().status, "locked");
  assert.equal(h.row(), null);
  await assert.rejects(completePasswordReset(h.user(), code, "Other-password-123", h.dependencies), invalid);
});
test("direct final-step wrong codes consume the same attempt budget", async () => {
  const h = harness(), code = await issuePasswordReset(h.user(), h.dependencies);
  const wrong = code === "111111" ? "222222" : "111111";
  for (let i = 0; i < RESET_ATTEMPTS; i++) await assert.rejects(completePasswordReset(h.user(), wrong, "New-password-123", h.dependencies), invalid);
  assert.equal(h.row().attemptsLeft, 0);
  await assert.rejects(verifyPasswordReset(h.user(), code, h.dependencies), invalid);
  await assert.rejects(completePasswordReset(h.user(), code, "New-password-123", h.dependencies), invalid);
  assert.equal(h.live().password, "old-password-hash");
});
test("verification wrong codes also exhaust the budget", async () => {
  const h = harness(), code = await issuePasswordReset(h.user(), h.dependencies);
  const wrong = code === "111111" ? "222222" : "111111";
  for (let i = 0; i < RESET_ATTEMPTS; i++) await assert.rejects(verifyPasswordReset(h.user(), wrong, h.dependencies), invalid);
  await assert.rejects(completePasswordReset(h.user(), code, "New-password-123", h.dependencies), invalid);
});
test("missing users/codes are controlled errors and expired codes never reach hashing", async () => {
  const h = harness();
  await assert.rejects(verifyPasswordReset(null, "123456", h.dependencies), invalid);
  await assert.rejects(completePasswordReset(h.user(), "123456", "New-password-123", h.dependencies), invalid);
  const code = await issuePasswordReset(h.user(), h.dependencies);
  h.advance(RESET_LIFETIME_MS);
  await assert.rejects(completePasswordReset(h.user(), code, "New-password-123", { ...h.dependencies, hashPassword: () => { throw new Error("Must not hash"); } }), invalid);
});
test("two concurrent correct submissions can change the password only once", async () => {
  const h = harness(), code = await issuePasswordReset(h.user(), h.dependencies), user = h.user();
  const results = await Promise.allSettled([1, 2].map(() => completePasswordReset(user, code, "New-password-123", h.dependencies)));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(h.live().sessionVersion, 1);
});
test("account changes during reset roll back code consumption and password writes", async () => {
  for (const change of [{ password: "changed" }, { sessionVersion: 2 }, { status: "alumni-migrated" }, { email: "changed@example.test" }]) {
    const h = harness(), code = await issuePasswordReset(h.user(), h.dependencies);
    await assert.rejects(completePasswordReset(h.user(), code, "New-password-123", { ...h.dependencies,
      hashPassword: async () => { Object.assign(h.live(), change); return "new-password-hash"; },
    }), invalid);
    assert.ok(h.row());
    assert.notEqual(h.live().password, "new-password-hash");
  }
});
test("a replacement code cannot be consumed by an in-flight older request", async () => {
  const h = harness(), code = await issuePasswordReset(h.user(), h.dependencies);
  await assert.rejects(completePasswordReset(h.user(), code, "New-password-123", { ...h.dependencies,
    hashPassword: async () => { await issuePasswordReset(h.user(), h.dependencies); return "new-password-hash"; },
  }), invalid);
  assert.equal(h.live().sessionVersion, 0);
});
test("reset expiry is enforced in code and has a TTL cleanup index", () => {
  assert.ok(PasswordResetChallenge.schema.indexes().some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));
});
test("password rate limits persist per account across IP changes and fail closed", async () => {
  const rows = new Map(), limits = { findOneAndUpdate: async ({ _id }) => {
    const count = (rows.get(_id) || 0) + 1; rows.set(_id, count); return { count };
  } };
  const middleware = createPasswordRateLimit("reset-send", { limits, now: () => 1800000000000 });
  for (let i = 0; i < 4; i++) {
    let error, retry;
    await middleware({ body: { email: "FIXTURE@example.test" }, ip: `192.0.2.${i}` }, { set: (_key, value) => { retry = value; } }, (value) => { error = value; });
    assert.equal(error?.statusCode, i === 3 ? 429 : undefined);
    if (i === 3) assert.ok(Number(retry) > 0);
  }
  let error;
  await createPasswordRateLimit("login", { limits: { findOneAndUpdate: async () => { throw new Error("DB unavailable"); } } })({ body: {} }, {}, (value) => { error = value; });
  assert.equal(error.statusCode, 503);
});
test("legacy password overwrite is retired and both reset endpoints share throttling", async () => {
  const source = await readFile(new URL("../routes/security-routes.js", import.meta.url), "utf8");
  assert.match(source, /securityRouter\.all\("\/force-change-password"[\s\S]*?res\.status\(410\)/);
  assert.doesNotMatch(source, /adminPatchUserPassword/);
  assert.equal(source.match(/createPasswordRateLimit\("reset-attempt"\)/g).length, 2);
});
