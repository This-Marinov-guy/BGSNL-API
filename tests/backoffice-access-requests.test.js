import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import HttpError from "../models/Http-error.js";
import { createAccessRequestService } from "../services/backoffice/access-requests.js";
import { createBackofficeRouter } from "../routes/backoffice-routes.js";
import { createInternalNotificationService } from "../services/background-services/internal-notifications.js";

const member = { id: "member-123", email: "member@example.test", status: "active", roles: ["member"] };
const fixture = (overrides = {}) => {
  const messages = [], limits = [];
  const notifier = createInternalNotificationService({ config: { enabled: true, subscribers: ["team@example.test", "board@example.test"] }, sendEmail: (message) => messages.push(message) });
  const service = createAccessRequestService({ notify: notifier.notifyAccessRequested,
    limit: async (...args) => limits.push(args), ...overrides });
  return { service, messages, limits };
};

test("access requests notify internal recipients with authenticated identity and named areas", async () => {
  const { service, messages, limits } = fixture();
  assert.deepEqual(await service.request({ account: member, body: { accesses: ["events", "support"] } }), { accepted: true });
  assert.equal(messages.length, 2);
  assert.match(messages[0].text, /Account ID: member-123/);
  assert.match(messages[0].text, /Email: member@example.test/);
  assert.match(messages[0].text, /Requested access: Events, Support tickets/);
  assert.deepEqual(member.roles, ["member"]);
  assert.deepEqual(limits, [["administration-access:member-123", 3, 86400000]]);
});

test("forged identity, privileged roles, unknown areas and malformed selections cannot request access", async () => {
  const { service, messages, limits } = fixture();
  for (const body of [null, {}, { accesses: [] }, { accesses: "events" }, { accesses: ["events", "events"] },
    { accesses: ["admin"] }, { accesses: ["super_admin"] }, { accesses: ["toString"] },
    { accesses: ["events"], email: "someone@example.test" }, { accesses: ["events"], id: "another-user" }]) {
    await assert.rejects(service.request({ account: member, body }), { code: 422 });
  }
  assert.equal(messages.length, 0);
  assert.equal(limits.length, 0);
});

test("inactive accounts and already permitted areas do not send requests", async () => {
  const { service, messages } = fixture();
  for (const status of ["locked", "payment_awaiting", "frozen", "suspended"]) {
    await assert.rejects(service.request({ account: { ...member, status }, body: { accesses: ["events"] } }), { code: 403 });
  }
  await assert.rejects(service.request({ account: { ...member, roles: ["admin"] }, body: { accesses: ["events"] } }), { code: 422 });
  await assert.rejects(service.request({ account: null, body: { accesses: ["events"] } }), { code: 401 });
  assert.equal(messages.length, 0);
});

test("notification failures and rate limits are surfaced instead of reporting success", async () => {
  for (const overrides of [{ notify: () => 0 }, { limit: async () => { throw new HttpError("Unavailable", 503); } }]) {
    await assert.rejects(fixture(overrides).service.request({ account: member, body: { accesses: ["events"] } }), { code: 503 });
  }
  const { service, messages } = fixture({ limit: async () => { throw new HttpError("Limited", 429); } });
  await assert.rejects(service.request({ account: member, body: { accesses: ["events"] } }), { code: 429 });
  assert.equal(messages.length, 0);
});

test("notification HTML escapes identity values and disabled notifications enqueue nothing", async () => {
  const { service, messages } = fixture();
  await service.request({ account: { ...member, email: "<b>member</b>@example.test" }, body: { accesses: ["events"] } });
  assert.doesNotMatch(messages[0].html, /<b>member/);
  assert.match(messages[0].html, /&lt;b&gt;member/);
  const disabled = createInternalNotificationService({ config: { enabled: false, subscribers: ["team@example.test"] }, sendEmail: () => assert.fail("Must not send") });
  await assert.rejects(fixture({ notify: disabled.notifyAccessRequested }).service.request({ account: member, body: { accesses: ["events"] } }), { code: 503 });
});

test("ordinary authenticated members can request access without passing the accounts admin gate", async (t) => {
  const { service, messages } = fixture();
  const app = express(); app.use(express.json());
  app.use(createBackofficeRouter({ requests: service,
    authenticate: (req, _res, next) => { if (!req.headers['x-test-auth']) return next(new HttpError("Login required", 401)); req.account = member; return next(); },
    authorize: (_req, _res, next) => next(new HttpError("Admin only", 403)),
  }));
  // Express identifies error middleware by its four-argument signature.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(error.code || 500).json({ message: error.message }));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (authenticated) => fetch(`${url}/access-requests`, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { "x-test-auth": "1" } : {}) }, body: JSON.stringify({ accesses: ["events"] }) });
  assert.equal((await post(false)).status, 401);
  assert.equal(messages.length, 0);
  assert.equal((await post(true)).status, 202);
  assert.equal(messages.length, 2);
  assert.equal((await fetch(`${url}/accounts`)).status, 403);
});
