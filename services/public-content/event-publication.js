import { checkDiscountsOnEvents } from "../main-services/event-action-service.js";

const price = (item) => {
  if (!item || typeof item !== "object") return undefined;
  const result = {};
  for (const key of ["price", "originalPrice", "discount"]) {
    if (item[key] !== undefined) result[key] = item[key];
  }
  return Object.keys(result).length ? result : undefined;
};

const product = (value) => {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key of ["guest", "member", "activeMember"]) {
    const safePrice = price(value[key]);
    if (safePrice) result[key] = safePrice;
  }
  if (value.earlyBird === true) result.earlyBird = true;
  if (value.lateBird === true) result.lateBird = true;
  return Object.keys(result).length ? result : undefined;
};

const addOns = (value) => !value?.isEnabled ? { isEnabled: false } : {
  isEnabled: true,
  isMandatory: value.isMandatory === true,
  multi: value.multi === true,
  title: value.title || "",
  description: value.description || "",
  items: (value.items || []).map((item) => ({
    id: item.id,
    title: item.title || "",
    description: item.description || "",
    price: item.price,
  })),
};

const relatedEvents = (value) => {
  if (!value || !Array.isArray(value.links)) return undefined;
  const links = value.links.flatMap((link) => {
    if (typeof link?.name !== "string" || !link.name.trim() || typeof link?.href !== "string") return [];
    try {
      const url = new URL(link.href);
      if (!["http:", "https:"].includes(url.protocol)) return [];
      return [{ name: link.name, href: url.href }];
    } catch { return []; }
  });
  return links.length ? { description: typeof value.description === "string" && value.description.trim() ? value.description : "You might also like", links } : undefined;
};

/**
 * Browser/SSR-safe event shape. Never return a Mongoose model or redact by
 * deletion: promotion codes, Stripe price IDs, attendee details, cloud folder
 * names and arbitrary future model fields stay private by construction.
 */
export const serializePublicEvent = (record, { checkout = false } = {}) => {
  if (!record) return null;
  const source = typeof record.toObject === "function"
    ? record.toObject({ getters: true }) : { ...record };
  const availableTickets = Math.max(0, Number(source.ticketLimit || 0) - (source.guestList?.length || 0));
  const discounted = checkDiscountsOnEvents({ ...source, product: source.product ? structuredClone(source.product) : source.product });

  const recommendations = relatedEvents(source.subEvent);
  const result = {
    id: String(source.id || source._id),
    ...(source.slug ? { slug: source.slug } : {}),
    ...(source.createdAt ? { createdAt: source.createdAt } : {}),
    ...(source.metadata?.updatedAt ? { metadata: { updatedAt: source.metadata.updatedAt } } : {}),
    region: source.region,
    title: source.title,
    ...(source.newTitle ? { newTitle: source.newTitle } : {}),
    description: source.description || "",
    text: source.text || "",
    date: source.date,
    ...(source.correctedDate ? { correctedDate: source.correctedDate } : {}),
    location: source.location,
    ...(recommendations ? { subEvent: recommendations } : {}),
    ticketTimer: source.ticketTimer,
    ticketLimit: source.ticketLimit,
    ticketsRemaining: availableTickets,
    isSaleClosed: source.isSaleClosed === true,
    isFree: source.isFree === true,
    isMemberFree: source.isMemberFree === true,
    memberOnly: source.memberOnly === true,
    entryIncluding: source.entryIncluding || "",
    memberIncluding: source.memberIncluding || "",
    including: source.including || "",
    ticketLink: source.ticketLink || "",
    images: Array.isArray(source.images) ? source.images : [],
    ticketImg: source.ticketImg,
    ticketColor: source.ticketColor,
    ticketQR: source.ticketQR === true,
    ticketName: source.ticketName === true,
    poster: source.poster,
    ...(product(discounted.product) ? { product: product(discounted.product) } : {}),
  };

  if (checkout) {
    result.extraInputsForm = source.extraInputsForm || null;
    result.addOns = addOns(source.addOns);
  }
  return result;
};

export const publicEventQuery = {
  hidden: { $ne: true },
  status: { $nin: ["archived", "draft"] },
};

const FUTURE_EVENT_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

// Public listings (future-events pages, home carousels, sitemap) should drop
// an event once at least two days have passed since it started — not the instant
// it starts, since same-day/multi-hour events must stay visible while live.
// Event detail pages use publicEventQuery alone and are unaffected.
export const futureEventDateFilter = (now = Date.now()) => ({
  $expr: {
    $gt: [{ $ifNull: ["$correctedDate", "$date"] }, new Date(now - FUTURE_EVENT_GRACE_MS)],
  },
});
