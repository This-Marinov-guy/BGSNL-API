import * as XLSX from "xlsx";
import moment from "moment-timezone";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";

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
  const today = moment();
  
  // Fetch regular users with active (non-expired) memberships only
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

  // Filter out expired memberships (free tier)
  const activeUsers = users.filter(u => u.expireDate && moment(u.expireDate).isAfter(today));

  // Fetch alumni users with tier > 0 (paid tier) and active memberships only
  const alumniUsers = await AlumniUser.find(filter, {
    status: 1,
    roles: 1,
    subscription: 1,
    purchaseDate: 1,
    expireDate: 1,
    tier: 1,
  })
    .sort({ _id: -1 })
    .lean();

  // Separate paid alumni from free tier alumni
  const paidAlumni = alumniUsers.filter(a => 
    a.tier > 0 && a.expireDate && moment(a.expireDate).isAfter(today)
  );
  
  const freeAlumni = alumniUsers.filter(a => a.tier === 0);

  const totalUsers = activeUsers.length;
  const totalPaidAlumni = paidAlumni.length;
  const totalFreeAlumni = freeAlumni.length;
  const totalAll = totalUsers + totalPaidAlumni + totalFreeAlumni;

  const byStatus = {};
  const byRegion = {};
  const byRole = {};
  const bySubscriptionType = {};
  const byAgeBucket = {};
  const byUniversity = {};
  const byPurchaseYear = {};
  const byCourse = {};
  const byUserType = { 
    "Members (Active)": totalUsers, 
    "Alumni (Paid Tier)": totalPaidAlumni,
    "Alumni (Free Tier)": totalFreeAlumni
  };

  let calendarSubscribed = 0;

  // Process regular users (only active ones)
  for (const u of activeUsers) {
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

  // Process paid tier alumni
  for (const a of paidAlumni) {
    // status
    increment(byStatus, a.status);

    // roles
    if (Array.isArray(a.roles)) {
      for (const role of a.roles) increment(byRole, role);
    }

    // subscription type
    const hasSubscription = Boolean(a.subscription && a.subscription.id);
    increment(bySubscriptionType, hasSubscription ? "subscription" : "one-time/none");

    // purchase year
    if (a.purchaseDate) increment(byPurchaseYear, moment(a.purchaseDate).format("YYYY"));
    
    // Note: Alumni don't have region, university, course, or birth fields
  }

  // Process free tier alumni
  for (const a of freeAlumni) {
    // status
    increment(byStatus, a.status);

    // roles
    if (Array.isArray(a.roles)) {
      for (const role of a.roles) increment(byRole, role);
    }

    // subscription type
    const hasSubscription = Boolean(a.subscription && a.subscription.id);
    increment(bySubscriptionType, hasSubscription ? "subscription" : "one-time/none");

    // purchase year
    if (a.purchaseDate) increment(byPurchaseYear, moment(a.purchaseDate).format("YYYY"));
    
    // Note: Alumni don't have region, university, course, or birth fields
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
  wsData.push(["Total Users", totalAll]);
  wsData.push(["Members (Active)", totalUsers]);
  wsData.push(["Alumni (Paid Tier)", totalPaidAlumni]);
  wsData.push(["Alumni (Free Tier)", totalFreeAlumni]);
  wsData.push(["Calendar Subscribed (MMM 2025)", calendarSubscribed]);
  wsData.push(["Note: Expired member accounts excluded"]);
  wsData.push([]);
  
  // User Type Distribution
  addSection("User Type Distribution");
  addDataTable("Users by Type", ["Type", "Count"], byUserType, true, null, 2);
  
  // Demographics
  addSection("Demographics");
  wsData.push(["Note: Age data only available for Regular Users (Alumni profiles don't include birth dates)"]);
  wsData.push([]);
  addDataTable("Age Distribution", ["Age Group", "Count"], byAgeBucket, false, null, 2);
  
  // Regions
  addSection("Regional Distribution");
  wsData.push(["Note: Region data only available for Regular Users"]);
  wsData.push([]);
  addDataTable("Members by Region", ["Region", "Count"], byRegion, true, null, 2);
  
  // Universities
  addSection("Educational Institutions");
  wsData.push(["Note: University data only available for Regular Users"]);
  wsData.push([]);
  addDataTable("Top Universities", ["University", "Count"], byUniversity, true, 15, 2);
  
  // Courses/Specialties (NEW)
  addSection("Student Specialties");
  wsData.push(["Note: Course data only available for Regular Users"]);
  wsData.push([]);
  addDataTable("Top Fields of Study", ["Field/Course", "Count"], byCourse, true, 15, 2);
  
  // // Purchase Year
  // addSection("Membership Acquisition");
  // addDataTable("Members by Purchase Year", ["Year", "Count"], byPurchaseYear, false, null, 0);

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