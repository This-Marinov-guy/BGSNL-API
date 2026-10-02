import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx";
import { parseRoleImport, roleImportTemplate } from "../services/backoffice/account-role-import.js";
import { createAccountsBackofficeService } from "../services/backoffice/accounts.js";

const workbookFile = (rows) => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Role changes");
  return { originalname: "roles.xlsx", buffer: XLSX.write(book, { type: "buffer", bookType: "xlsx" }) };
};

const query = (value) => ({ select() { return this; }, lean() { return Promise.resolve(value); } });
const model = (records = []) => {
  const state = { updates: [] };
  return {
    state,
    find({ $or }) {
      return query(records.filter(record => $or.some(({ email }) => email.test(record.email))));
    },
    findById(id) { return query(records.find(record => String(record._id) === id) || null); },
    findOneAndUpdate(filter, change) {
      const record = records.find(item => String(item._id) === String(filter._id) && Number(item.__v ?? 0) === Number(filter.__v ?? 0));
      if (!record) return query(null);
      state.updates.push({ filter, change });
      record.roles = change.$set.roles;
      record.__v = Number(record.__v ?? 0) + 1;
      return query(record);
    },
  };
};

const member = (overrides = {}) => ({ _id: "member-1", __v: 2, email: "person@example.com", name: "Ada", surname: "Lovelace", region: "amsterdam", roles: ["member", "active_member"], ...overrides });
const admin = { _id: "admin-1", roles: ["admin"] };

test("template uses Email and Roles and its instructions describe replacement and none", () => {
  const book = XLSX.read(roleImportTemplate(), { type: "buffer" });
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets["Role changes"], { header: 1 })[0], ["Email", "Roles"]);
  assert.match(JSON.stringify(XLSX.utils.sheet_to_json(book.Sheets.Instructions, { header: 1 })), /none to remove/);
});

test("parser rejects formulas and extra columns", () => {
  assert.deepEqual(parseRoleImport(workbookFile([["Email", "Roles"], ["person@example.com", "support"]])), [
    { row: 2, email: "person@example.com", roles: "support" },
  ]);
  assert.throws(() => parseRoleImport(workbookFile([["Email", "Roles", "Status"], ["person@example.com", "support", "active"]])), /only the Email and Roles/);
  const formula = workbookFile([["Email", "Roles"], ["person@example.com", "support"]]);
  const book = XLSX.read(formula.buffer, { type: "buffer" });
  book.Sheets["Role changes"].B2.f = 'HYPERLINK("https://example.com")';
  formula.buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  assert.throws(() => parseRoleImport(formula), /formulas are not allowed/);
});

test("preview matches by email, detects duplicates and keeps unsupported alumni roles out", async () => {
  const service = createAccountsBackofficeService({ memberModel: model([member()]), alumniModel: model([{ _id: "alumni-1", __v: 0, email: "alumni@example.com", roles: ["alumni"] }]) });
  const result = await service.previewRoleImport({ file: workbookFile([
    ["Email", "Roles"],
    ["PERSON@example.com", "support"],
    ["person@example.com", "none"],
    ["alumni@example.com", "regional_board_member"],
  ]), actor: admin });
  assert.equal(result.changeCount, 1);
  assert.equal(result.errorCount, 2);
  assert.deepEqual(result.rows[0].currentRoles, []);
  assert.deepEqual(result.rows[0].requestedRoles, ["support"]);
  assert.match(result.rows[1].message, /more than once/);
  assert.match(result.rows[2].message, /Unsupported alumni role/);
});

test("apply retains the base role, revokes sessions and rejects a stale revision", async () => {
  const target = member();
  const members = model([target]);
  const service = createAccountsBackofficeService({ memberModel: members, alumniModel: model() });
  const file = workbookFile([["Email", "Roles"], ["person@example.com", "support"]]);
  const preview = await service.previewRoleImport({ file, actor: admin });
  const row = preview.rows[0];
  const input = [{ id: row.id, type: row.type, revision: row.revision, email: row.email, roles: "support" }];
  assert.deepEqual(await service.applyRoleImport({ rows: input, actor: admin }), { updated: 1, unchanged: 0 });
  assert.deepEqual(target.roles, ["member", "active_member", "support"]);
  assert.equal(members.state.updates[0].change.$inc.sessionVersion, 1);
  await assert.rejects(service.applyRoleImport({ rows: input, actor: admin }), /changed since review/);
});

test("a regional board cannot import Support roles", async () => {
  const members = model([member({ region: "rotterdam" })]);
  const service = createAccountsBackofficeService({ memberModel: members, alumniModel: model() });
  const file = workbookFile([["Email", "Roles"], ["person@example.com", "support"]]);
  await assert.rejects(service.previewRoleImport({ file, actor: { _id: "board-1", region: "amsterdam", roles: ["regional_board_member"] } }), { code: 403 });
  await assert.rejects(service.previewRoleImport({ file, actor: { _id: "member-1", region: "rotterdam", roles: ["regional_board_member"] } }), { code: 403 });
  assert.equal(members.state.updates.length, 0);
});

test("only a super admin can update an admin account through import", async () => {
  const target = member({ roles: ["member", "active_member", "admin"] });
  const members = model([target]);
  const service = createAccountsBackofficeService({ memberModel: members, alumniModel: model() });
  const file = workbookFile([["Email", "Roles"], ["person@example.com", "support"]]);
  const denied = await service.previewRoleImport({ file, actor: admin });
  assert.match(denied.rows[0].message, /protected/);
  assert.equal(denied.rows[0].id, undefined);
  const actor = { _id: "super-1", roles: ["super_admin"] };
  const preview = await service.previewRoleImport({ file, actor });
  const row = preview.rows[0];
  await service.applyRoleImport({ rows: [{ id: row.id, type: row.type, revision: row.revision, email: row.email, roles: "support" }], actor });
  assert.deepEqual(target.roles, ["member", "active_member", "admin", "support"]);
});

test("bulk import cannot change any role except Support", async () => {
  const service = createAccountsBackofficeService({ memberModel: model([member()]), alumniModel: model() });
  for (const role of ["vip", "developer", "admin", "regional_board_member"]) {
    const result = await service.previewRoleImport({ file: workbookFile([["Email", "Roles"], ["person@example.com", role]]),
      actor: { _id: "super", roles: ["super_admin"] } });
    assert.equal(result.errorCount, 1);
    assert.match(result.rows[0].message, /Unsupported member role/);
  }
});
