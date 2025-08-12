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

// Sort data entries and return as array
const sortData = (dataObject, sortByValueDesc = true, limit = null) => {
  let entries = Object.entries(dataObject);
  if (sortByValueDesc) {
    entries = entries.sort((a, b) => b[1] - a[1]);
  } else {
    entries = entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }
  return limit ? entries.slice(0, limit) : entries;
};

export const generateAnonymizedUserStatsXls = async (filter = {}) => {
  // Fetch only fields needed for statistics
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
    course: 1,
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
  const byCourse = {};

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
    
    // course/specialty
    increment(byCourse, u.course || "Not specified");

    // purchase year
    if (u.purchaseDate) increment(byPurchaseYear, moment(u.purchaseDate).format("YYYY"));

    // campaign flag
    if (u?.mmmCampaign2025?.calendarSubscription) calendarSubscribed += 1;
  }

  // Create a single comprehensive report
  const wb = XLSX.utils.book_new();
  
  // Create single worksheet
  const wsData = [];
  const addSection = (title, rowSpacing = 1) => {
    wsData.push([title]);
    for (let i = 0; i < rowSpacing; i++) {
      wsData.push([]);
    }
  };
  
  // Add data table with optional limits
  const addDataTable = (title, headers, dataMap, sortDesc = true, limit = null, spacing = 1) => {
    wsData.push([title]);
    wsData.push(headers);
    
    const sortedData = sortData(dataMap, sortDesc, limit);
    sortedData.forEach(([key, value]) => {
      wsData.push([key, value]);
    });
    
    for (let i = 0; i < spacing; i++) {
      wsData.push([]);
    }
    
    // Return row count for chart positioning
    return sortedData.length + 2; // headers + title + data rows
  };

  // Title and overview section
  wsData.push(["User Statistics Report", `Generated: ${moment().format("YYYY-MM-DD HH:mm:ss")}`]);
  wsData.push([]);
  wsData.push(["Overview"]);
  wsData.push(["Total Users", totalUsers]);
  wsData.push(["Active Memberships", activeMembershipCount]);
  wsData.push(["Expired Memberships", expiredCount]);
  wsData.push(["Calendar Subscribed (MMM 2025)", calendarSubscribed]);
  wsData.push([]);
  wsData.push([]);
  
  // Membership Status
  addSection("Membership Status");
  addDataTable("Status Distribution", ["Status", "Count"], byStatus, true, null, 2);
  
  // Subscription Types
  addSection("Subscription Types");
  addDataTable("Subscription Distribution", ["Type", "Count"], bySubscriptionType, true, null, 2);
  
  // Demographics
  addSection("Demographics");
  addDataTable("Age Distribution", ["Age Group", "Count"], byAgeBucket, false, null, 2);
  
  // Regions
  addSection("Regional Distribution");
  addDataTable("Members by Region", ["Region", "Count"], byRegion, true, null, 2);
  
  // Universities
  addSection("Educational Institutions");
  addDataTable("Top Universities", ["University", "Count"], byUniversity, true, 15, 2);
  
  // Courses/Specialties (NEW)
  addSection("Student Specialties");
  addDataTable("Top Fields of Study", ["Field/Course", "Count"], byCourse, true, 15, 2);
  
  // Purchase Year
  addSection("Membership Acquisition");
  addDataTable("Members by Purchase Year", ["Year", "Count"], byPurchaseYear, false, null, 0);

  // Create the worksheet from our data
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  
  // Add column width metadata
  ws['!cols'] = [
    { wch: 30 }, // Column A width
    { wch: 15 }, // Column B width
  ];
  
  XLSX.utils.book_append_sheet(wb, ws, "User Statistics");

  const filename = `user_stats_${moment().format("YYYY-MM-DD_HHmmss")}.xls`;
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xls" });
  const mime = "application/vnd.ms-excel";

  return { buffer, filename, mime };
};