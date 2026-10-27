import assert from "node:assert/strict";
import test from "node:test";
import { signSessionToken } from "../util/auth/session-token.js";
import { authorizedRegion, canAccessRegion, createAuthMiddleware, regionFilter } from "../middleware/authorization.js";
import { getMembers, getEventsAnalytics } from "../controllers/dashboard-controllers.js";
import MemberUser from "../models/MemberUser.js";
import Event from "../models/Event.js";
import EventDraft from "../models/EventDraft.js";
import { createBackofficeRouter } from "../routes/backoffice-routes.js";
import { deleteEvent, editEvent, fetchFullDataEvent, fetchFullDataEventsList,
  getEventDraftCount, saveEventDraft } from "../controllers/Events/future-events-action-controller.js";

process.env.JWT_STRING = "regional-authorization-tests-only-secret";

const board = { id: "board_1", roles: ["member", "regional_board_member"],
  region: "groningen", status: "active", sessionVersion: 0 };

async function authenticate(account = board, tokenAccount = board) {
  const req = { headers: { authorization: `Bearer ${signSessionToken(tokenAccount)}` },
    query: {}, body: {} };
  const headers = new Map();
  let error;
  await createAuthMiddleware({ findAccount: async () => account, validateSession: async () => {} })(
    req, { set: (key, value) => headers.set(key, value) }, (value) => { error = value; });
  return { req, error, headers };
}

test("signed region constrains both member and event filters regardless of request values", async () => {
  const { req, error } = await authenticate();
  assert.equal(error, undefined);
  assert.equal(req.user.region, "groningen");
  assert.equal(authorizedRegion(req, "member"), "groningen");
  assert.equal(authorizedRegion(req, "event"), "groningen");
  assert.deepEqual(regionFilter(req, "member"), { region: "groningen" });
  assert.deepEqual(regionFilter(req, "event", "groningen"), { region: "groningen" });
  req.user.region = "rotterdam";
  req.user.roles.push("admin");
  assert.deepEqual(regionFilter(req, "event"), { region: "groningen" });
  for (const kind of ["member", "event"]) {
    assert.throws(() => regionFilter(req, kind, "rotterdam"), { statusCode: 403 });
    assert.equal(canAccessRegion(req, kind, "rotterdam"), false);
    assert.equal(canAccessRegion(req, kind, "groningen"), true);
  }
});

test("a changed account region invalidates the old token before a handler runs", async () => {
  const { req, error, headers } = await authenticate({ ...board, region: "rotterdam" });
  assert.equal(error?.statusCode, 401);
  assert.equal(headers.get("X-BGSNL-Session-Invalid"), "1");
  assert.equal(headers.get("X-BGSNL-Region-Changed"), "1");
  assert.equal(req.user, undefined);
});

test("regional access fails closed when the signed region is missing", async () => {
  const missing = { ...board, region: undefined };
  const { req, error } = await authenticate(missing, missing);
  assert.equal(error, undefined);
  assert.throws(() => regionFilter(req, "member"), { statusCode: 403 });
  assert.throws(() => regionFilter(req, "event"), { statusCode: 403 });
  assert.equal(canAccessRegion(req, "event", "groningen"), false);
});

test("authenticated requests fail closed if their middleware scope is absent", async () => {
  const { req } = await authenticate();
  delete req.regionScope;
  assert.throws(() => regionFilter(req, "member"), { statusCode: 403 });
  assert.equal(canAccessRegion(req, "event", "groningen"), false);
});

test("a newly granted national role needs a new token for all-region access", async () => {
  const { req, error } = await authenticate({ ...board, roles: [...board.roles, "national_board_member"] });
  assert.equal(error, undefined);
  assert.deepEqual(req.user.roles, board.roles);
  assert.equal(authorizedRegion(req, "event"), "groningen");
  assert.equal(canAccessRegion(req, "event", "rotterdam"), false);
  const renewed = await authenticate({ ...board, roles: [...board.roles, "national_board_member"] },
    { ...board, roles: [...board.roles, "national_board_member"] });
  assert.equal(authorizedRegion(renewed.req, "event"), null);
});

test("dashboard lists use the token scope and reject another region", async (t) => {
  const { req } = await authenticate();
  const memberQueries = [], eventQueries = [];
  t.mock.method(MemberUser, "find", (query) => { memberQueries.push(query); return {
    select() { return this; }, lean: async () => [],
  }; });
  t.mock.method(Event, "find", (query) => { eventQueries.push(query); return {
    select() { return this; }, sort() { return this; }, lean: async () => [],
  }; });
  const res = { status() { return this; }, json() {} };
  let error;
  await getMembers(req, res, (value) => { error = value; });
  await getEventsAnalytics(req, res, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.equal(memberQueries[0].region, "groningen");
  assert.equal(eventQueries[0].region, "groningen");

  req.query.region = "rotterdam";
  await getMembers(req, res, (value) => { error = value; });
  assert.equal(error?.statusCode, 403);
  await getEventsAnalytics(req, res, (value) => { error = value; });
  assert.equal(error?.statusCode, 403);
  assert.equal(memberQueries.length, 1);
  assert.equal(eventQueries.length, 1);
});

test("event management rejects foreign list, draft and resource requests before mutation", async (t) => {
  const { req } = await authenticate();
  req.query = { region: "rotterdam" };
  req.params = { eventId: "507f1f77bcf86cd799439011" };
  req.body = { region: "rotterdam", status: "draft" };
  const res = { status() { return this; }, json() { assert.fail("Foreign data must not be returned"); } };
  const errors = [];
  const next = (error) => errors.push(error);
  await fetchFullDataEventsList(req, res, next);
  await getEventDraftCount(req, res, next);
  await saveEventDraft(req, res, next);
  assert.deepEqual(errors.map(error => error.statusCode), [403, 403, 403]);

  t.mock.method(Event, "findById", async () => ({ region: "rotterdam" }));
  t.mock.method(Event, "exists", async () => ({ _id: req.params.eventId }));
  t.mock.method(EventDraft, "findById", async () => null);
  req.body.status = "opened";
  await editEvent(req, res, next);
  await deleteEvent(req, res, next);
  assert.deepEqual(errors.map(error => error.statusCode), [403, 403, 403, 403, 403]);
});

test("draft ownership does not override the signed region", async (t) => {
  const { req } = await authenticate();
  req.params = { eventId: "507f1f77bcf86cd799439011" };
  t.mock.method(Event, "findOne", async () => null);
  t.mock.method(Event, "exists", async () => ({ _id: req.params.eventId }));
  t.mock.method(EventDraft, "findById", async () => ({ region: "rotterdam",
    draftOwner: { userId: board.id } }));
  let error;
  await fetchFullDataEvent(req, { status() { return this; }, json() { assert.fail("Draft must stay private"); } },
    (value) => { error = value; });
  assert.equal(error?.statusCode, 403);
});

test("back-office account services receive the token region", async () => {
  let actor;
  const router = createBackofficeRouter({ service: { list: async (_query, value) => {
    actor = value;
    return { accounts: [] };
  } } });
  const route = router.stack.find((layer) => layer.route?.path === "/accounts" && layer.route.methods.get);
  const handler = route.route.stack[0].handle;
  let result, error;
  await handler({ query: { city: "rotterdam" }, account: { ...board, region: "rotterdam" },
    authClaims: { region: "groningen" }, user: { roles: board.roles } },
  { status() { return this; }, json(value) { result = value; } }, (value) => { error = value; });
  assert.equal(error, undefined);
  assert.deepEqual(result, { accounts: [] });
  assert.equal(actor.region, "groningen");
});
