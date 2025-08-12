import * as XLSX from "xlsx";
import moment from "moment-timezone";
import User from "../../models/User.js";

const AGE_BUCKETS = [
  { label: "<18", from: 0, to: 17 },
  { label: "18-24", from: 18, to: 24 },
  { label: "25-34", from: 25, to: 34 },
  { label: "35-44", from: 35, to: 44 },
  { label: "45-54", from: 45, to: 54 },
  { label: "55-64", from: 55, to: 64 },
  { label: "65+", from: 65, to: 200 },
];

const calculateAgeYears = (date) => {
  try {
    if (!date) return null;
    const now = moment();
    const dob = moment(date);
    if (!dob.isValid()) return null;
    return now.diff(dob, "years");
  } catch {
    return null;
  }
};

const bucketizeAge = (age) => {
  if (age === null || age === undefined) return "unknown";
  const bucket = AGE_BUCKETS.find((b) => age >= b.from && age <= b.to);
  return bucket ? bucket.label : "unknown";
};

const increment = (map, key, by = 1) => {
  const k = key ?? "unknown";
  map[k] = (map[k] || 0) + by;
};

const toSheet = (titleRow, dataObject, sortByValueDesc = true, limit = null) => {
  const entries = Object.entries(dataObject);
  const sorted = sortByValueDesc
    ? entries.sort((a, b) => b[1] - a[1])
    : entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const limited = limit ? sorted.slice(0, limit) : sorted;
  return [titleRow, ...limited.map(([k, v]) => [k, v])];
};

export const generateAnonymizedUserStatsXls = async (filter = {}) => {
  // Fetch only fields needed for statistics, DO NOT fetch names/emails
  const users = await User.find(filter, {
    status: 1,
    roles: 1,
    subscription: 1,
    region: 1,
    purchaseDate: 1,
    expireDate: 1,
    birth: 1,
    university: 1,
    otherUniversityName: 1,
    "mmmCampaign2025.calendarSubscription": 1,
  })
    .sort({ _id: -1 })
    .lean();

  const totalUsers = users.length;

  const byStatus = {};
  const byRegion = {};
  const byRole = {};
  const bySubscriptionType = {};
  const byAgeBucket = {};
  const byUniversity = {};
  const byPurchaseYear = {};

  let expiredCount = 0;
  let activeMembershipCount = 0;
  let calendarSubscribed = 0;

  const today = moment();

  for (const u of users) {
    // status
    increment(byStatus, u.status);

    // region
    increment(byRegion, u.region);

    // roles
    if (Array.isArray(u.roles)) {
      for (const role of u.roles) increment(byRole, role);
    }

    // subscription type
    const hasSubscription = Boolean(u.subscription && u.subscription.id);
    increment(bySubscriptionType, hasSubscription ? "subscription" : "one-time/none");

    // membership validity
    if (u.expireDate && moment(u.expireDate).isAfter(today)) activeMembershipCount += 1;
    else expiredCount += 1;

    // age bucket
    const age = calculateAgeYears(u.birth);
    increment(byAgeBucket, bucketizeAge(age));

    // university (resolve "other")
    let uni = u.university;
    if (uni === "other") uni = u.otherUniversityName || "other";
    increment(byUniversity, uni);

    // purchase year
    if (u.purchaseDate) increment(byPurchaseYear, moment(u.purchaseDate).format("YYYY"));

    // campaign flag
    if (u?.mmmCampaign2025?.calendarSubscription) calendarSubscribed += 1;
  }

  // Build workbook
  const wb = XLSX.utils.book_new();

  // Overview sheet
  const overviewRows = [
    ["Metric", "Value"],
    ["Total Users", totalUsers],
    ["Active Memberships (expireDate in future)", activeMembershipCount],
    ["Expired Memberships", expiredCount],
    ["Calendar Subscribed (MMM 2025)", calendarSubscribed],
  ];
  const wsOverview = XLSX.utils.aoa_to_sheet(overviewRows);
  XLSX.utils.book_append_sheet(wb, wsOverview, "Overview");

  // Detail sheets
  const sheets = [
    { name: "By Status", rows: toSheet(["Status", "Count"], byStatus) },
    { name: "By Region", rows: toSheet(["Region", "Count"], byRegion) },
    { name: "By Roles", rows: toSheet(["Role", "Count"], byRole) },
    {
      name: "By Subscription",
      rows: toSheet(["Type", "Count"], bySubscriptionType, true),
    },
    { name: "Age Buckets", rows: toSheet(["Age Bucket", "Count"], byAgeBucket, false) },
    { name: "Universities (Top 50)", rows: toSheet(["University", "Count"], byUniversity, true, 50) },
    { name: "Purchase Year", rows: toSheet(["Year", "Count"], byPurchaseYear, false) },
  ];

  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }

  const filename = `user_stats_${moment().format("YYYY-MM-DD_HHmmss")}.xls`;
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xls" });
  const mime = "application/vnd.ms-excel";

  return { buffer, filename, mime };
};


