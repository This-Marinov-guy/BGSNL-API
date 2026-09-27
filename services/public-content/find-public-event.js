import { publicEventQuery } from "./event-publication.js";

const objectIdPattern = /^[a-f\d]{24}$/i;

export async function findPublicEvent(Event, identifier, region) {
  const value = typeof identifier === "string" ? identifier : "";
  if (!value) return null;
  // Record IDs stay globally addressable, including old links with a stale region.
  if (objectIdPattern.test(value)) {
    const event = await Event.findOne({ ...publicEventQuery, _id: value });
    if (event) return event;
  }
  const query = { ...publicEventQuery, slug: value };
  if (typeof region === "string" && region) {
    return Event.findOne({ ...query, region });
  }
  // Legacy API callers can omit the region only while the slug is unambiguous.
  const matches = await Event.find(query).limit(2);
  return matches.length === 1 ? matches[0] : null;
}
