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
  expireDate: new Date("2027-01-01T00:00:00.000Z"),
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
  expireDate: "2027-01-01",
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
    aggregate(pipeline) { state.filter = pipeline[0].$match; return Promise.resolve([existing]); },
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

test("an unchanged email is omitted from account updates", async () => {
  const memberModel = fakeModel(account({ roles: ["member"] }));
  const service = createAccountsBackofficeService({
    memberModel,
    alumniModel: fakeModel(account({ _id: "alumni_1", roles: ["alumni"] })),
  });

  await service.update({
    type: "member",
    id: "member_1",
    body: updateBody({ roles: [] }),
    actor: { _id: "admin", roles: ["admin"] },
  });

  assert.equal(Object.hasOwn(memberModel.state.update.update.$set, "email"), false);
});

test("a database duplicate-email conflict reports a useful message", async () => {
  const memberModel = fakeModel(account({ roles: ["member"] }));
  memberModel.findOneAndUpdate = () => ({
    select() { return this; },
    lean() {
      return Promise.reject(Object.assign(new Error("Duplicate key"), {
        code: 11000,
        keyPattern: { email: 1 },
      }));
    },
  });
  const service = createAccountsBackofficeService({
    memberModel,
    alumniModel: fakeModel(account({ _id: "alumni_1", roles: ["alumni"] })),
  });

  await assert.rejects(
    service.update({
      type: "member",
      id: "member_1",
      body: updateBody({ email: "taken@example.com", roles: [] }),
      actor: { _id: "admin", roles: ["admin"] },
    }),
    (error) => error.statusCode === 409 && error.message === "Another account already uses this email",
  );
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
    (error) => error.statusCode === 403 && /roles/.test(error.message),
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
      actor: { _id: "member_admin", roles: ["super_admin"] },
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

test("role choices follow the editor's authority", async () => {
  const service = createAccountsBackofficeService({ memberModel: fakeModel(), alumniModel: fakeModel() });
  for (const type of ["member", "alumni"]) {
    const result = await service.list({ type }, { roles: ["admin"] });
    assert.ok(!result.options.roles.includes("admin"));
    assert.ok(!result.options.roles.includes("super_admin"));
    for (const role of ["support", "vip", "developer"]) assert.ok(result.options.roles.includes(role));
    const superAdmin = await service.list({ type }, { roles: ["super_admin"] });
    for (const role of ["admin", "super_admin"]) assert.ok(superAdmin.options.roles.includes(role));
  }
  assert.deepEqual((await service.list({ type: "member" }, { roles: ["regional_board_member"], region: "amsterdam" })).options.roles,
    ["regional_board_member", "regional_committee_member"]);
  assert.deepEqual((await service.list({ type: "member" }, { roles: ["national_board_member"] })).options.roles,
    ["regional_board_member", "national_committee_member"]);
  assert.deepEqual((await service.list({ type: "member" }, { roles: ["regional_committee_member"] })).options.roles, []);
});

test("direct requests cannot assign roles above the editor's authority", async () => {
  for (const type of ["member", "alumni"]) {
    for (const role of ["admin", "super_admin"]) {
      const target = fakeModel(account({ _id: `${type}_1`, roles: [type] }));
      const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
      await assert.rejects(service.update({ type, id: `${type}_1`,
        body: updateBody({ roles: [role] }), actor: { _id: "admin_actor", roles: ["admin"] } }),
      (error) => error.statusCode === 403 && /roles/.test(error.message));
      assert.equal(target.state.update, null);
    }
  }
  for (const role of ["vip", "support", "developer", "admin"]) {
    const target = fakeModel(account({ roles: ["member"] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
    await assert.rejects(service.update({ type: "member", id: "member_1", body: updateBody({ roles: [role] }),
      actor: { _id: "board", roles: ["regional_board_member"], region: "amsterdam" } }), { code: 403 });
    assert.equal(target.state.update, null);
  }
});

test("regional and national board assignments obey their role and region limits", async () => {
  for (const role of ["regional_board_member", "regional_committee_member"]) {
    const target = fakeModel(account({ roles: ["member"] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
    const result = await service.update({ type: "member", id: "member_1", body: updateBody({ roles: [role] }),
      actor: { _id: "board", roles: ["regional_board_member"], region: "amsterdam" } });
    assert.deepEqual(result.account.roles, ["member", role]);
  }
  for (const role of ["regional_board_member", "national_committee_member"]) {
    const target = fakeModel(account({ region: "rotterdam", roles: ["member"] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
    const result = await service.update({ type: "member", id: "member_1", body: updateBody({ region: "rotterdam", roles: [role] }),
      actor: { _id: "national", roles: ["national_board_member"], region: "amsterdam" } });
    assert.deepEqual(result.account.roles, ["member", role]);
  }
  for (const actorRole of ["regional_committee_member", "national_committee_member"]) {
    const target = fakeModel(account({ roles: ["member", "active_member"] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
    await assert.rejects(service.update({ type: "member", id: "member_1", body: updateBody({ roles: ["regional_board_member"] }),
      actor: { _id: "committee", roles: [actorRole], region: "amsterdam" } }), { code: 403 });
    const saved = await service.update({ type: "member", id: "member_1", body: updateBody({ roles: [] }),
      actor: { _id: "committee", roles: [actorRole], region: "amsterdam" } });
    assert.deepEqual(saved.account.roles, ["member", "active_member"]);
  }
});

test("administrators can assign privileged roles within their tier", async () => {
  for (const [actorRole, assignedRole] of [["admin", "vip"], ["admin", "support"], ["admin", "developer"], ["super_admin", "admin"], ["super_admin", "super_admin"]]) {
    const target = fakeModel(account({ roles: ["member"] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
    const saved = await service.update({ type: "member", id: "member_1", body: updateBody({ roles: [assignedRole] }),
      actor: { _id: "other", roles: [actorRole] } });
    assert.deepEqual(saved.account.roles, ["member", assignedRole]);
  }
});

test("profile edits retain roles outside the editor's assignment scope", async () => {
  for (const type of ["member", "alumni"]) {
    const target = fakeModel(account({ _id: `${type}_1`, roles: [type, "active_member", "national_board_member"] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
    const result = await service.update({ type, id: `${type}_1`, body: updateBody({ name: "Updated", roles: ["national_committee_member"] }),
      actor: { _id: "other", roles: ["national_board_member"] } });
    assert.deepEqual(result.account.roles, [type, "active_member", "national_board_member", "national_committee_member"]);
    assert.equal(result.account.name, "Updated");
    assert.equal(target.state.update.update.$inc.sessionVersion, 1);
  }
});

test("privileged accounts can save their own profile without a role change or session revocation", async () => {
  const target = fakeModel(account({ roles: ["member", "admin", "super_admin", "support"] }));
  const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
  const result = await service.update({ type: "member", id: "member_1", body: updateBody({ name: "Updated", roles: ["admin", "super_admin", "support"] }), actor: { _id: "member_1", roles: ["member", "admin", "super_admin", "support"] } });
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
  await assert.rejects(service.update({ type: "member", id: "member_1", body: updateBody({ roles: [] }), actor: { _id: "other", roles: ["super_admin"] } }),
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
      body: updateBody({ region: "rotterdam", roles: [] }),
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
      body: updateBody({ region: "rotterdam", roles: [] }),
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


test("Alumni options include national roles and administrator-only roles", async () => {
  const service = createAccountsBackofficeService({ memberModel: fakeModel(), alumniModel: fakeModel() });
  const result = await service.list({ type: "alumni" }, { roles: ["admin"] });
  assert.deepEqual(result.options.roles, ["national_board_member", "national_committee_member", "vip", "support", "developer"]);
});

test("Alumni assignments reject regional, active member and legacy role names", async () => {
  for (const role of ["regional_board_member", "regional_committee_member", "active_member", "board_member", "committee_member", "society_board_member"]) {
    const alumniModel = fakeModel(account({ _id: "alumni_1", roles: ["alumni"] }));
    const service = createAccountsBackofficeService({ memberModel: fakeModel(), alumniModel });
    await assert.rejects(service.update({ type: "alumni", id: "alumni_1", body: updateBody({ roles: [role] }),
      actor: { _id: "admin_actor", roles: ["admin"] } }), error => error.statusCode === 403);
    assert.equal(alumniModel.state.update, null);
  }
});

test("Alumni can receive either national role and retain the Alumni base role", async () => {
  for (const role of ["national_board_member", "national_committee_member"]) {
    const alumniModel = fakeModel(account({ _id: "alumni_1", roles: ["alumni"] }));
    const service = createAccountsBackofficeService({ memberModel: fakeModel(), alumniModel });
    const result = await service.update({ type: "alumni", id: "alumni_1", body: updateBody({ roles: [role] }),
      actor: { _id: "admin_actor", roles: ["admin"] } });
    assert.deepEqual(result.account.roles, ["alumni", role]);
    assert.equal(alumniModel.state.update.update.$inc.sessionVersion, 1);
    assert.deepEqual(result.options.roles, ["national_board_member", "national_committee_member", "vip", "support", "developer"]);
  }
});

test("saving a renamed role does not change permissions or revoke a self-editing session", async () => {
  for (const [oldRole, newRole, requested] of [["society_board_member", "national_board_member", []], ["board_member", "regional_board_member", ["regional_board_member"]], ["committee_member", "regional_committee_member", []]]) {
    const memberModel = fakeModel(account({ roles: ["member", oldRole] }));
    const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });
    const result = await service.update({ type: "member", id: "member_1", body: updateBody({ roles: requested }),
      actor: { _id: "member_1", roles: [oldRole], region: "amsterdam" } });
    assert.deepEqual(result.account.roles, ["member", newRole]);
    assert.equal(memberModel.state.update.update.$inc.sessionVersion, undefined);
    assert.deepEqual(memberModel.state.update.filter.roles, ["member", oldRole]);
  }
});

test("regional board scope survives renaming and national board remains unrestricted", async () => {
  const memberModel = fakeModel();
  const service = createAccountsBackofficeService({ memberModel, alumniModel: fakeModel() });
  await service.list({ type: "member", city: "rotterdam" }, { roles: ["regional_board_member"], region: "amsterdam" });
  assert.equal(memberModel.state.filter.region, "amsterdam");
  await service.list({ type: "member", city: "rotterdam" }, { roles: ["national_board_member"], region: "amsterdam" });
  assert.equal(memberModel.state.filter.region, "rotterdam");
});


test("admins can assign VIP and its removal requires membership expiry", async () => {
  for (const type of ["member", "alumni"]) {
    const target = fakeModel(account({ _id: `${type}_1`, roles: [type] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
    const saved = await service.update({ type, id: `${type}_1`, body: updateBody({ roles: ["vip"] }), actor: { _id: "other", roles: ["admin"] } });
    assert.deepEqual(saved.account.roles, [type, "vip"]);
    assert.equal(target.state.update.update.$inc.sessionVersion, 1);
    const vipTarget = fakeModel(account({ _id: `${type}_1`, roles: [type, "vip"], expireDate: null }));
    const vipService = createAccountsBackofficeService({ memberModel: vipTarget, alumniModel: vipTarget });
    await assert.rejects(vipService.update({ type, id: `${type}_1`, body: updateBody({ roles: [], expireDate: "" }),
      actor: { _id: "other", roles: ["admin"] } }), { code: 422 });
    const removed = await vipService.update({ type, id: `${type}_1`, body: updateBody({ roles: [], expireDate: "2027-01-01" }),
      actor: { _id: "other", roles: ["admin"] } });
    assert.deepEqual(removed.account.roles, [type]);
  }
});


test("admins can edit VIP and developer accounts but only super admins can edit admins", async () => {
  for (const type of ["member", "alumni"]) for (const protectedRole of ["admin", "super_admin", "vip", "developer"]) {
    for (const actorRole of ["admin", "national_board_member", "regional_board_member", "board_member"]) {
      const target = fakeModel(account({ _id: `${type}_1`, roles: [type, protectedRole] }));
      const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
      if (actorRole === "admin" && ["vip", "developer"].includes(protectedRole)) {
        await service.update({ type, id: `${type}_1`, body: updateBody({ name: "Allowed", roles: [protectedRole] }),
          actor: { _id: "other", roles: [actorRole], region: "amsterdam" } });
      } else {
        await assert.rejects(service.update({ type, id: `${type}_1`, body: updateBody({ name: "Blocked", roles: [] }),
          actor: { _id: "other", roles: [actorRole], region: "amsterdam" } }), { code: 403 });
        assert.equal(target.state.update, null);
      }
    }
    const target = fakeModel(account({ _id: `${type}_1`, roles: [type, protectedRole] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
    const saved = await service.update({ type, id: `${type}_1`, body: updateBody({ name: "Allowed", roles: [] }),
      actor: { _id: "other_super", roles: ["super_admin"] } });
    assert.equal(saved.account.name, "Allowed");
    assert.deepEqual(saved.account.roles, [type]);
  }
});


test("regional boards cannot list or edit Alumni even in their own region", async () => {
  for (const role of ["regional_board_member", "board_member", "national_committee_member"]) {
    const target = fakeModel(account({ roles: ["alumni"] }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
    const actor = { roles: [role], region: "amsterdam" };
    await assert.rejects(service.list({ type: "alumni" }, actor), { code: 403 });
    await assert.rejects(service.update({ type: "alumni", id: "member_1", body: updateBody({ roles: [] }), actor }), { code: 403 });
    assert.equal(target.state.update, null);
    assert.equal(target.state.filter, null);
  }
});
test("national committee can list and edit ordinary members across regions", async () => {
  const target = fakeModel(account({ region: "amsterdam", roles: ["member"] }));
  const service = createAccountsBackofficeService({ memberModel: target, alumniModel: fakeModel() });
  const actor = { id: "committee", roles: ["national_committee_member"], region: "groningen" };
  await service.list({ type: "member" }, actor);
  assert.equal(target.state.filter.region, undefined);
  const saved = await service.update({ type: "member", id: "member_1", body: updateBody({ name: "Updated", roles: [] }), actor });
  assert.equal(saved.account.name, "Updated");
});


test("status filter combines with region and search and rejects invalid statuses", () => {
  for (const status of Object.values(USER_STATUSES)) {
    const filter = buildAccountListFilter({ type: "member", city: "amsterdam", search: "Ada", status });
    assert.equal(filter.status, status);
    assert.equal(filter.region, "amsterdam");
    assert.ok(filter.$or.length);
  }
  const filter = buildAccountListFilter({ type: "alumni", city: "unassigned", search: "Ada", status: "frozen" });
  assert.equal(filter.status, "frozen");
  assert.equal(filter.$and.length, 2);
  assert.equal(buildAccountListFilter({ type: "member", status: "" }).status, undefined);
  assert.equal(buildAccountListFilter({ type: "member" }).status, undefined);
  for (const status of ["unknown", { $ne: "active" }, ["active"], null]) {
    assert.throws(() => buildAccountListFilter({ type: "member", status }), { code: 422 });
  }
});
test("listing and pagination count use the same status filter without losing regional scope", async () => {
  for (const type of ["member", "alumni"]) {
    const model = fakeModel();
    let countFilter;
    model.countDocuments = async filter => { countFilter = filter; return 1; };
    const service = createAccountsBackofficeService({ memberModel: model, alumniModel: model });
    const actor = type === "member" ? { roles: ["regional_board_member"], region: "amsterdam" } : { roles: ["admin"] };
    await service.list({ type, status: "locked", city: "groningen" }, actor);
    assert.equal(model.state.filter.status, "locked");
    assert.equal(model.state.filter.region, type === "member" ? "amsterdam" : "groningen");
    assert.deepEqual(countFilter, model.state.filter);
  }
});


test("account summaries expose the requested subscription identifiers and period", async () => {
  for (const type of ["member", "alumni"]) {
    const target = fakeModel(account({ roles: [type], subscription: {
      id: "sub_example", customerId: "cus_example", period: type === "member" ? 12 : 1,
      failureEpisode: "internal-only", priceId: "price_internal",
    } }));
    const service = createAccountsBackofficeService({ memberModel: target, alumniModel: target });
    const result = await service.list({ type }, { roles: ["admin"] });
    assert.deepEqual(result.accounts[0].subscription, { id: "sub_example", customerId: "cus_example", period: type === "member" ? 12 : 1 });
    const saved = await service.update({ type, id: "member_1", body: updateBody({ roles: [] }), actor: { id: "other", roles: ["admin"] } });
    assert.deepEqual(saved.account.subscription, result.accounts[0].subscription);
  }
  const service = createAccountsBackofficeService({ memberModel: fakeModel(), alumniModel: fakeModel() });
  const result = await service.list({ type: "member" }, { roles: ["admin"] });
  assert.deepEqual(result.accounts[0].subscription, { id: null, customerId: null, period: null });
});


test("locked-last order is applied before pagination and only public fields are projected", async () => {
  for (const type of ["member", "alumni"]) {
    const model = fakeModel();
    let stages;
    model.aggregate = async pipeline => { stages = pipeline; return []; };
    const service = createAccountsBackofficeService({ memberModel: model, alumniModel: model });
    await service.list({ type, page: 2, pageSize: 10, status: "locked" }, { roles: ["admin"] });
    assert.equal(stages[0].$match.status, "locked");
    const rank = stages.find(stage => stage.$addFields)?.$addFields.lockedOrder;
    assert.deepEqual(rank, { $cond: [{ $eq: ["$status", "locked"] }, 1, 0] });
    const sortIndex = stages.findIndex(stage => stage.$sort);
    const skipIndex = stages.findIndex(stage => Object.hasOwn(stage, "$skip"));
    assert.ok(sortIndex > 0 && sortIndex < skipIndex);
    assert.deepEqual(stages[sortIndex].$sort, { lockedOrder: 1, surname: 1, name: 1, email: 1, _id: 1 });
    assert.equal(stages[skipIndex].$skip, 10);
    const projection = stages.find(stage => stage.$project).$project;
    assert.equal(projection["subscription.customerId"], 1);
    assert.equal(projection.password, undefined);
    assert.equal(projection.lockedOrder, undefined);
  }
});
