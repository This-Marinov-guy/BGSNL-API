import { MongoClient } from "mongodb";
import { google } from "googleapis";
import {
  CLONE_SHEETS,
  PWC_EVENT_SPREADSHEET,
  SPREADSHEETS_ID,
} from "../../util/config/SPREEDSHEATS.js";
import dotenv from "dotenv";
dotenv.config();
import moment from "moment-timezone";
import Event from "../../models/Event.js";
import { BGSNL_URL } from "../../util/config/defines.js";
import MemberUser from "../../models/MemberUser.js";
import {
  IS_PROD,
  refactorToKeyValuePairs,
} from "../../util/functions/helpers.js";
import {
  MOMENT_DATE_TIME_YEAR,
  MOMENT_DATE_YEAR,
} from "../../util/functions/dateConvert.js";
import NonSocietyEvent from "../../models/NonSocietyEvent.js";
import AlumniUser from "../../models/AlumniUser.js";
import InternshipApplication from "../../models/InternshipApplication.js";
import { ALUMNI_MIGRATED } from "../../util/config/enums.js";
import { INTERNSHIP_SHEET } from "../../util/config/SPREEDSHEATS.js";
import { enqueueSpreadsheetSync } from "../jobs/spreadsheet-sync-queue.js";
import { publishGuestListChanged } from "../tickets/guest-list-live.js";
import { logIntegrationError, logOperationalError } from "../../middleware/axiom-logger.js";
import { jobNameFromKey, observeJob } from "../monitoring/job-history.js";
import { writeEventGuestSheet } from "./event-guest-sheet.js";

// Lightweight background job queue with concurrency limit and de-duplication
const MAX_CONCURRENCY = 1;
const MAX_QUEUE_LENGTH = 100; // backpressure guard
const JOB_TIMEOUT_MS = 120000; // 2 minutes safety timeout per job
const jobQueue = [];
const activeKeys = new Set();
let activeCount = 0;

