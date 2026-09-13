import assert from "node:assert/strict";
import test from "node:test";
import { FROZEN, SUSPENDED, USER_STATUSES } from "../util/config/enums.js";
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
    actor: { _id: "member_admin", roles: ["admin"] },
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
      actor: { _id: "member_admin", roles: ["admin"] },
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
      body: updateBody({ roles: ["support"] }),
      actor: { _id: "member_1", roles: ["member", "super_admin"] },
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
      body: updateBody({ status: "locked", roles: [] }),
      actor: { _id: "member_admin", roles: ["admin"] },
    }),
    (error) => error.statusCode === 409 && /last active super admin/.test(error.message),
  );
});

test("frozen and suspended are distinct editable statuses without changing existing frozen records", async () => {
  assert.equal(FROZEN, "frozen");
  assert.equal(SUSPENDED, "suspended");
  for (const status of [FROZEN, SUSPENDED]) {
    assert.equal(USER_STATUSES[status], status);
    const memberModel = fakeModel(account({ status: "frozen" }));
    const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });
    const result = await service.update({ type: "member", id: "member_1",
      body: updateBody({ status, roles: [] }), actor: { _id: "member_admin", roles: ["admin"] } });
    assert.equal(result.account.status, status);
    assert.equal(memberModel.state.update.update.$set.status, status);
  }
});

test("Admin and Super admin are never offered as editable roles", async () => {
  const service = createAccountsBackofficeService({ memberModel: fakeModel(), alumniModel: fakeModel() });
  for (const type of ["member", "alumni"]) {
    const result = await service.list({ type });
    assert.ok(!result.options.roles.includes("admin"));
    assert.ok(!result.options.roles.includes("super_admin"));
    assert.ok(result.options.roles.includes("support"));
  }
});

test("direct requests cannot assign privileged roles, even when made by a super admin", async () => {
  for (const type of ["member", "alumni"]) {
    for (const role of ["admin", "super_admin"]) {
      const target = fakeModel(account({ _id: `${type}_1`, roles: [type] }));
      const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
      await assert.rejects(service.update({ type, id: `${type}_1`,
        body: updateBody({ roles: ["support", role] }), actor: { _id: "super_admin_actor", roles: ["super_admin"] } }),
      (error) => error.statusCode === 422 && /roles/.test(error.message));
      assert.equal(target.state.update, null);
    }
  }
});

test("profile and editable-role changes retain every existing privileged role", async () => {
  for (const type of ["member", "alumni"]) {
    for (const protectedRoles of [["admin"], ["super_admin"], ["admin", "super_admin"]]) {
      const target = fakeModel(account({ _id: `${type}_1`, roles: [type, ...protectedRoles, "support"] }));
      const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
      const result = await service.update({ type, id: `${type}_1`, body: updateBody({ name: "Updated", roles: ["vip"] }), actor: { _id: "other", roles: ["admin"] } });
      assert.deepEqual(result.account.roles, [type, ...protectedRoles, "vip"]);
      assert.equal(result.account.name, "Updated");
      assert.equal(target.state.update.update.$inc.sessionVersion, 1);
      assert.deepEqual(target.state.update.filter.roles, [type, ...protectedRoles, "support"]);
    }
  }
});

test("privileged accounts can save their own profile without a role change or session revocation", async () => {
  const target = fakeModel(account({ roles: ["member", "admin", "super_admin", "support"] }));
  const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
  const result = await service.update({ type: "member", id: "member_1", body: updateBody({ name: "Updated", roles: ["support"] }), actor: { _id: "member_1", roles: ["member", "admin", "super_admin", "support"] } });
  assert.deepEqual(result.account.roles, ["member", "admin", "super_admin", "support"]);
  assert.equal(target.state.update.update.$inc.sessionVersion, undefined);
});

test("concurrent external role changes cannot be overwritten by a panel save", async () => {
  const target = fakeModel(account({ roles: ["member", "admin"] }));
  target.findOneAndUpdate = (filter) => {
    assert.deepEqual(filter.roles, ["member", "admin"]);
    return queryResult(null);
  };
  const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
  await assert.rejects(service.update({ type: "member", id: "member_1", body: updateBody({ roles: [] }), actor: { _id: "other", roles: ["admin"] } }),
    (error) => error.statusCode === 409 && /changed by someone else/.test(error.message));
});

test("a board member only lists accounts in their own region", async () => {
  const memberModel = fakeModel(account({ region: "amsterdam" }));
  const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });

  await service.list({ type: "member", city: "rotterdam" }, { roles: ["board_member"], region: "amsterdam" });
  assert.equal(memberModel.state.filter.region, "amsterdam");
});

test("a board member with no region on file lists nothing", async () => {
  const memberModel = fakeModel(account({ region: "amsterdam" }));
  const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });

  const result = await service.list({ type: "member" }, { roles: ["board_member"] });
  assert.equal(memberModel.state.filter._id, null);
  assert.deepEqual(result.options.cities, []);
});

test("an admin can list any region and a board member's options are limited to their own", async () => {
  const memberModel = fakeModel(account({ region: "amsterdam" }));
  const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });

  const admin = await service.list({ type: "member" }, { roles: ["admin"] });
  assert.ok(admin.options.cities.length > 1);

  const board = await service.list({ type: "member" }, { roles: ["board_member"], region: "amsterdam" });
  assert.deepEqual(board.options.cities, ["amsterdam"]);
});

test("a board member cannot edit an account outside their region", async () => {
  const memberModel = fakeModel(account({ region: "rotterdam" }));
  const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });

  await assert.rejects(
    service.update({
      type: "member",
      id: "member_1",
      body: updateBody({ region: "rotterdam" }),
      actor: { _id: "board_actor", roles: ["board_member"], region: "amsterdam" },
    }),
    (error) => error.statusCode === 403 && /own region/.test(error.message),
  );
});

test("a board member cannot move an account into another region", async () => {
  const memberModel = fakeModel(account({ region: "amsterdam" }));
  const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });

  await assert.rejects(
    service.update({
      type: "member",
      id: "member_1",
      body: updateBody({ region: "rotterdam" }),
      actor: { _id: "board_actor", roles: ["board_member"], region: "amsterdam" },
    }),
    (error) => error.statusCode === 403 && /own region/.test(error.message),
  );
});

test("a board member can edit an account within their own region", async () => {
  const memberModel = fakeModel(account({ region: "amsterdam" }));
  const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });

  const result = await service.update({
    type: "member",
    id: "member_1",
    body: updateBody({ region: "amsterdam", roles: [] }),
    actor: { _id: "board_actor", roles: ["board_member"], region: "amsterdam" },
  });
  assert.equal(result.account.region, "amsterdam");
});
