import { isDeepStrictEqual } from "node:util";
import { BSON } from "mongodb";
import { uniqueEventSlug } from "../public-content/event-slug.js";

export const MIGRATION_ID = "007-upgrade-production-events";
export const BACKUP_COLLECTION = "eventProductionUpgradeBackups";

// Deliberately exclude guest lists, ticket images and attendee contact data.
export const EVENT_PROJECTION = Object.fromEntries([
  "_id", "title", "region", "date", "createdAt", "metadata", "lastUpdate", "slug",
  "product", "promotion", "earlyBird", "lateBird", "addOns",
  "bgImage", "bgImageExtra", "bgImageSelection",
].map(key => [key, 1]));

const clone = value => BSON.deserialize(BSON.serialize(value));
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !value._bsontype;
const own = (value, key) => Object.hasOwn(value, key);
const regionOf = region => ["breda", "bread"].includes(region) ? "breda_tilburg" : region;
const issue = (event, path) => { throw new Error(`Event ${event._id}: unexpected ${path}; review before migrating.`); };

function defaults(event, value, path, entries) {
  if (!object(value)) issue(event, path);
  for (const [key, fallback] of Object.entries(entries)) {
    if (!own(value, key)) value[key] = fallback;
    if (typeof fallback === "boolean" && typeof value[key] !== "boolean") issue(event, `${path}.${key}`);
  }
}

function normalizeDate(event, value, path) {
  if (value == null) return value;
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value;
  // Do not silently interpret ambiguous wall-clock times in the deploy host's timezone.
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) issue(event, path);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) issue(event, path);
  return date;
}

export function normalizeLegacyEvent(original) {
  const event = clone(original);
  if (typeof event.title !== "string" || !event.title.trim()) issue(event, "title");
  if (typeof event.region !== "string" || !event.region.trim()) issue(event, "region");
  event.region = regionOf(event.region);
  if (event.lastUpdate != null && !object(event.lastUpdate)) issue(event, "lastUpdate");
  event.metadata ??= {};
  defaults(event, event.metadata, "metadata", {});
  event.metadata.createdBy ??= null;
  event.metadata.createdAt ??= event.createdAt ?? null;
  event.metadata.updatedBy ??= event.lastUpdate?.id ?? null;
  event.metadata.updatedAt ??= event.lastUpdate?.timestamp ?? null;
  for (const key of ["createdAt", "updatedAt"]) event.metadata[key] = normalizeDate(event, event.metadata[key], `metadata.${key}`);
  // The last editor is not necessarily the creator. Never invent attribution.
  delete event.lastUpdate;
  for (const field of ["bgImage", "bgImageExtra", "bgImageSelection"]) delete event[field];

  for (const key of ["earlyBird", "lateBird"]) {
    event[key] ??= {};
    defaults(event, event[key], key, { isEnabled: false, excludeMembers: false });
    for (const timer of ["startTimer", "ticketTimer"]) {
      if (event[key][timer] === "") delete event[key][timer];
      else if (own(event[key], timer)) event[key][timer] = normalizeDate(event, event[key][timer], `${key}.${timer}`);
    }
  }
  event.promotion ??= {};
  defaults(event, event.promotion, "promotion", {});
  for (const tier of ["guest", "member"]) {
    event.promotion[tier] ??= {};
    defaults(event, event.promotion[tier], `promotion.${tier}`, { isEnabled: false, discount: 0 });
  }
  event.addOns ??= {};
  defaults(event, event.addOns, "addOns", { isEnabled: false, isMandatory: false });

  // Free/external events can have no product. Do not create prices or Stripe objects.
  if (event.product != null) {
    defaults(event, event.product, "product", { earlyBird: false, lateBird: false, promoCodes: [] });
    if (!Array.isArray(event.product.promoCodes)) issue(event, "product.promoCodes");
    for (const [index, code] of event.product.promoCodes.entries()) {
      const path = `product.promoCodes.${index}`;
      defaults(event, code, path, {
        customerScoped: false, audiences: ["guest", "member"], redeemedBefore: 0, exhausted: false, active: true,
      });
      if (!Array.isArray(code.audiences) || !code.audiences.length || code.audiences.some(audience => !["guest", "member", "activeMember"].includes(audience))) issue(event, `${path}.audiences`);
      // Keep code spelling, IDs, limits and economics aligned with existing Stripe codes.
      // Customer scoping requires the normal Stripe-backed code-edit flow.
    }
  }
  return event;
}

