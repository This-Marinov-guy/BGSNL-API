import AlumniUser from "../../models/AlumniUser.js";
import HttpError from "../../models/Http-error.js";
import User from "../../models/User.js";
import {
  ACCESS_2,
  ACTIVE_MEMBER,
  ADMIN,
  ALUMNI,
  BOARD_MEMBER,
  COMMITTEE_MEMBER,
  DEFAULT_REGION,
  MEMBER,
  REGIONS,
  SOCIETY_ADMIN,
  SUPER_ADMIN,
  SUPPORT,
  VIP,
} from "../../util/config/defines.js";
import { USER_STATUSES } from "../../util/config/enums.js";

export const ACCOUNT_TYPES = Object.freeze({ MEMBER, ALUMNI });
export const PROTECTED_ROLES = Object.freeze([ADMIN, SUPER_ADMIN]);
export const EDITABLE_ROLES = Object.freeze([
  ACTIVE_MEMBER,
  COMMITTEE_MEMBER,
  BOARD_MEMBER,
  SOCIETY_ADMIN,
  SUPPORT,
  VIP,
]);
export const EDITABLE_STATUSES = Object.freeze(Object.values(USER_STATUSES));
export const EDITABLE_CITIES = Object.freeze([DEFAULT_REGION, ...REGIONS]);

const LIST_FIELDS = [
  "_id", "__v", "name", "surname", "email", "phone", "status", "roles",
  "region", "birth", "image", "university", "otherUniversityName",
  "graduationDate", "course", "studentNumber", "profession", "tier",
  "joinDate", "purchaseDate", "expireDate", "subscription.id",
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

export const buildAccountListFilter = ({ city, search, type }) => {
  const filter = {};
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
  roles: Array.isArray(record.roles) ? record.roles : [],
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
  hasSubscription: Boolean(record.subscription?.id),
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

const dateValue = (value, label) => {
  if (value === "" || value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(`${label} is invalid`, 422);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(`${label} is invalid`, 422);
  }
  if (date < new Date("1900-01-01T00:00:00.000Z") || date > new Date()) {
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
// ACCESS_2 roles have; they may only see and edit accounts in their own
// region. Returns null when the actor is unrestricted, otherwise the region
// they are confined to ("" if they have none on file, which matches nothing).
const regionScopeFor = (actor) => {
  const roles = Array.isArray(actor?.roles) ? actor.roles : [];
  if (roles.some((role) => ACCESS_2.includes(role))) return null;
  const region = typeof actor?.region === "string" ? actor.region.trim().toLowerCase() : "";
  return EDITABLE_CITIES.includes(region) ? region : "";
};

const publicOptions = (citiesOverride) => ({
  cities: citiesOverride ?? EDITABLE_CITIES,
  roles: EDITABLE_ROLES,
  statuses: EDITABLE_STATUSES,
});

export const createAccountsBackofficeService = ({
  memberModel = User,
  alumniModel = AlumniUser,
} = {}) => {
  const models = { member: memberModel, alumni: alumniModel };

  const list = async (query = {}, actor) => {
    const type = query.type === ALUMNI ? ALUMNI : MEMBER;
    const page = integerInRange(query.page, 1, 1, 100000);
    const pageSize = integerInRange(query.pageSize, 25, 10, 100);
    const scope = regionScopeFor(actor);
    const search = typeof query.search === "string" ? query.search : "";
    const Model = modelForType(type, models);
    // A region-scoped actor with no valid region on file gets a filter that
    // matches nothing, rather than falling through to an unrestricted list.
    const filter = scope === "" ? { _id: null } :
      buildAccountListFilter({ city: scope !== null ? scope : (typeof query.city === "string" ? query.city.toLowerCase() : ""), search, type });

    const [records, total] = await Promise.all([
      Model.find(filter)
        .select(LIST_FIELDS)
        .sort({ surname: 1, name: 1, email: 1, _id: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Model.countDocuments(filter),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return {
      accounts: records.map((record) => summary(record, type)),
      page,
      pageSize,
      total,
      totalPages,
      options: publicOptions(scope !== null ? (scope ? [scope] : []) : undefined),
    };
  };

  const update = async ({ type, id, body = {}, actor }) => {
    const Model = modelForType(type, models);
    if (typeof id !== "string" || !id || id.length > 100) throw new HttpError("Account ID is invalid", 422);
    const revision = Number(body.revision);
    if (!Number.isInteger(revision) || revision < 0) throw new HttpError("Account revision is required", 422);

    const existing = await Model.findById(id).select(LIST_FIELDS).lean();
    if (!existing) throw new HttpError("Account not found", 404);

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
    if (next.region && !EDITABLE_CITIES.includes(next.region)) throw new HttpError("City is invalid", 422);
    if (scope !== null && next.region !== scope) throw new HttpError("You can only manage accounts in your own region", 403);
    if (type === MEMBER && !next.birth) throw new HttpError("Date of birth is required", 422);

    const requestedStatus = typeof body.status === "string" ? body.status : existing.status;
    if (requestedStatus !== existing.status && !EDITABLE_STATUSES.includes(requestedStatus)) {
      throw new HttpError("Account status is invalid", 422);
    }
    next.status = requestedStatus;

    if (!Array.isArray(body.roles) || body.roles.some((role) => !EDITABLE_ROLES.includes(role))) {
      throw new HttpError("Account roles are invalid", 422);
    }
    const baseRole = type === MEMBER ? MEMBER : ALUMNI;
    const existingRoles = Array.isArray(existing.roles) ? existing.roles : [];
    // Privileged roles are controlled outside this panel. Never derive them
    // from the request or drop them when saving the editable role selection.
    const protectedRoles = existingRoles.filter((role) => PROTECTED_ROLES.includes(role));
    next.roles = [...new Set([baseRole, ...protectedRoles, ...body.roles])];
    const rolesChanged = JSON.stringify([...existingRoles].sort()) !== JSON.stringify([...next.roles].sort());
    const statusChanged = existing.status !== next.status;
    const actorId = String(actor?._id ?? actor?.id ?? "");
    if (actorId === String(existing._id) && (rolesChanged || statusChanged)) {
      throw new HttpError("You cannot change your own roles or account status", 409);
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

    if (next.email !== String(existing.email || "").replace(/\s+/g, "").toLowerCase()) {
      const email = exactEmailRegex(next.email);
      const [memberCollision, alumniCollision] = await Promise.all([
        memberModel.exists({ email, ...(type === MEMBER ? { _id: { $ne: id } } : {}) }),
        alumniModel.exists({ email, ...(type === ALUMNI ? { _id: { $ne: id } } : {}) }),
      ]);
      if (memberCollision || alumniCollision) throw new HttpError("Another account already uses this email", 409);
    }

    const securityChanged = rolesChanged || statusChanged;
    const updated = await Model.findOneAndUpdate(
      { _id: id, ...versionFilter(revision), roles: existing.roles ?? { $exists: false } },
      {
        $set: next,
        $inc: { __v: 1, ...(securityChanged ? { sessionVersion: 1 } : {}) },
      },
      { new: true, runValidators: true },
    ).select(LIST_FIELDS).lean();
    if (!updated) throw new HttpError("This account was changed by someone else. Refresh and try again.", 409);
    return { account: summary(updated, type), options: publicOptions() };
  };

  return { list, update };
};

export const accountsBackofficeService = createAccountsBackofficeService();
