import { canManageAccountType, canEditProtectedAccount, accountRoleOptions, MEMBER_ACCOUNT_ROLES, normalizeRoleNames } from "../../util/config/account-roles.js";
import AlumniUser from "../../models/AlumniUser.js";
import HttpError from "../../models/Http-error.js";
import MemberUser from "../../models/MemberUser.js";
import {
  ALL_MEMBER_REGIONS_ACCESS,
  ADMIN,
  DEVELOPER,
  ALUMNI,
  DEFAULT_REGION,
  MEMBER,
  REGIONS,
  SUPER_ADMIN,
  VIP,
} from "../../util/config/defines.js";
import { USER_STATUSES } from "../../util/config/enums.js";
import { parseRoleImport } from "./account-role-import.js";

export const ACCOUNT_TYPES = Object.freeze({ MEMBER, ALUMNI });
export const PROTECTED_ROLES = Object.freeze([ADMIN, SUPER_ADMIN, DEVELOPER, VIP]);
export const EDITABLE_ROLES = MEMBER_ACCOUNT_ROLES;
export const EDITABLE_STATUSES = Object.freeze(Object.values(USER_STATUSES));
export const EDITABLE_CITIES = Object.freeze([DEFAULT_REGION, ...REGIONS]);

const LIST_FIELDS = [
  "_id", "__v", "name", "surname", "email", "phone", "status", "roles",
  "region", "birth", "image", "university", "otherUniversityName",
  "graduationDate", "course", "studentNumber", "profession", "tier",
  "joinDate", "purchaseDate", "expireDate", "subscription.id", "subscription.customerId", "subscription.period",
].join(" ");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const normalizeAccountSearch = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, "").trim().slice(0, 100) : "";

export const buildAccountSearchPattern = (value) => {
  const normalized = normalizeAccountSearch(value);
  if (!normalized) return null;
  return Array.from(normalized)
    .map(escapeRegExp)
    .join("[\\s()+.\\-]*");
};

export const buildAccountListFilter = ({ city, search, type, status = "" }) => {
  const filter = {};
  if (status !== "") {
    if (!EDITABLE_STATUSES.includes(status)) throw new HttpError("Account status filter is invalid", 422);
    filter.status = status;
  }
  if (city === "unassigned") {
    filter.$or = [{ region: { $exists: false } }, { region: "" }, { region: null }];
  } else if (EDITABLE_CITIES.includes(city)) {
    filter.region = city;
  }

  const pattern = buildAccountSearchPattern(search);
  if (!pattern) return filter;

  const searchConditions = [
    { email: { $regex: pattern, $options: "i" } },
    { name: { $regex: pattern, $options: "i" } },
    { surname: { $regex: pattern, $options: "i" } },
    { phone: { $regex: pattern, $options: "i" } },
    {
      $expr: {
        $regexMatch: {
          input: {
            $concat: [
              { $ifNull: ["$name", ""] },
              { $ifNull: ["$surname", ""] },
            ],
          },
          regex: pattern,
          options: "i",
        },
      },
    },
  ];
  if (type === MEMBER) {
    searchConditions.push({ studentNumber: { $regex: pattern, $options: "i" } });
  }

  if (filter.$or) {
    filter.$and = [{ $or: filter.$or }, { $or: searchConditions }];
    delete filter.$or;
  } else {
    filter.$or = searchConditions;
  }
  return filter;
};

const modelForType = (type, models) => {
  if (type === MEMBER) return models.member;
  if (type === ALUMNI) return models.alumni;
  throw new HttpError("Unknown account type", 422);
};

const integerInRange = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const summary = (record, type) => ({
  id: String(record._id),
  revision: Number(record.__v ?? 0),
  type,
  name: record.name || "",
  surname: record.surname || "",
  email: record.email || "",
  phone: record.phone || "",
  status: record.status || "",
  roles: normalizeRoleNames(record.roles),
  region: record.region || "",
  birth: record.birth || null,
  image: record.image || "",
  university: record.university || "",
  otherUniversityName: record.otherUniversityName || "",
  graduationDate: record.graduationDate || "",
  course: record.course || "",
  studentNumber: record.studentNumber || "",
  profession: record.profession || "",
  tier: Number.isInteger(record.tier) ? record.tier : null,
  joinDate: record.joinDate || null,
  purchaseDate: record.purchaseDate || null,
  expireDate: record.expireDate || null,
  nonExpiring: record.roles?.includes(VIP) || false,
  hasSubscription: Boolean(record.subscription?.id),
  subscription: {
    id: record.subscription?.id || null,
    customerId: record.subscription?.customerId || null,
    period: Number.isFinite(record.subscription?.period) && record.subscription.period > 0 ? record.subscription.period : null,
  },
});

