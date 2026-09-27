// Match the dashboard's effective-date boundary. Closed ticket sales do not
// make an upcoming event historical; drafts/cancellations are never upgraded.
export function isActiveUpgradeEvent(event, now = new Date()) {
  const status = String(event?.status || "").trim().toLowerCase();
  if (!["opened", "closed", "temporary closed"].includes(status)) return false;
  const date = new Date(event.correctedDate || event.date).getTime();
  return Number.isFinite(date) && date >= new Date(now).getTime();
}

export const activeEventUpgradeQuery = (now = new Date()) => ({
  status: { $in: ["opened", "closed", "temporary closed"] },
  $expr: { $gte: [{ $ifNull: ["$correctedDate", "$date"] }, now] },
});