function processQueue() {
  if (activeCount >= MAX_CONCURRENCY) return;
  const next = jobQueue.shift();
  if (!next) return;
  activeCount++;
  (async () => {
    next.record.start();
    try {
      // enforce timeout so stuck jobs don't block the queue indefinitely
      await Promise.race([
        next.jobFn(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Job timeout: ${next.key}`)),
            JOB_TIMEOUT_MS
          )
        ),
      ]);
      next.record.complete();
    } catch (e) {
      next.record.fail(e);
      logIntegrationError("google-sheets", e, "background-job");
      console.error("Background job error", { code: e?.code });
    } finally {
      activeKeys.delete(next.key);
      activeCount--;
      setImmediate(processQueue);
    }
  })();
}

function enqueueJob(key, jobFn) {
  if (activeKeys.has(key)) return; // de-duplicate
  if (jobQueue.length >= MAX_QUEUE_LENGTH) {
    // Drop oldest to keep memory bounded; alternatively drop newest
    const dropped = jobQueue.shift();
    dropped.record.fail(new Error("Spreadsheet queue full"));
    activeKeys.delete(dropped.key);
    logOperationalError("worker.spreadsheet-queue", new Error("Queue full"));
    console.warn("Spreadsheet queue full, dropping oldest job");
  }
  activeKeys.add(key);
  jobQueue.push({ key, jobFn, record: observeJob("sheets-inline", jobNameFromKey(key)) });
  processQueue();
}

// Singleton Sheets client to avoid re-creating auth and sockets per job
let sheetsClientPromise = null;
async function getSheetsClient() {
  if (sheetsClientPromise) return sheetsClientPromise;
  sheetsClientPromise = (async () => {
    const credentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS
    );
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });
    const googleClient = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: googleClient });
    return { auth: googleClient, googleSheets };
  })().catch((error) => {
    sheetsClientPromise = null;
    throw error;
  });
  return sheetsClientPromise;
}

const searchInDatabase = (eventName, region) => {
  if (SPREADSHEETS_ID[region]) {
    const spreadsheetId = SPREADSHEETS_ID[region];
    const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
    const client = new MongoClient(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    client.connect((err) => {
      if (err) {
        logOperationalError("service.spreadsheet-database-connect", err);
        console.error("Error connecting to MongoDB:", err);
        return;
      }

      const db = client.db();

      // const usersCollection = db.collection('users');

      // // Fetch all documents in the "users" collection
      // usersCollection.find({
      //     // $or: [
      //     //     { expireDate: '31 Aug 2024' },
      //     //     { expireDate: '31 Aug 2023' }
      //     // ]
      // }).toArray((err, users) => {
      //     if (err) {
      //         console.error('Error fetching documents:', err);
      //         return;
      //     }

      //     // Extract email values from the user documents
      //     const emails = users.map(user => user.email);
      //     console.log('Emails:', emails);
      // })

      db.collection("events")
        .aggregate([
          {
            $match: {
              event: eventName,
            },
          },
          {
            $project: {
              _id: 0,
              guests: {
                $map: {
                  input: "$guestList",
                  as: "guest",
                  in: {
                    index: {
                      $add: [{ $indexOfArray: ["$guestList", "$$guest"] }, 1],
                    }, // Get the index + 1
                    name: "$$guest.name",
                    surname: "$$guest.surname",
                    type: "$$guest.type",
                  },
                },
              },
            },
          },
        ])
        .toArray((err, result) => {
          if (err) {
            logOperationalError("service.spreadsheet-database-query", err);
            console.error("Error:", err);
            return;
          }

          if (result.length <= 0) {
            console.log("Event not found.");
          }
        });
    });
  }
};

export const syncEventToSpreadsheet = async ({ id }, {
  getClient = getSheetsClient,
  findEvent = (eventId) => Event.findById(eventId),
  writeSheet = writeEventGuestSheet,
} = {}) => {
    const { auth, googleSheets } = await getClient();
    try {
      const event = await findEvent(id);

      if (!event) {
        console.log("Event not found.");
        return;
      }

      const {
        region,
        date,
        title,
        correctedDate,
        status,
        location,
        ticketTimer,
        ticketLimit,
        product,
        sheetName,
        createdAt = "-",
      } = event;

      let ticketLink = event.ticketLink ?? null;

      if (!ticketLink) {
        ticketLink = BGSNL_URL + region + "/event-details/" + event.id;
      }

      const spreadsheetIds = [];

      // Always add the original spreadsheet ID based on region
      if (SPREADSHEETS_ID[region]?.events) {
        spreadsheetIds.push(SPREADSHEETS_ID[region].events);
      } else {
        console.log(`No spreadsheet ID found for region: ${region}`);
      }

      // If the event ID exists in CLONE_SHEETS, add the cloned spreadsheet ID
      if (CLONE_SHEETS[id]) {
        spreadsheetIds.push(CLONE_SHEETS[id]);
        console.log(`Also updating cloned spreadsheet for ID: ${id}`);
      }

      if (spreadsheetIds.length === 0) throw new Error(`No event spreadsheet is configured for region: ${region}`);

      // Prepare event and guest data
      const eventDetails = [
        [
          "ID",
          "Status",
          "Region",
          "Title",
          "Date",
          "Location",
          "Ticket Timer",
          "Ticket Limit",
          "Price",
          "Member Price",
          "Active Member Price",
          "Ticket Link",
          "Created At",
        ],
        [
          id,
          status,
          region,
          title,
          moment(correctedDate ?? date)
            .tz("Europe/Amsterdam")
            .format(MOMENT_DATE_TIME_YEAR),
          location,
          moment(ticketTimer)
            .tz("Europe/Amsterdam")
            .format(MOMENT_DATE_TIME_YEAR),
          ticketLimit,
          product?.guest.price ?? "-",
          product?.member.price ?? "-",
          product?.activeMember.price ?? "-",
          ticketLink,
          createdAt != "-"
            ? moment(createdAt)
                .tz("Europe/Amsterdam")
                .format(MOMENT_DATE_TIME_YEAR)
            : "-",
        ],
      ];

      const guestListHeaders = [
        "Status",
        "Type",
        "Timestamp",
        "Name",
        "Email",
        "Phone",
        "Preferences",
        "AddOns",
        "Ticket",
        "Transaction Id",
      ];
      const guests = (event.guestList || []).map((obj) => [
        obj.status === 1 ? "present" : "missing",
        obj.type,
        moment(obj.timestamp).format(MOMENT_DATE_TIME_YEAR),
        obj.name,
        obj.email,
        obj.phone,
        obj.preferences ? refactorToKeyValuePairs(obj.preferences) : "N/A",
        obj.addOns?.length
          ? obj.addOns
              .map(
                (item) =>
                  `${item.title} ${item.price ? item.price + " euro" : "Free"}`
              )
              .join(" + ")
          : "N/A",
        obj.ticket,
        obj.transactionId ?? "-",
      ]);

      const values = [
        ...eventDetails,
        [],
        ["Guest List", "Presence", guests.length],
        guestListHeaders,
        ...guests,
      ];

      for (const spreadsheetId of [...new Set(spreadsheetIds)]) {
        await writeSheet({ googleSheets, auth, spreadsheetId, sheetName, values,
          guestCount: guests.length });
        console.log(`Event data updated in spreadsheet: ${spreadsheetId}`);
      }
    } catch (error) {
      console.error("Error in eventToSpreadsheet:", error);
      throw error;
    }
};

export const syncSpecialEventToSpreadsheet = async ({ id }, {
  getClient = getSheetsClient,
  findEvent = (eventId) => NonSocietyEvent.findById(eventId),
  writeSheet = writeEventGuestSheet,
} = {}) => {
    const { auth, googleSheets } = await getClient();
    try {
      const nonSocietyEvent = await findEvent(id);

      if (!nonSocietyEvent) {
        console.log("Event not found.");
        return;
      }

      const {
        event,
        date,
        referenceCode,
        timezone = "Europe/Amsterdam",
      } = nonSocietyEvent;

      const sheetName = `${event} | ${moment(date)
        .tz(timezone)
        .format(MOMENT_DATE_YEAR)}`;

      const spreadsheetIds = [SPREADSHEETS_ID["netherlands"].events];

      if (IS_PROD && referenceCode === "4DEFC47D72") {
        spreadsheetIds.push(PWC_EVENT_SPREADSHEET);
      }

      // Prepare event and guest data
      const eventDetails = [
        ["ID", "Reference Code", "Title", "Date"],
        [
          id,
          referenceCode ?? "-",
          event,
          moment(date).tz(timezone).format(MOMENT_DATE_TIME_YEAR),
        ],
      ];

      const guestListHeaders = [
        "ID",
        "Timestamp",
        "Name",
        "Email",
        "Phone",
        "University",
        "Specialty",
        "Questions",
        "Extra Data",
        "Ticket",
        "Transaction Id",
      ];
      const guests = (nonSocietyEvent.guestList || []).map((obj) => [
        obj.userId ?? "-",
        moment(obj.timestamp)
          .tz(timezone)
          .format(MOMENT_DATE_TIME_YEAR),
        obj.name,
        obj.email,
        obj.phone,
        obj.university ?? "-",
        obj.course ?? "-",
        obj.questions ?? "-",
        obj.extraData ?? "N/A",
        obj.ticket,
        obj.transactionId ?? "-",
      ]);

      const values = [
        ...eventDetails,
        [],
        ["Guest List", "Presence", guests.length],
        guestListHeaders,
        ...guests,
      ];

      for (const spreadsheetId of [...new Set(spreadsheetIds)]) {
        await writeSheet({ googleSheets, auth, spreadsheetId, sheetName, values,
          guestCount: guests.length, formatPresence: false });
        console.log(`Event data updated in spreadsheet: ${spreadsheetId}`);
      }
    } catch (err) {
      console.log(err);
      throw err;
    }
};

export const syncUsersToSpreadsheet = async ({ region = null } = {}) => {
    const { auth, googleSheets } = await getSheetsClient();
    try {
      let spreadsheetId = SPREADSHEETS_ID["netherlands"]?.users;
      const filterByRegion =
        IS_PROD && region && SPREADSHEETS_ID[region]?.users;

      if (filterByRegion) {
        spreadsheetId = SPREADSHEETS_ID[region].users;
      }

      const sheetName = "Members";

      // Sheets client comes from singleton

      // Fetch users from MongoDB using Mongoose
      const query = {
        ...(filterByRegion && { region }),
        status: { $nin: [ALUMNI_MIGRATED, "membership-migrated", "membership_active"] },
      };

      const users = await MemberUser.find(query)
        .sort({
          purchaseDate: 1,
          _id: -1,
        })
        .lean();

      const values = users.map((user) => {
        const {
          _id,
          image,
          university,
          otherUniversityName,
          course,
          studentNumber,
          graduationDate,
          profession,
          password,
          notificationTypeTerms,
          tickets,
          registrationKey,
          __v,
          christmas,
          mmmCampaign2025,
          region,
          subscription,
          status,
          name,
          surname,
          birth,
          roles,
          joinDate,
          documents,
          internshipApplications,
          ...rest
        } = user;

        const formattedBirth = moment(new Date(birth)).format(MOMENT_DATE_YEAR);
        const formattedPurchaseDate = moment(rest.purchaseDate).format(
          MOMENT_DATE_YEAR
        );
        const formattedExpireDate = moment(rest.expireDate).format(
          MOMENT_DATE_YEAR
        );

        const dataFields = {
          ...(filterByRegion ? {} : { region }),
          status,
          type:
            subscription && subscription.id
              ? `Subscription ${subscription.id} | Customer ${
                  subscription.customerId ?? ""
                }`
              : "One-time (old)",
          name,
          surname,
          ...rest,
          birth: formattedBirth,
          purchaseDate: formattedPurchaseDate,
          expireDate: formattedExpireDate,
          university:
            university === "other"
              ? otherUniversityName
              : university === "working"
                ? "Working"
                : university,
          profession:
            university === "working" ? profession || "not specified" : "",
          course,
          studentNumber,
          graduationDate: graduationDate || "not specified",
          ...(filterByRegion ? {} : { roles: roles.join(", ") }),
        };

        // Convert all values to strings to avoid Google Sheets errors with objects/arrays
        return Object.values(dataFields).map((value) => {
          if (value === null || value === undefined) {
            return "";
          }
          if (typeof value === "object") {
            return JSON.stringify(value);
          }
          return String(value);
        });
      });

      const nameOfValues = filterByRegion
        ? [
            "Status",
            "Type",
            "Name",
            "Surname",
            "Purchase Date",
            "Expire/Renew Date",
            "Phone",
            "Email",
            "Birth",
            "University",
            "Profession",
            "Course",
            "Student Number",
            "Graduation Date",
          ]
        : [
            "Region",
            "Status",
            "Type",
            "Name",
            "Surname",
            "Purchase Date",
            "Expire/Renew Date",
            "Phone",
            "Email",
            "Birth",
            "University",
            "Profession",
            "Course",
            "Student Number",
            "Graduation Date",
            "Roles",
          ];

      const allUserValues = [["Members of:", sheetName], nameOfValues, ...values];

      await googleSheets.spreadsheets.values.update({
        auth,
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        resource: { values: allUserValues },
      });

      await googleSheets.spreadsheets.values.clear({
        auth,
        spreadsheetId,
        range: `${sheetName}!A${allUserValues.length + 1}:ZZ`,
      });

      console.log(`Member Sheet updated for: ${region ?? "Netherlands"}`);
    } catch (error) {
      console.error("Error in usersToSpreadsheet:", error);
      throw error;
    }
};

export const syncAlumniToSpreadsheet = async () => {
    const { auth, googleSheets } = await getSheetsClient();
    try {
      let spreadsheetId = SPREADSHEETS_ID["netherlands"]?.alumni;
      const sheetName = "Alumnis";

      // Sheets client comes from singleton

      // Fetch users from MongoDB using Mongoose
      const query = { status: { $nin: ["alumni-migrated", "membership-migrated", "membership_active"] } };
      const users = await AlumniUser.find(query)
        .sort({
          purchaseDate: 1,
          _id: -1,
        })
        .lean();

      const rows = users.map((user) => {
        const {
          _id,
          image,
          password,
          tickets,
          registrationKey,
          __v,
          christmas,
          mmmCampaign2025,
          subscription,
          email,
          tier,
          status,
          name,
          surname,
          ...rest
        } = user;

        const formattedPurchaseDate = moment(rest.purchaseDate).format(
          MOMENT_DATE_YEAR
        );
        const formattedExpireDate = moment(rest.expireDate).format(
          MOMENT_DATE_YEAR
        );

        const dataFields = {
          status,
          subscription: subscription?.id
            ? `Subscription ${subscription.id} | Customer ${
                subscription.customerId ?? ""
              }`
            : "Migrated Free tier",
          tier: `${tier}`,
          name,
          surname,
          purchaseDate: formattedPurchaseDate,
          expireDate: formattedExpireDate,
          email,
        };

        const values = Object.values(dataFields).map((value) => {
          if (Array.isArray(value)) {
            return value.join(", ");
          }
          return String(value || "");
        });

        const isFree = !(subscription && subscription.id);
        return { values, isFree };
      });

      const freeRows = rows.filter((r) => r.isFree).map((r) => r.values);
      const paidRows = rows.filter((r) => !r.isFree).map((r) => r.values);
      const values = [...freeRows, ...paidRows];

      const nameOfValues = [
        "Status",
        "Subscription",
        "Tier",
        "Name",
        "Surname",
        "Purchase Date",
        "Expire/Renew Date",
        "Email",
      ];

      const allAlumniValues = [["Members of:", sheetName], nameOfValues, ...values];

      await googleSheets.spreadsheets.values.update({
        auth,
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        resource: { values: allAlumniValues },
      });

      await googleSheets.spreadsheets.values.clear({
        auth,
        spreadsheetId,
        range: `${sheetName}!A${allAlumniValues.length + 1}:ZZ`,
      });

      const meta = await googleSheets.spreadsheets.get({
        auth,
        spreadsheetId,
      });
      const sheetId = meta.data.sheets.find(
        (s) => s.properties.title === sheetName
      )?.properties.sheetId;

      if (sheetId && freeRows.length > 0) {
        const startRowIndex = 2;
        const endRowIndex = startRowIndex + freeRows.length;
        const endColumnIndex = nameOfValues.length;

        await googleSheets.spreadsheets.batchUpdate({
          auth,
          spreadsheetId,
          resource: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex,
                    endRowIndex,
                    startColumnIndex: 0,
                    endColumnIndex,
                  },
                  cell: {
                    userEnteredFormat: {
                      backgroundColor: { red: 0.7, green: 0.7, blue: 0.7 },
                    },
                  },
                  fields: "userEnteredFormat.backgroundColor",
                },
              },
            ],
          },
        });
      }

      console.log(`Member Sheet updated for Alumnis`);
    } catch (error) {
      console.error("Error in alumniToSpreadsheet:", error);
      throw error;
    }
};

/**
 * Reads rows from a Google Spreadsheet
 * @param {Object} auth - Authorized Google client
 * @param {string} spreadsheetId - ID of the spreadsheet
 * @param {string} sheetName - Name of the sheet
 * @param {number} startRow - Starting row number (1-based)
 * @param {number} endRow - Ending row number (1-based)
 * @returns {Promise<Array>} Array of row values
 */
export const readSpreadsheetRows = async (
  spreadsheetId,
  sheetName,
  startRow = "",
  endRow = ""
) => {
  try {
    // Connecting to Google Spreadsheet
    const credentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS
    );
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });

    const sheets = google.sheets({ version: "v4", auth });

    if (!startRow) {
      startRow = "A2"; // Default starting row
    }

    if (!endRow) {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: `${sheetName}!A:A`,
      });

      const lastRow = data.values[0]; // Get first row
      const lastEmptyColumnIndex = lastRow.length + 2; // 1-based index
      const lastEmptyColumnLetter = String.fromCharCode(
        64 + lastEmptyColumnIndex
      );

      endRow = `${lastEmptyColumnLetter}${data.values?.length + 1}`;
    }

    // Construct range (e.g., 'Sheet1!A2:Z5')
    const range = `${sheetName}!${startRow}:${endRow}`;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return (response.data.values || [])
      .flat()
      .filter((value) => value !== null && value !== "");
  } catch (error) {
    console.error("Error reading spreadsheet:", error);
    throw error;
  }
};

export const getPresenceStatsOfCity = async (spreadsheetId) => {
  const credentials = JSON.parse(
    process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS
  );
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: "https://www.googleapis.com/auth/spreadsheets",
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Get all sheets metadata
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetInfos = meta.data.sheets;

  let presenceCounts = [];
  let numericPresences = [];
  let totalPresence = 0;

  for (const sheet of sheetInfos) {
    const sheetName = sheet.properties.title;

    const { data: title } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!C2`,
    });

    const { data: presenceData } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!C4`,
    });

    const presenceString =
      (presenceData.values &&
      presenceData.values[0] &&
      presenceData.values[0][0]
        ? presenceData.values[0][0]
        : null) || 0;
    presenceCounts.push({
      event: title.values[0][0],
      presence: Number(presenceString),
    });
    totalPresence += Number(presenceString);

    const num = Number(presenceString);
    if (!isNaN(num)) {
      numericPresences.push(num);
    }
  }

  const totalEvents = presenceCounts.length;
  const avgPresence = Math.round(
    numericPresences.length > 0
      ? numericPresences.reduce((a, b) => a + b, 0) / numericPresences.length
      : 0
  );

  return {
    presenceCounts,
    totalEvents,
    totalPresence,
    avgPresence,
  };
};

export const syncInternshipApplicationsToSpreadsheet = async () => {
    const { auth, googleSheets } = await getSheetsClient();
    try {
      const spreadsheetId = INTERNSHIP_SHEET;
      const sheetName = "Applications";

      // Fetch all internship applications from MongoDB
      const applications = await InternshipApplication.find({})
        .sort({
          createdAt: -1,
        })
        .lean();

      const values = applications.map((application) => {
        const {
          _id,
          userId,
          email,
          name,
          phone,
          companyId,
          companyName,
          position,
          cv,
          coverLetter,
          createdAt,
        } = application;

        const formattedCreatedAt = moment(createdAt).format(
          MOMENT_DATE_TIME_YEAR
        );

        return [
          _id.toString(),
          userId || "-",
          email,
          name,
          phone,
          companyId,
          companyName,
          position,
          cv || "-",
          coverLetter || "-",
          formattedCreatedAt,
        ];
      });

      const headers = [
        "ID",
        "User ID",
        "Email",
        "Name",
        "Phone",
        "Company ID",
        "Company Name",
        "Position",
        "CV",
        "Cover Letter",
        "Created At",
      ];

      const allInternshipValues = [["Internship Applications"], headers, ...values];

      await googleSheets.spreadsheets.values.update({
        auth,
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        resource: { values: allInternshipValues },
      });

      await googleSheets.spreadsheets.values.clear({
        auth,
        spreadsheetId,
        range: `${sheetName}!A${allInternshipValues.length + 1}:ZZ`,
      });

      console.log(`Internship applications sheet updated`);
    } catch (error) {
      console.error("Error in internshipApplicationsToSpreadsheet:", error);
      throw error;
    }
};

const eventToSpreadsheet = (id) => {
  void publishGuestListChanged(id);
  return enqueueSpreadsheetSync("event", { id });
};
const specialEventsToSpreadsheet = (id) => enqueueSpreadsheetSync("special-event", { id });
const usersToSpreadsheet = (region = null) => enqueueSpreadsheetSync("members", { region });
export const alumniToSpreadsheet = () => enqueueSpreadsheetSync("alumni");
export const internshipApplicationsToSpreadsheet = () => enqueueSpreadsheetSync("internships");

export {
  searchInDatabase,
  eventToSpreadsheet,
  specialEventsToSpreadsheet,
  usersToSpreadsheet,
  enqueueJob,
  getSheetsClient,
};
