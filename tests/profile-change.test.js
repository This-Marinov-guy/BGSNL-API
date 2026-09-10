import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { requestProfileChange, confirmProfileChange, PROFILE_CHANGE_TTL } from "../services/authentication/profile-change.js";
import { createConfirmProfile } from "../controllers/profile-change-controller.js";
import ProfileChange from "../models/ProfileChange.js";
import { signSessionToken, verifySessionToken } from "../util/auth/session-token.js";
import { requestClientAddress } from "../util/auth/request-client.js";

process.env.JWT_STRING = "isolated-profile-tests-no-real-secret-or-accounts";
process.env.AUTH_VERSION = "1";
const invalid = (error) => error.statusCode === 409;
const clone = (value) => structuredClone(value);
function matches(row, query) {
  return !!row && Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((entry) => matches(row, entry));
    if (value && typeof value === "object" && !(value instanceof Date)) return Object.entries(value).every(([op, operand]) => {
      if (op === "$gt") return row[key] > operand;
      if (op === "$exists") return (row[key] !== undefined) === operand;
      if (op === "$nin") return !operand.includes(row[key]);
      throw new Error(`Unexpected operator ${op}`);
    });
    return row[key] === value;
  });
}
function harness() {
  let clock = Date.now(), row = null, tail = Promise.resolve(), deleted = [];
  let live = { _id: "member_fixture", id: "member_fixture", email: "owner@example.test", password: "old-hash", sessionVersion: 0,
    roles: ["member"], identityRevision: 0, status: "locked" };
  const emails = [];
  const update = (target, changes) => {
    Object.assign(target, changes.$set);
    for (const key of Object.keys(changes.$unset || {})) delete target[key];
    for (const [key, amount] of Object.entries(changes.$inc || {})) target[key] = (target[key] ?? 0) + amount;
    return clone(target);
  };
  const Model = { findOneAndUpdate: async (query, changes, options) => {
    assert.ok(options.session);
    const result = matches(live, query) ? update(live, changes) : null;
    return result && { ...result, constructor: Model };
  } };
  const user = () => ({ ...clone(live), constructor: Model });
  const records = {
    findOne: async (query) => matches(row, query) ? clone(row) : null,
    findOneAndUpdate: async (query, changes, options) => {
      assert.ok(options.session);
      for (const key of Object.keys(changes.$set || {})) assert.ok(!Object.hasOwn(changes.$unset || {}, key), `Conflicting Mongo update: ${key}`);
      if (options.upsert && !row) row = { _id: query._id };
      return matches(row, query) ? update(row, changes) : null;
    },
    findOneAndDelete: async (query, options) => {
      assert.ok(options.session);
      if (!matches(row, query)) return null;
      const result = row; row = null; return result;
    },
    deleteOne: async (query) => { if (matches(row, query)) row = null; },
  };
  const dependencies = { records, now: () => clock, hashPassword: async () => "new-bcrypt-hash", findAccount: async () => user(),
    deliver: async (message) => { emails.push(message); }, checkEmail: async () => {},
    identities: { deleteMany: async (query, options) => { assert.ok(options.session); deleted.push(query); } },
    startSession: async () => ({ endSession: async () => {}, withTransaction: (run) => {
      const result = tail.then(async () => {
        const before = { row: clone(row), live: clone(live), deleted: clone(deleted) };
        try { await run(); } catch (error) { row = before.row; live = before.live; deleted = before.deleted; throw error; }
      });
      tail = result.catch(() => {}); return result;
    } }),
  };
  const input = (extra = {}) => ({ password: "New-password123", origin: "https://www.bulgariansociety.nl",
    claims: { userId: live.id, sessionVersion: live.sessionVersion, auth_time: Math.floor(clock / 1000) }, ...extra });
  const token = (index = emails.length - 1) => emails[index].text.match(/#token=([A-Za-z0-9_-]{43})/)[1];
  return { user, input, dependencies, emails, token, row: () => row, live: () => live, deleted: () => deleted, advance: (amount) => { clock += amount; } };
}

test("profile changes await email approval and store only token and password hashes", async () => {
  const h = harness();
  const result = await requestProfileChange(h.user(), h.input(), h.dependencies);
  assert.equal(result.confirmationRequired, true);
  assert.equal(h.live().password, "old-hash"); assert.equal(h.live().sessionVersion, 0);
  assert.equal(h.row().passwordHash, "new-bcrypt-hash"); assert.equal(h.row().approvalHash.length, 64);
  assert.ok(!JSON.stringify(h.row()).includes(h.token())); assert.ok(!JSON.stringify(h.row()).includes("New-password123"));
  assert.equal(h.emails[0].to[0].email, h.user().email);
  assert.match(h.emails[0].text, /account\/confirm#token=/);
});
test("password confirmation is single-use, revokes sessions and preserves restrictions and Google", async () => {
  const h = harness(); await requestProfileChange(h.user(), h.input(), h.dependencies);
  const token = h.token(), result = await confirmProfileChange(token, h.dependencies);
  assert.equal(result.state, "complete"); assert.equal(h.live().password, "new-bcrypt-hash");
  assert.equal(h.live().sessionVersion, 1); assert.equal(h.live().status, "locked");
  assert.equal(h.row(), null); assert.deepEqual(h.deleted(), []);
  await assert.rejects(confirmProfileChange(token, h.dependencies), invalid);
});
test("email changes require the old address then the new address before applying anything", async () => {
  const h = harness(); await requestProfileChange(h.user(), h.input({ email: "NEW@example.test" }), h.dependencies);
  assert.equal(h.emails.length, 1); assert.equal(h.emails[0].to[0].email, "owner@example.test");
  const oldToken = h.token(); assert.equal((await confirmProfileChange(oldToken, h.dependencies)).state, "awaiting_new_email");
  assert.equal(h.emails[1].to[0].email, "new@example.test"); assert.equal(h.row().approvalHash, undefined);
  assert.equal(h.live().email, "owner@example.test"); assert.equal(h.live().password, "old-hash");
  await assert.rejects(confirmProfileChange(oldToken, h.dependencies), invalid);
  assert.equal((await confirmProfileChange(h.token(), h.dependencies)).state, "complete");
  assert.equal(h.live().email, "new@example.test"); assert.equal(h.live().password, "new-bcrypt-hash");
  assert.equal(h.live().sessionVersion, 1);
  assert.deepEqual(h.deleted(), [{ accountId: "member_fixture", provider: "google" }]);
  assert.equal(h.emails.length, 4); // Final notifications to both addresses.
});
test("email-only changes preserve passwords; unchanged email creates no challenge", async () => {
  const h = harness();
  assert.equal(await requestProfileChange(h.user(), h.input({ password: undefined, email: "OWNER@example.test" }), h.dependencies), null);
  assert.equal(h.emails.length, 0);
  await requestProfileChange(h.user(), h.input({ password: undefined, email: "new@example.test" }), h.dependencies);
  await confirmProfileChange(h.token(), h.dependencies); await confirmProfileChange(h.token(), h.dependencies);
  assert.equal(h.live().password, "old-hash"); assert.equal(h.live().email, "new@example.test");
});
test("resending replaces the old pending change, including stale email/password fields", async () => {
  const h = harness(); await requestProfileChange(h.user(), h.input({ email: "new@example.test" }), h.dependencies);
  const first = h.token();
  await requestProfileChange(h.user(), h.input(), h.dependencies);
  assert.equal(h.row().newEmail, undefined); assert.equal(h.row().newEmailHash, undefined);
  await assert.rejects(confirmProfileChange(first, h.dependencies), invalid);
  const second = h.token();
  await requestProfileChange(h.user(), h.input({ email: "new@example.test", password: undefined }), h.dependencies);
  assert.equal(h.row().passwordHash, undefined);
  await assert.rejects(confirmProfileChange(second, h.dependencies), invalid);
});
test("both stages enforce expiry without depending on Mongo TTL cleanup", async () => {
  for (const email of [undefined, "new@example.test"]) {
    const h = harness(); await requestProfileChange(h.user(), h.input({ email }), h.dependencies);
    if (email) await confirmProfileChange(h.token(), h.dependencies);
    h.advance(PROFILE_CHANGE_TTL);
    await assert.rejects(confirmProfileChange(h.token(), h.dependencies), invalid);
    assert.equal(h.live().sessionVersion, 0);
  }
  assert.ok(ProfileChange.schema.indexes().some(([keys, opts]) => keys.expiresAt === 1 && opts.expireAfterSeconds === 0));
});
test("racing confirmations can apply a change only once", async () => {
  const h = harness(); await requestProfileChange(h.user(), h.input(), h.dependencies);
  const results = await Promise.allSettled([1, 2].map(() => confirmProfileChange(h.token(0), h.dependencies)));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(h.live().sessionVersion, 1);
});
test("account changes invalidate links, including changes racing the final transaction", async () => {
  for (const change of [{ password: "reset-hash" }, { email: "other@example.test" }, { sessionVersion: 2 }, { status: "alumni-migrated" }]) {
    const h = harness(); await requestProfileChange(h.user(), h.input(), h.dependencies);
    await assert.rejects(confirmProfileChange(h.token(), { ...h.dependencies,
      startSession: async () => { Object.assign(h.live(), change); return h.dependencies.startSession(); },
    }), invalid);
    assert.ok(h.row()); assert.notEqual(h.live().password, "new-bcrypt-hash");
  }
});
test("an account migration cannot transfer the confirmation to a different account ID", async () => {
  const h = harness(); await requestProfileChange(h.user(), h.input(), h.dependencies);
  await assert.rejects(confirmProfileChange(h.token(), { ...h.dependencies, findAccount: async () => ({ ...h.user(), id: "alumni_fixture" }) }), invalid);
});
test("old links cannot consume a newly requested change", async () => {
  const h = harness(); await requestProfileChange(h.user(), h.input(), h.dependencies);
  const first = h.token();
  await assert.rejects(confirmProfileChange(first, { ...h.dependencies, startSession: async () => {
    await requestProfileChange(h.user(), h.input(), h.dependencies); return h.dependencies.startSession();
  } }), invalid);
  assert.equal(h.live().sessionVersion, 0); assert.ok(h.row());
});
test("mail failure at either approval stage cancels the pending request without changing credentials", async () => {
  const fail = async () => { throw new Error("mail unavailable"); };
  const h = harness();
  await assert.rejects(requestProfileChange(h.user(), h.input(), { ...h.dependencies, deliver: fail }), (e) => e.statusCode === 503);
  assert.equal(h.row(), null); assert.equal(h.live().password, "old-hash");
  await requestProfileChange(h.user(), h.input({ email: "new@example.test" }), h.dependencies);
  await assert.rejects(confirmProfileChange(h.token(), { ...h.dependencies, deliver: fail }), (e) => e.statusCode === 503);
  assert.equal(h.row(), null); assert.equal(h.live().email, "owner@example.test");
});
test("a failure deleting an old Google identity rolls back credential changes and token consumption", async () => {
  const h = harness(); await requestProfileChange(h.user(), h.input({ email: "new@example.test" }), h.dependencies);
  await confirmProfileChange(h.token(), h.dependencies);
  await assert.rejects(confirmProfileChange(h.token(), { ...h.dependencies, identities: { deleteMany: async () => { throw new Error("DB error"); } } }), /DB error/);
  assert.ok(h.row()); assert.equal(h.live().email, "owner@example.test"); assert.equal(h.live().sessionVersion, 0);
});
test("duplicate email is checked at request and confirmation, not trusted from the client", async () => {
  const h = harness(), duplicate = async () => { throw Object.assign(new Error("In use"), { statusCode: 409 }); };
  await assert.rejects(requestProfileChange(h.user(), h.input({ email: "taken@example.test" }), { ...h.dependencies, checkEmail: duplicate }), invalid);
  assert.equal(h.row(), null); assert.equal(h.emails.length, 0);
  await requestProfileChange(h.user(), h.input({ email: "taken@example.test" }), h.dependencies);
  await assert.rejects(confirmProfileChange(h.token(), { ...h.dependencies, checkEmail: duplicate }), invalid);
  assert.equal(h.live().email, "owner@example.test");
});
test("invalid passwords, origins and account claims cannot issue approval emails", async () => {
  const h = harness();
  for (const extra of [{ password: "weak" }, { password: "Ab1" + "é".repeat(40) }, { email: "invalid" },
    { origin: "https://evil.test" }, { claims: { userId: "other", sessionVersion: 0 } }, { claims: { userId: h.user().id, sessionVersion: 1 } }]) {
    await assert.rejects(requestProfileChange(h.user(), h.input(extra), h.dependencies));
  }
  assert.equal(h.emails.length, 0); assert.equal(h.row(), null);
});
test("confirmation preserves only the initiating browser's original absolute deadline", async () => {
  const h = harness(), issued = signSessionToken(h.user()), original = verifySessionToken(issued);
  const updated = { ...h.user(), sessionVersion: 1, password: "new-hash" };
  const handler = createConfirmProfile({ sign: signSessionToken, confirm: async () => ({ state: "complete", user: updated, authTime: original.auth_time, previousVersion: 0, message: "Done" }) });
  for (const authorization of [`Bearer ${issued}`, undefined, `Bearer ${signSessionToken({ ...h.user(), id: "other" })}`]) {
    let response;
    await handler({ headers: { authorization }, body: { confirmationToken: "fixture" } }, { json: (body) => { response = body; } }, (error) => { throw error; });
    assert.equal(response.user, undefined);
    if (authorization === `Bearer ${issued}`) {
      const claims = verifySessionToken(response.token);
      assert.equal(claims.exp, original.exp); assert.equal(claims.auth_time, original.auth_time); assert.equal(claims.sessionVersion, 1);
    } else assert.equal(response.token, undefined);
  }
});
test("browser IP forwarding requires the real server key and rejects spoofed input", () => {
  process.env.SSR_SERVER_KEY = "isolated-website-proxy-key";
  const headers = { "x-bgsnl-server-key": process.env.SSR_SERVER_KEY, "x-bgsnl-browser-proxy": "1", "x-bgsnl-client-ip": "192.0.2.9" };
  assert.equal(requestClientAddress({ headers, ip: "127.0.0.1" }), "192.0.2.9");
  for (const change of [{ "x-bgsnl-server-key": "forged" }, { "x-bgsnl-browser-proxy": undefined }, { "x-bgsnl-client-ip": "192.0.2.1, 192.0.2.9" }]) {
    assert.equal(requestClientAddress({ headers: { ...headers, ...change }, ip: "127.0.0.1" }), "127.0.0.1");
  }
});
test("profile endpoint cannot directly overwrite credentials and confirmation has no GET mutation", async () => {
  const controllers = await readFile(new URL("../controllers/users-controllers.js", import.meta.url), "utf8");
  const patch = controllers.slice(controllers.indexOf("export const patchUserInfo"), controllers.indexOf("export const submitCalendarVerification"));
  assert.doesNotMatch(patch, /user\.(password|email)\s*=/); assert.match(patch, /await requestProfileChange/);
  const routes = await readFile(new URL("../routes/security-routes.js", import.meta.url), "utf8");
  assert.match(routes, /post\("\/profile-change\/confirm", createPasswordRateLimit\("profile-confirm"\)/);
  assert.doesNotMatch(routes, /get\("\/profile-change\/confirm/);
});
