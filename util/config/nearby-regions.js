// Announcement audiences, not access permissions or billing routes.
// Normal station-to-station train journeys strictly under 60 minutes; either
// city qualifies for combined regions. Reviewed 2026-10-01. See docs for sources.
// Links are symmetric but NOT transitive. The host is added by the helper.
export const NEARBY_REGIONS = Object.freeze({
  amsterdam: Object.freeze(["rotterdam", "leiden_hague"]),
  breda_tilburg: Object.freeze(["eindhoven", "rotterdam", "leiden_hague"]),
  eindhoven: Object.freeze(["breda_tilburg"]),
  groningen: Object.freeze(["leeuwarden"]),
  leeuwarden: Object.freeze(["groningen"]),
  maastricht: Object.freeze([]),
  rotterdam: Object.freeze(["amsterdam", "breda_tilburg", "leiden_hague"]),
  leiden_hague: Object.freeze(["amsterdam", "breda_tilburg", "rotterdam"]),
});

export function eventAnnouncementRegions(hostRegion) {
  // Missing/unknown regions must never fall back to a nationwide mailing.
  return typeof hostRegion === "string" && Object.hasOwn(NEARBY_REGIONS, hostRegion)
    ? [hostRegion, ...NEARBY_REGIONS[hostRegion]] : [];
}