const requiredText = (value, label, max = 100) => {
  if (typeof value !== "string") throw new HttpError(`${label} is required`, 422);
  const clean = value.trim().replace(/\s+/g, " ");
  if (!clean || clean.length > max) throw new HttpError(`${label} is invalid`, 422);
  return clean;
};

const optionalText = (value, label, max = 180) => {
  if (value == null) return "";
  if (typeof value !== "string") throw new HttpError(`${label} is invalid`, 422);
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length > max) throw new HttpError(`${label} is too long`, 422);
  return clean;
};

const emailValue = (value) => {
  const clean = requiredText(value, "Email", 254).replace(/\s+/g, "").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new HttpError("Email is invalid", 422);
  return clean;
};

const dateValue = (value, label, maximum = new Date()) => {
  if (value === "" || value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(`${label} is invalid`, 422);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(`${label} is invalid`, 422);
  }
  if (date < new Date("1900-01-01T00:00:00.000Z") || date > maximum) {
    throw new HttpError(`${label} is outside the allowed range`, 422);
  }
  return date;
};

const exactEmailRegex = (email) => new RegExp(
  `^\\s*${Array.from(email).map(escapeRegExp).join("\\s*")}\\s*$`,
  "i",
);

const versionFilter = (revision) => revision === 0
  ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] }
  : { __v: revision };

// Board members reach this panel (ACCESS_3) without the unrestricted access
// ALL_MEMBER_REGIONS_ACCESS roles have; they may only see and edit accounts in their own
// region. Returns null when the actor is unrestricted, otherwise the region
// they are confined to ("" if they have none on file, which matches nothing).
const regionScopeFor = (actor) => {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  if (roles.some((role) => ALL_MEMBER_REGIONS_ACCESS.includes(role))) return null;
  const region = typeof actor?.region === "string" ? actor.region.trim().toLowerCase() : "";
  return EDITABLE_CITIES.includes(region) ? region : "";
};

const publicOptions = (type, citiesOverride) => ({
  cities: citiesOverride ?? EDITABLE_CITIES,
  roles: accountRoleOptions(type),
  statuses: EDITABLE_STATUSES,
});