function diff(before, after, path = "", set = {}, unset = {}) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "_id") continue;
    const field = path ? `${path}.${key}` : key;
    if (!own(after, key)) unset[field] = "";
    else if (!own(before, key)) set[field] = after[key];
    else if (!isDeepStrictEqual(before[key], after[key])) {
      if (object(before[key]) && object(after[key])) diff(before[key], after[key], field, set, unset);
      else set[field] = after[key];
    }
  }
  return { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) };
}

export async function planEventProductionUpgrade(records) {
  const normalized = records.map(original => ({ original, event: normalizeLegacyEvent(original) }));
  const reserved = new Set();
  const slugKey = (region, slug) => JSON.stringify([region, slug]);
  for (const { event } of normalized) {
    if (event.slug == null || event.slug === "") continue;
    if (typeof event.slug !== "string" || !event.slug.trim()) issue(event, "slug");
    const key = slugKey(event.region, event.slug);
    if (reserved.has(key)) issue(event, "duplicate region/slug");
    reserved.add(key);
  }
  normalized.sort((a, b) => (new Date(a.event.createdAt || 0) - new Date(b.event.createdAt || 0)) || String(a.event._id).localeCompare(String(b.event._id)));
  const plans = [];
  const fields = {};
  for (const { original, event } of normalized) {
    if (!event.slug) {
      event.slug = await uniqueEventSlug({ exists: async query => reserved.has(slugKey(query.region, query.slug)) }, event.title, { region: event.region, date: event.date });
      reserved.add(slugKey(event.region, event.slug));
    }
    const update = diff(original, event);
    const paths = [...Object.keys(update.$set || {}), ...Object.keys(update.$unset || {})];
    if (!paths.length) continue;
    for (const path of paths) fields[path] = (fields[path] || 0) + 1;
    const roots = [...new Set(paths.map(path => path.split(".")[0]))];
    const guards = [...new Set([...roots, "title", "date", "region"])];
    const filter = { _id: original._id, $and: guards.map(key => ({ [key]: own(original, key) ? { $exists: true, $eq: original[key] } : { $exists: false } })) };
    plans.push({ eventId: original._id, filter, update,
      before: Object.fromEntries(roots.filter(key => own(original, key)).map(key => [key, original[key]])),
      missingBefore: roots.filter(key => !own(original, key)),
    });
  }
  return { plans, summary: { scanned: records.length, pending: plans.length, fields } };
}

export async function upgradeProductionEvents(db, { apply = false } = {}) {
  const events = db.collection("events");
  const records = await events.find({}, { projection: EVENT_PROJECTION }).toArray();
  // Plan and validate the entire collection before making the first write.
  const { plans, summary } = await planEventProductionUpgrade(records);
  let modified = 0;
  if (apply) {
    for (const plan of plans) {
      await db.collection(BACKUP_COLLECTION).updateOne({ _id: `${MIGRATION_ID}:${plan.eventId}` }, {
        $setOnInsert: { migrationId: MIGRATION_ID, eventId: plan.eventId, before: plan.before, missingBefore: plan.missingBefore, update: plan.update, backedUpAt: new Date() },
      }, { upsert: true });
      const result = await events.updateOne(plan.filter, plan.update, { collation: { locale: "simple" } });
      if (result.matchedCount !== 1) throw new Error(`Event ${plan.eventId} changed during migration. Stopped without overwriting it; review and rerun.`);
      modified += result.modifiedCount;
    }
  }
  return { mode: apply ? "apply" : "dry-run", ...summary, modified };
}
