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

export async function uniqueEventSlug(Event, preferred, { excludeId } = {}) {
  const base = eventSlugify(preferred);
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base.slice(0, MAX_SLUG_LENGTH - String(suffix).length - 1)}-${suffix}`;
    const existing = await Event.exists({ slug: candidate, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
    if (!existing) return candidate;
  }
  throw new Error("Could not reserve a unique event URL");
}