export const createAccountsBackofficeService = ({
  memberModel = MemberUser,
  alumniModel = AlumniUser,
} = {}) => {
  const models = { member: memberModel, alumni: alumniModel };

  const list = async (query = {}, actor) => {
    const type = query.type === ALUMNI ? ALUMNI : MEMBER;
    if (!canManageAccountType(actor?.roles, type)) throw new HttpError("No access to Alumni administration", 403);
    const page = integerInRange(query.page, 1, 1, 100000);
    const pageSize = integerInRange(query.pageSize, 25, 10, 100);
    const scope = regionScopeFor(actor);
    const search = typeof query.search === "string" ? query.search : "";
    const Model = modelForType(type, models);
    // A region-scoped actor with no valid region on file gets a filter that
    // matches nothing, rather than falling through to an unrestricted list.
    const filter = scope === "" ? { _id: null } :
      buildAccountListFilter({ city: scope !== null ? scope : (typeof query.city === "string" ? query.city.toLowerCase() : ""), search, type, status: query.status });

    const [records, total] = await Promise.all([
      Model.aggregate([
        { $match: filter },
        { $addFields: { lockedOrder: { $cond: [{ $eq: ["$status", "locked"] }, 1, 0] } } },
        { $sort: { lockedOrder: 1, surname: 1, name: 1, email: 1, _id: 1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        { $project: Object.fromEntries(LIST_FIELDS.split(" ").map(field => [field, 1])) },
      ]),
      Model.countDocuments(filter),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return {
      accounts: records.map((record) => summary(record, type)),
      page,
      pageSize,
      total,
      totalPages,
      options: publicOptions(type, scope !== null ? (scope ? [scope] : []) : undefined),
    };
  };

  const update = async ({ type, id, body = {}, actor }) => {
    if (!canManageAccountType(actor?.roles, type)) throw new HttpError("No access to Alumni administration", 403);
    const Model = modelForType(type, models);
    if (typeof id !== "string" || !id || id.length > 100) throw new HttpError("Account ID is invalid", 422);
    const revision = Number(body.revision);
    if (!Number.isInteger(revision) || revision < 0) throw new HttpError("Account revision is required", 422);

    const existing = await Model.findById(id).select(LIST_FIELDS).lean();
    if (!existing) throw new HttpError("Account not found", 404);
    if (!canEditProtectedAccount(actor?.roles, existing.roles)) {
      throw new HttpError("Only Super Admins can edit Admin, Super Admin or VIP accounts", 403);
    }

    const scope = regionScopeFor(actor);
    if (scope !== null) {
      const existingRegion = typeof existing.region === "string" ? existing.region.trim().toLowerCase() : "";
      if (!scope || existingRegion !== scope) throw new HttpError("You can only manage accounts in your own region", 403);
    }

    const next = {
      name: requiredText(body.name, "First name", 80),
      surname: requiredText(body.surname, "Last name", 80),
      email: emailValue(body.email),
      phone: type === MEMBER
        ? requiredText(body.phone, "Mobile number", 40)
        : optionalText(body.phone, "Mobile number", 40),
      region: optionalText(body.region, "City", 50).toLowerCase(),
      birth: dateValue(body.birth, "Date of birth"),
      university: optionalText(body.university, "University", 180),
      otherUniversityName: optionalText(body.otherUniversityName, "Other university", 180),
      graduationDate: optionalText(body.graduationDate, "Graduation year", 20),
      course: optionalText(body.course, "Study programme", 180),
      studentNumber: optionalText(body.studentNumber, "Student number", 80),
      profession: optionalText(body.profession, "Profession", 180),
    };
    if (!existing.roles?.includes(VIP)) {
      const requestedExpiry = body.expireDate === undefined && existing.expireDate
        ? new Date(existing.expireDate).toISOString().slice(0, 10)
        : body.expireDate;
      const expireDate = dateValue(requestedExpiry, "Membership expiry", new Date("2200-12-31T00:00:00.000Z"));
      if (!expireDate) throw new HttpError("Membership expiry is required", 422);
      next.expireDate = expireDate;
    }
    if (next.region && !EDITABLE_CITIES.includes(next.region)) throw new HttpError("City is invalid", 422);
    if (scope !== null && next.region !== scope) throw new HttpError("You can only manage accounts in your own region", 403);
    if (type === MEMBER && !next.birth) throw new HttpError("Date of birth is required", 422);

    const requestedStatus = typeof body.status === "string" ? body.status : existing.status;
    if (requestedStatus !== existing.status && !EDITABLE_STATUSES.includes(requestedStatus)) {
      throw new HttpError("Account status is invalid", 422);
    }
    next.status = requestedStatus;

    if (!Array.isArray(body.roles) || body.roles.some((role) => !accountRoleOptions(type).includes(role))) {
      throw new HttpError("Account roles are invalid", 422);
    }
    const baseRole = type === MEMBER ? MEMBER : ALUMNI;
    const existingRoles = normalizeRoleNames(existing.roles);
    // Privileged roles are controlled outside this panel. Never derive them
    // from the request or drop them when saving the editable role selection.
    const protectedRoles = existingRoles.filter((role) => PROTECTED_ROLES.includes(role));
    next.roles = [...new Set([baseRole, ...protectedRoles, ...body.roles])];
    const rolesChanged = JSON.stringify([...existingRoles].sort()) !== JSON.stringify([...next.roles].sort());
    const statusChanged = existing.status !== next.status;
    const expiryChanged = next.expireDate && new Date(existing.expireDate).getTime() !== next.expireDate.getTime();
    const actorId = String(actor?._id ?? actor?.id ?? "");
    if (actorId === String(existing._id) && (rolesChanged || statusChanged || expiryChanged)) {
      throw new HttpError("You cannot change your own roles, account status or membership expiry", 409);
    }

    const removesSuperAdmin = existing.status === "active" && existingRoles.includes(SUPER_ADMIN) &&
      (!next.roles.includes(SUPER_ADMIN) || next.status !== "active");
    if (removesSuperAdmin) {
      const activeSuperAdmin = { status: "active", roles: SUPER_ADMIN };
      const [memberAdmins, alumniAdmins] = await Promise.all([
        memberModel.countDocuments(activeSuperAdmin),
        alumniModel.countDocuments(activeSuperAdmin),
      ]);
      if (memberAdmins + alumniAdmins <= 1) {
        throw new HttpError("The last active super admin cannot be removed or deactivated", 409);
      }
    }

    const emailChanged = next.email !== String(existing.email || "").replace(/\s+/g, "").toLowerCase();
    if (emailChanged) {
      const email = exactEmailRegex(next.email);
      const [memberCollision, alumniCollision] = await Promise.all([
        memberModel.exists({ email, ...(type === MEMBER ? { _id: { $ne: id } } : {}) }),
        alumniModel.exists({ email, ...(type === ALUMNI ? { _id: { $ne: id } } : {}) }),
      ]);
      if (memberCollision || alumniCollision) throw new HttpError("Another account already uses this email", 409);
    }

    // mongoose-unique-validator runs for every value passed to findOneAndUpdate,
    // including the document's own unchanged email. Its query validator then
    // treats that value as a duplicate. We already validate unchanged email
    // from the loaded account and independently check every changed email
    // across both account collections, so omit it unless it really changed.
    const update = { ...next };
    if (!emailChanged) delete update.email;
    const securityChanged = rolesChanged || statusChanged;
    let updated;
    try {
      updated = await Model.findOneAndUpdate(
        { _id: id, ...versionFilter(revision), roles: existing.roles ?? { $exists: false } },
        {
          $set: update,
          $inc: { __v: 1, ...(securityChanged ? { sessionVersion: 1 } : {}) },
        },
        { new: true, runValidators: true },
      ).select(LIST_FIELDS).lean();
    } catch (error) {
      const duplicateEmail = error?.code === 11000 &&
        (!error.keyPattern || Object.hasOwn(error.keyPattern, "email"));
      const emailValidation = error?.name === "ValidationError" && error.errors?.email;
      if (duplicateEmail || emailValidation) {
        throw new HttpError("Another account already uses this email", 409);
      }
      throw error;
    }
    if (!updated) throw new HttpError("This account was changed by someone else. Refresh and try again.", 409);
    return { account: summary(updated, type), options: publicOptions(type) };
  };

  const reviewRoleChanges = async (inputRows, actor) => {
    if (!Array.isArray(inputRows) || inputRows.length === 0 || inputRows.length > 200) {
      throw new HttpError("Import between 1 and 200 accounts", 422);
    }
    if (inputRows.some(row => !row || String(row.email || "").length > 254 || String(row.roles || "").length > 500)) {
      throw new HttpError("An import row is too long", 422);
    }
    const emails = [...new Set(inputRows.map(({ email }) => String(email || "").trim().toLowerCase())
      .filter(email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)))];
    const emailFilter = { $or: emails.map(email => ({ email: exactEmailRegex(email) })) };
    const scope = regionScopeFor(actor);
    const [members, alumni] = emails.length ? await Promise.all([
      memberModel.find(emailFilter).select(LIST_FIELDS).lean(),
      canManageAccountType(actor?.roles, ALUMNI)
        ? alumniModel.find(emailFilter).select(LIST_FIELDS).lean()
        : Promise.resolve([]),
    ]) : [[], []];
    const matches = new Map();
    for (const [type, records] of [[MEMBER, members], [ALUMNI, alumni]]) {
      for (const record of records) {
        if (scope !== null && (!scope || String(record.region || "").trim().toLowerCase() !== scope)) continue;
        const key = String(record.email || "").replace(/\s+/g, "").toLowerCase();
        matches.set(key, [...(matches.get(key) || []), { type, record }]);
      }
    }
    const seen = new Set();
    const actorId = String(actor?._id ?? actor?.id ?? "");
    const rows = inputRows.map((input, index) => {
      const email = String(input.email || "").trim().toLowerCase();
      const roleText = String(input.roles || "").trim().toLowerCase();
      const row = Number.isInteger(input.row) ? input.row : index + 2;
      const result = { row, email, requestedRoles: [], currentRoles: [], status: "error", message: "" };
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) result.message = "Enter a valid email address";
      else if (seen.has(email)) result.message = "This email appears more than once";
      else if (!roleText) result.message = "Enter roles or none";
      else {
        const found = matches.get(email) || [];
        if (found.length === 0) result.message = "No account you can manage has this email";
        else if (found.length > 1) result.message = "Email matches more than one account";
        else {
          const { type, record } = found[0];
          const existingRoles = normalizeRoleNames(record.roles);
          const requested = roleText === "none" ? [] : [...new Set(roleText.split(",").map(role => role.trim()))];
          result.requestedRoles = requested;
          const invalid = requested.filter(role => !accountRoleOptions(type).includes(role));
          if (!canEditProtectedAccount(actor?.roles, record.roles)) result.message = "This account is protected";
          else if (actorId === String(record._id)) result.message = "You cannot change your own roles";
          else if (invalid.length) result.message = `Unsupported ${type} role: ${invalid.join(", ")}`;
          else {
            result.id = String(record._id);
            result.type = type;
            result.name = `${record.name || ""} ${record.surname || ""}`.trim();
            result.revision = Number(record.__v ?? 0);
            result.currentRoles = existingRoles.filter(role => accountRoleOptions(type).includes(role));
            const same = [...result.currentRoles].sort().join("|") === [...requested].sort().join("|");
            result.status = same ? "unchanged" : "change";
          }
        }
      }
      seen.add(email);
      return result;
    });
    return { rows, changeCount: rows.filter(row => row.status === "change").length,
      unchangedCount: rows.filter(row => row.status === "unchanged").length,
      errorCount: rows.filter(row => row.status === "error").length };
  };

  const previewRoleImport = async ({ file, actor }) => reviewRoleChanges(parseRoleImport(file), actor);

  const applyRoleImport = async ({ rows, actor }) => {
    if (!Array.isArray(rows) || !rows.length || rows.length > 200 || rows.some(row =>
      !row || typeof row.email !== "string" || typeof row.roles !== "string" ||
      typeof row.id !== "string" || ![MEMBER, ALUMNI].includes(row.type) ||
      !Number.isInteger(row.revision) || row.revision < 0)) {
      throw new HttpError("The review is invalid. Upload the file again", 422);
    }
    const reviewed = await reviewRoleChanges(rows, actor);
    if (reviewed.errorCount) throw new HttpError("An account can no longer be updated. Upload the file and review it again", 409);
    for (let index = 0; index < rows.length; index += 1) {
      const original = rows[index], current = reviewed.rows[index];
      if (original.id !== current.id || original.type !== current.type || original.revision !== current.revision) {
        throw new HttpError("An account changed since review. Upload the file and review it again", 409);
      }
    }
    let updated = 0;
    for (const row of reviewed.rows.filter(item => item.status === "change")) {
      const Model = modelForType(row.type, models);
      const existingRoles = normalizeRoleNames((row.currentRoles || []));
      // Read the exact account again to retain protected roles and detect a
      // concurrent change before writing. The atomic filter also checks roles.
      const existing = await Model.findById(row.id).select("roles __v").lean();
      if (!existing || Number(existing.__v ?? 0) !== row.revision ||
        [...normalizeRoleNames(existing.roles).filter(role => accountRoleOptions(row.type).includes(role))].sort().join("|") !== [...existingRoles].sort().join("|")) {
        throw new HttpError(`${updated} accounts updated before another account changed. Refresh and import the remaining accounts again`, 409);
      }
      const retained = normalizeRoleNames(existing.roles).filter(role => PROTECTED_ROLES.includes(role));
      const nextRoles = [...new Set([row.type, ...retained, ...row.requestedRoles])];
      const saved = await Model.findOneAndUpdate(
        { _id: row.id, ...versionFilter(row.revision), roles: existing.roles ?? { $exists: false } },
        { $set: { roles: nextRoles }, $inc: { __v: 1, sessionVersion: 1 } },
        { new: true, runValidators: true },
      ).select("_id").lean();
      if (!saved) throw new HttpError(`${updated} accounts updated before another account changed. Refresh and import the remaining accounts again`, 409);
      updated += 1;
    }
    return { updated, unchanged: reviewed.unchangedCount };
  };

  return { list, update, previewRoleImport, applyRoleImport };
};

export const accountsBackofficeService = createAccountsBackofficeService();
