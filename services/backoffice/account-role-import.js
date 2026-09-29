import XLSX from "xlsx";
import HttpError from "../../models/Http-error.js";
import { MEMBER_ACCOUNT_ROLES, NATIONAL_ACCOUNT_ROLES } from "../../util/config/account-roles.js";

export const MAX_IMPORT_ROWS = 200;
export const MAX_IMPORT_BYTES = 1024 * 1024;

export const roleImportTemplate = () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["Email", "Roles"]]);
  sheet["!cols"] = [{ wch: 36 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(workbook, sheet, "Role changes");
  const instructions = XLSX.utils.aoa_to_sheet([
    ["Bulk account role changes"],
    ["Enter one account per row on the Role changes sheet. Email matches a member or alumni account."],
    ["List the complete set of editable roles, separated by commas. These roles replace the account's current editable roles."],
    ["Use none to remove all editable roles. Do not leave Roles blank."],
    ["Base account roles and protected roles are always retained."],
    ["Member roles", MEMBER_ACCOUNT_ROLES.join(", ")],
    ["Alumni roles", NATIONAL_ACCOUNT_ROLES.join(", ")],
    ["At most 200 accounts can be imported at once."],
  ]);
  instructions["!cols"] = [{ wch: 96 }, { wch: 100 }];
  XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
};

export const parseRoleImport = (file) => {
  if (!file?.buffer?.length) throw new HttpError("Choose an Excel .xlsx file", 422);
  if (file.buffer.length > MAX_IMPORT_BYTES || !/\.xlsx$/i.test(file.originalname || "")) {
    throw new HttpError("Choose an .xlsx file smaller than 1 MB", 422);
  }
  let workbook;
  try { workbook = XLSX.read(file.buffer, { type: "buffer", cellFormula: true }); }
  catch { throw new HttpError("The Excel file could not be read", 422); }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet?.["!ref"]) throw new HttpError("The first sheet must contain Email and Roles columns", 422);
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.c > 1 || range.s.c !== 0 || range.s.r !== 0) throw new HttpError("Use only the Email and Roles columns in the first sheet", 422);
  if (range.e.r > MAX_IMPORT_ROWS) throw new HttpError(`Import at most ${MAX_IMPORT_ROWS} accounts at once`, 422);
  for (const [address, cell] of Object.entries(sheet)) {
    if (!address.startsWith("!") && cell?.f) throw new HttpError("Excel formulas are not allowed in the import sheet", 422);
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: true });
  if (String(rows[0]?.[0] || "").trim().toLowerCase() !== "email" || String(rows[0]?.[1] || "").trim().toLowerCase() !== "roles") {
    throw new HttpError("The first row must contain Email and Roles headings", 422);
  }
  const records = rows.slice(1).map((values, index) => ({
    row: index + 2,
    email: String(values?.[0] ?? "").trim().toLowerCase(),
    roles: String(values?.[1] ?? "").trim(),
  })).filter(({ email, roles }) => email || roles);
  if (!records.length) throw new HttpError("Add at least one account below the headings", 422);
  return records;
};
