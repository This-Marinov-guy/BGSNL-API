const MAX_SLUG_LENGTH = 96;

export const eventSlugify = (value) => String(value || "")
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, MAX_SLUG_LENGTH)
  .replace(/-+$/g, "") || "bgsnl-event";

// Use the event's calendar date in the Netherlands, including near midnight.
const eventDateSuffix = value => {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.valueOf())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", timeZone: "Europe/Amsterdam",
  }).formatToParts(date);
  return ["day", "month"].map(type => parts.find(part => part.type === type).value).join("");
};

const withSuffix = (base, suffix) => `${base.slice(0, MAX_SLUG_LENGTH - suffix.length - 1).replace(/-+$/g, "")}-${suffix}`;

export async function uniqueEventSlug(Event, preferred, { excludeId, region, date } = {}) {
  const base = eventSlugify(preferred);
  const dateSuffix = eventDateSuffix(date);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = dateSuffix
      ? `${dateSuffix}${attempt > 1 ? `-${attempt}` : ""}`
      : String(attempt + 1);
    const candidate = attempt === 0 ? base : withSuffix(base, suffix);
    // Keep historical URLs reserved as well: they remain publicly addressable.
    const existing = await Event.exists({
      slug: candidate,
      ...(region ? { region } : {}),
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!existing) return candidate;
  }
  throw new Error("Could not reserve a unique event URL");
}
