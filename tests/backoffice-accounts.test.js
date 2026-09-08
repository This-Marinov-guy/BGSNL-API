import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAccountListFilter,
  buildAccountSearchPattern,
  createAccountsBackofficeService,
} from "../services/backoffice/accounts.js";

const queryResult = (value) => ({
  select() { return this; },
  sort() { return this; },
  skip() { return this; },
  limit() { return this; },
  lean() { return Promise.resolve(value); },
});

const account = (overrides = {}) => ({
  _id: "member_1",
  __v: 0,
  name: "Test",
  surname: "Member",
  email: "test@example.com",
  phone: "+31 6 1234 5678",
  birth: new Date("2000-01-01T00:00:00.000Z"),
  region: "amsterdam",
  status: "active",
  roles: [],
  university: "University of Amsterdam",
  ...overrides,
});

const updateBody = (overrides = {}) => ({
  revision: 0,
  name: "Test",
  surname: "Member",
  email: "test@example.com",
  phone: "+31 6 1234 5678",
  birth: "2000-01-01",
  region: "amsterdam",
  university: "University of Amsterdam",
  otherUniversityName: "",
  graduationDate: "2025",
  course: "Law",
  studentNumber: "12345",
  profession: "",
  status: "active",
  roles: ["member"],
  ...overrides,
});

const fakeModel = (existing = account(), { superAdminCount = 1 } = {}) => {
  const state = { update: null, filter: null };
  return {
    state,
    find(filter) { state.filter = filter; return queryResult([existing]); },
    countDocuments(filter) {
      if (filter?.roles === "super_admin") return Promise.resolve(superAdminCount);
      return Promise.resolve(1);
    },
    findById() { return queryResult(existing); },
    exists() { return Promise.resolve(false); },
    findOneAndUpdate(filter, update) {
      state.update = { filter, update };
      return queryResult({ ...existing, ...update.$set, __v: Number(existing.__v || 0) + 1 });
    },
  };
};

test("account search ignores case, spaces and common phone separators", () => {
  const namePattern = buildAccountSearchPattern(" Te ST ");
  assert.match("test", new RegExp(namePattern, "i"));
  assert.match("Te sT", new RegExp(namePattern, "i"));

  const phonePattern = buildAccountSearchPattern("3161234");
  assert.match("31 (6) 12-34", new RegExp(phonePattern, "i"));
});

test("account list combines city and partial search on the server", () => {
  const filter = buildAccountListFilter({ city: "amsterdam", search: "Ada Lov", type: "member" });
  assert.equal(filter.region, "amsterdam");
  assert.equal(filter.$or.length, 6);
  assert.equal(filter.$or[0].email.$options, "i");
  assert.match("AdaLovelace", new RegExp(filter.$or[0].email.$regex, "i"));
});

test("member role is retained when roles are updated and security sessions are revoked", async () => {
  const memberModel = fakeModel();
  const alumniModel = fakeModel(account({ _id: "alumni_1", roles: ["alumni"] }));
  const service = createAccountsBackofficeService({ memberModel, alumniModel });

  const result = await service.update({
    type: "member",
    id: "member_1",
    body: updateBody({ roles: ["support"] }),
    actor: { _id: "member_admin" },
  });

  assert.deepEqual(result.account.roles, ["member", "support"]);
  assert.equal(memberModel.state.update.update.$inc.sessionVersion, 1);
  assert.equal(memberModel.state.update.update.$inc.__v, 1);
});

test("member and alumni roles cannot be assigned without account migration", async () => {
  const service = createAccountsBackofficeService({
    memberModel: fakeModel(),
    alumniModel: fakeModel(account({ _id: "alumni_1", roles: ["alumni"] })),
  });

  await assert.rejects(
    service.update({
      type: "member",
      id: "member_1",
      body: updateBody({ roles: ["alumni"] }),
      actor: { _id: "member_admin" },
    }),
    (error) => error.statusCode === 422 && /roles/.test(error.message),
  );
});

test("a super admin cannot change their own roles or status", async () => {
  const existing = account({ roles: ["member", "super_admin"] });
  const service = createAccountsBackofficeService({
    memberModel: fakeModel(existing),
    alumniModel: fakeModel(account({ _id: "alumni_1", roles: ["alumni"] }), { superAdminCount: 0 }),
  });

  await assert.rejects(
    service.update({
      type: "member",
      id: "member_1",
      body: updateBody({ roles: [] }),
      actor: { _id: "member_1" },
    }),
    (error) => error.statusCode === 409 && /own roles/.test(error.message),
  );
});

test("the last active super admin cannot be deactivated", async () => {
  const existing = account({ roles: ["member", "super_admin"] });
  const service = createAccountsBackofficeService({
    memberModel: fakeModel(existing),
    alumniModel: fakeModel(account({ _id: "alumni_1", roles: ["alumni"] }), { superAdminCount: 0 }),
  });

  await assert.rejects(
    service.update({
      type: "member",
      id: "member_1",
      body: updateBody({ status: "locked", roles: ["super_admin"] }),
      actor: { _id: "member_admin" },
    }),
    (error) => error.statusCode === 409 && /last active super admin/.test(error.message),
  );
});
