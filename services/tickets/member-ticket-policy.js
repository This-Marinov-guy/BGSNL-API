const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalizeEmail = (email) =>
  typeof email === "string" ? email.replace(/\s+/g, "").toLowerCase() || null : null;

export const memberTicketClaimKey = (eventId, userId) =>
  `member-ticket:${String(eventId)}:${String(userId)}`;

export const isMemberPriceCheckout = (metadata = {}) => {
  if (metadata.memberPriceApplied !== undefined) {
    return metadata.memberPriceApplied === true || metadata.memberPriceApplied === "true";
  }

  return metadata.normalTicket !== true && metadata.normalTicket !== "true";
};

export const normalizeCheckoutQuantity = (value, checkoutType) => {
  const quantity = value === undefined || value === null || value === ""
    ? 1
    : Number(value);

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return null;
  if (checkoutType === "member" && quantity !== 1) return null;
  return quantity;
};

export const isRestrictedTicketAccount = (account) =>
  !account || account.status !== "active";

const memberAccountIds = ({ userId, userIds = [] }) =>
  [...new Set([userId, ...userIds].filter(Boolean).map(String))];

export const memberTicketDuplicateMatcher = ({ userId, userIds, email }) => {
  const identities = memberAccountIds({ userId, userIds })
    .map((accountId) => ({ userId: accountId }));

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    identities.push({
      email: { $regex: `^${escapeRegex(normalizedEmail)}$`, $options: "i" },
    });
  }

  return {
    refunded: { $ne: true },
    type: "member",
    ...(identities.length ? { $or: identities } : {}),
  };
};

export const isExistingMemberTicket = (ticket, { userId, userIds, email }) => {
  if (!ticket || ticket.refunded === true || ticket.type !== "member") return false;

  const accountIds = memberAccountIds({ userId, userIds });
  if (accountIds.includes(String(ticket.userId || ""))) return true;

  const expectedEmail = normalizeEmail(email);
  return Boolean(expectedEmail && normalizeEmail(ticket.email) === expectedEmail);
};
