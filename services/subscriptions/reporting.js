import { alumniToSpreadsheet, usersToSpreadsheet } from "../background-services/google-spreadsheets.js";
import { recountAlumniStatistics, recountMemberStatistics } from "../background-services/statistics-service.js";

export const membershipReportingSnapshot = (user) => JSON.stringify([
  user.status, [...(user.roles || [])].sort(), user.tier, user.region,
  user.subscription?.priceId, user.subscription?.period,
  user.purchaseDate ? new Date(user.purchaseDate).getTime() : null,
  user.expireDate ? new Date(user.expireDate).getTime() : null,
]);

export function refreshMembershipReporting(user) {
  // Use the existing deduplicated queues, only after a material account change.
  // Both programmes need a refresh when an account moves between collections.
  usersToSpreadsheet();
  if (user.region) usersToSpreadsheet(user.region);
  alumniToSpreadsheet();
  recountMemberStatistics();
  recountAlumniStatistics();
}
