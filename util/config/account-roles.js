// Storage compatibility only: these aliases retain their previous permissions.
export const LEGACY_ROLE_NAMES = Object.freeze({
  society_board_member: "national_board_member",
  board_member: "regional_board_member",
  committee_member: "regional_committee_member",
});
export const normalizeRoleNames = (roles) => [...new Set((Array.isArray(roles) ? roles : [])
  .filter(role => typeof role === "string")
  .map(role => Object.hasOwn(LEGACY_ROLE_NAMES, role) ? LEGACY_ROLE_NAMES[role] : role))];
export const NATIONAL_ACCOUNT_ROLES = Object.freeze(["national_board_member", "national_committee_member"]);
export const MEMBER_ACCOUNT_ROLES = Object.freeze(["active_member", "regional_committee_member",
  "regional_board_member", ...NATIONAL_ACCOUNT_ROLES, "support"]);
export const accountRoleOptions = (type) => type === "alumni" ? NATIONAL_ACCOUNT_ROLES : MEMBER_ACCOUNT_ROLES;

const privilegedRoles = ["vip", "support", "developer"];
export const assignableAccountRoles = (actorRoles, type) => {
  const roles = normalizeRoleNames(actorRoles);
  if (roles.includes("super_admin")) return [...new Set([...accountRoleOptions(type), ...privilegedRoles, "admin", "super_admin"])];
  if (roles.includes("admin")) return [...new Set([...accountRoleOptions(type), ...privilegedRoles])];
  if (roles.includes("national_board_member")) return type === "alumni"
    ? ["national_committee_member"] : ["regional_board_member", "national_committee_member"];
  if (roles.includes("regional_board_member")) return type === "member"
    ? ["regional_board_member", "regional_committee_member"] : [];
  return [];
};

// Admin accounts require Super Admin. VIP and Developer accounts require Admin or Super Admin.
export const canEditProtectedAccount = (actorRoles, targetRoles) =>
  normalizeRoleNames(actorRoles).includes("super_admin") ||
  (!normalizeRoleNames(targetRoles).some(role => ["admin", "super_admin"].includes(role)) &&
    (normalizeRoleNames(actorRoles).includes("admin") ||
      !normalizeRoleNames(targetRoles).some(role => ["developer", "vip"].includes(role))));

// Alumni management is reserved for national board and administrators.
export const canManageAccountType = (actorRoles, type) => type !== "alumni" ||
  normalizeRoleNames(actorRoles).some(role => ["super_admin", "admin", "national_board_member"].includes(role));
