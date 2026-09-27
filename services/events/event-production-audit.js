import { EVENT_PROJECTION, eventSlugIndexReadiness, normalizeLegacyEvent, planEventProductionUpgrade } from "./event-production-upgrade.js";
import { isActiveUpgradeEvent } from "./event-upgrade-scope.js";

// Audit against the real application model, supplied by the read-only CLI.
// Migrations themselves must never import models or open other connections.
export function eventAuditProjection(EventModel) {
  return {
    ...EVENT_PROJECTION,
    ...Object.fromEntries(Object.keys(EventModel.schema.paths)
      .filter(path => path !== "guestList" && !path.startsWith("guestList."))
      .map(path => [path.split(".")[0], 1])),
  };
}

function validationSummary(records, EventModel) {
  let invalidEvents = 0;
  const errorsByPath = {};
  for (const record of records) {
    const error = EventModel.hydrate(record).validateSync(); // eslint-disable-line no-sync
    if (!error) continue;
    invalidEvents += 1;
    for (const [path, detail] of Object.entries(error.errors)) {
      // Never print validator messages: Mongoose includes actual field values.
      const key = `${path.replace(/\.\d+(?=\.|$)/g, ".*")}:${detail.kind || detail.name}`;
      errorsByPath[key] = (errorsByPath[key] || 0) + 1;
    }
  }
  return { invalidEvents, errorsByPath };
}

export async function auditProductionEvents(db, EventModel, { now = new Date() } = {}) {
  const events = db.collection("events");
  const records = await events.find({}, { projection: eventAuditProjection(EventModel) }).toArray();
  const { summary } = await planEventProductionUpgrade(records, { now });
  const active = records.filter(event => isActiveUpgradeEvent(event, now));
  const statuses = {};
  for (const event of active) {
    const key = ["opened", "archived", "closed", "draft", "temporary closed", "canceled", "cancelled"].includes(event.status)
      ? event.status : "otherOrMissing";
    statuses[key] = (statuses[key] || 0) + 1;
  }
  return {
    mode: "read-only-audit",
    scanned: records.length,
    activeStatuses: statuses,
    upgrade: { ...summary, modified: 0 },
    schemaValidation: {
      before: validationSummary(active, EventModel),
      afterNormalization: validationSummary(active.map(normalizeLegacyEvent), EventModel),
      scope: "Active event fields only; attendee data excluded. Mongoose applies defaults and casts during validation.",
    },
    slugIndexes: eventSlugIndexReadiness(await events.indexes()),
    recordedEventMigrations: (await db.collection("_migrations").find({ _id: { $in: [
      "003-normalize-breda-region", "005-remove-event-backgrounds", "006-region-event-slugs", "007-upgrade-production-events",
    ] } }, { projection: { _id: 1 } }).toArray()).map(record => record._id).sort(),
    externalServicesVerified: false,
  };
}
