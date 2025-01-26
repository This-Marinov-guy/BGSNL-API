import { MongoClient } from "mongodb";
import { google } from "googleapis";
import {
  CLONE_SHEETS,
  SPREADSHEETS_ID,
} from "../../util/config/SPREEDSHEATS.js";
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import moment from "moment-timezone";
import Event from "../../models/Event.js";
import { BGSNL_URL } from "../../util/config/defines.js";
import User from "../../models/User.js";
import {
  IS_PROD,
  refactorToKeyValuePairs,
} from "../../util/functions/helpers.js";
import {
  MOMENT_DATE_TIME_YEAR,
  MOMENT_DATE_YEAR,
} from "../../util/functions/dateConvert.js";
import NonSocietyEvent from "../../models/NonSocietyEvent.js";

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

const eventToSpreadsheet = async (id) => {
  try {
    const event = await Event.findById(id);

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

    if (spreadsheetIds.length === 0) {
      console.log("No spreadsheets to update.");
      return;
    }

    // Connecting to Google Sheets
    const credentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS
    );
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });

    const googleClient = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: googleClient });

    // Fetch event data and guest list from the database
    const result = await Event.aggregate([
      { $match: { _id: mongoose.Types.ObjectId(id) } },
      {
        $project: {
          _id: 0,
          guests: {
            $map: {
              input: "$guestList",
              as: "guest",
              in: {
                status: "$$guest.status",
                type: "$$guest.type",
                timestamp: "$$guest.timestamp",
                name: "$$guest.name",
                email: "$$guest.email",
                phone: "$$guest.phone",
                preferences: "$$guest.preferences",
                addOns: "$$guest.addOns",
                ticket: "$$guest.ticket",
              },
            },
          },
        },
      },
    ]);

    if (result.length === 0) {
      console.log("Event not found in database.");
      return;
    }

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
        moment(correctedDate ?? date).format(MOMENT_DATE_TIME_YEAR),
        location,
        moment(ticketTimer).format(MOMENT_DATE_TIME_YEAR),
        ticketLimit,
        product?.guest.price ?? "-",
        product?.member.price ?? "-",
        product?.activeMember.price ?? "-",
        ticketLink,
        createdAt != "-"
          ? moment(createdAt).format(MOMENT_DATE_TIME_YEAR)
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
    ];
    const guests = result[0].guests.map((obj) => [
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
    ]);

    const values = [
      ...eventDetails,
      [],
      ["Guest List", "Presence", guests.length],
      guestListHeaders,
      ...guests,
    ];

    // Loop over each spreadsheetId (original and clone, if applicable) and update the spreadsheet
    for (const spreadsheetId of spreadsheetIds) {
      const metaData = await googleSheets.spreadsheets.get({
        auth,
        spreadsheetId,
      });

      const sheetsList = metaData.data.sheets;
      let sheetId = sheetsList.find(
        (sheet) => sheet.properties.title === sheetName
      )?.properties.sheetId;

      if (!sheetId) {
        // Create the sheet if it doesn't exist
        const newSheet = await googleSheets.spreadsheets.batchUpdate({
          auth,
          spreadsheetId,
          resource: {
            requests: [{ addSheet: { properties: { title: sheetName } } }],
          },
        });

        console.log(
          `Sheet '${sheetName}' has been created in spreadsheet: ${spreadsheetId}`
        );
        sheetId = newSheet.data.replies[0].addSheet.properties.sheetId;
      }

      // Clear the existing data in the sheet
      await googleSheets.spreadsheets.values.clear({
        auth,
        spreadsheetId,
        range: sheetName,
      });

      // Append the new event and guest data
      await googleSheets.spreadsheets.values.append({
        auth,
        spreadsheetId,
        range: sheetName,
        valueInputOption: "RAW",
        resource: { values },
      });

      console.log(`Event data updated in spreadsheet: ${spreadsheetId}`);

      // Apply conditional formatting if there are guests
      if (guests.length > 0) {
        const startRow = 5; // Row number where guest list starts (1-based index)
        const endRow = startRow + guests.length; // End row number (1-based index)

        const formattingRequest = {
          spreadsheetId,
          resource: {
            requests: [
              {
                addConditionalFormatRule: {
                  rule: {
                    ranges: [
                      {
                        sheetId: sheetId,
                        startRowIndex: startRow - 1,
                        endRowIndex: endRow,
                      },
                    ],
                    booleanRule: {
                      condition: {
                        type: "CUSTOM_FORMULA",
                        values: [{ userEnteredValue: '=$A$5:$A="present"' }],
                      },
                      format: {
                        backgroundColor: { red: 0.0, green: 1.0, blue: 0.0 },
                      },
                    },
                  },
                  index: 0,
                },
              },
            ],
          },
        };

        await googleSheets.spreadsheets.batchUpdate(formattingRequest);
        console.log(
          `Conditional formatting applied successfully in spreadsheet: ${spreadsheetId}`
        );
      }
    }
  } catch (error) {
    console.error("Error in eventToSpreadsheet:", error);
  }
};

const specialEventsToSpreadsheet = async (id) => {
  try {
    const nonSocietyEvent = await NonSocietyEvent.findById(id);

    if (!nonSocietyEvent) {
      console.log("Event not found.");
      return;
    }

    const { event, date } = nonSocietyEvent;

    const sheetName = `${event} | ${moment(date).format(MOMENT_DATE_YEAR)}`;

    const spreadsheetIds = [SPREADSHEETS_ID["netherlands"].events];

    // Connecting to Google Sheets
    const credentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS
    );
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });

    const googleClient = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: googleClient });

    // Fetch event data and guest list from the database
    const result = await NonSocietyEvent.aggregate([
      { $match: { _id: mongoose.Types.ObjectId(id) } },
      {
        $project: {
          _id: 0,
          guests: {
            $map: {
              input: "$guestList",
              as: "guest",
              in: {
                user: "$$guest.user",
                userId: "$$guest.userId",
                timestamp: "$$guest.timestamp",
                name: "$$guest.name",
                email: "$$guest.email",
                phone: "$$guest.phone",
                extraData: "$$guest.extraData",
                course: "$$guest.course",
                ticket: "$$guest.ticket",
              },
            },
          },
        },
      },
    ]);

    if (result.length === 0) {
      console.log("Event not found in database.");
      return;
    }

    // Prepare event and guest data
    const eventDetails = [
      ["ID", "Title", "Date"],
      [id, event, moment(date).format(MOMENT_DATE_TIME_YEAR)],
    ];

    const guestListHeaders = [
      "ID",
      "Timestamp",
      "Name",
      "Email",
      "Phone",
      "Extra Data",
      "Course",
      "Ticket",
    ];
    const guests = result[0].guests.map((obj) => [
      obj.userId ?? "-",
      moment(obj.timestamp).format(MOMENT_DATE_TIME_YEAR),
      obj.name,
      obj.email,
      obj.phone,
      obj.extraData ?? "N/A",
      obj.course ?? "-",
      obj.ticket,
    ]);

    const values = [
      ...eventDetails,
      [],
      ["Guest List", "Presence", guests.length],
      guestListHeaders,
      ...guests,
    ];

    // Loop over each spreadsheetId (original and clone, if applicable) and update the spreadsheet
    for (const spreadsheetId of spreadsheetIds) {
      const metaData = await googleSheets.spreadsheets.get({
        auth,
        spreadsheetId,
      });

      const sheetsList = metaData.data.sheets;
      let sheetId = sheetsList.find(
        (sheet) => sheet.properties.title === sheetName
      )?.properties.sheetId;

      if (!sheetId) {
        // Create the sheet if it doesn't exist
        const newSheet = await googleSheets.spreadsheets.batchUpdate({
          auth,
          spreadsheetId,
          resource: {
            requests: [{ addSheet: { properties: { title: sheetName } } }],
          },
        });

        console.log(
          `Sheet '${sheetName}' has been created in spreadsheet: ${spreadsheetId}`
        );
        sheetId = newSheet.data.replies[0].addSheet.properties.sheetId;
      }

      // Clear the existing data in the sheet
      await googleSheets.spreadsheets.values.clear({
        auth,
        spreadsheetId,
        range: sheetName,
      });

      // Append the new event and guest data
      await googleSheets.spreadsheets.values.append({
        auth,
        spreadsheetId,
        range: sheetName,
        valueInputOption: "RAW",
        resource: { values },
      });

      console.log(`Event data updated in spreadsheet: ${spreadsheetId}`);
    }
  } catch (err) {
    console.log(err);
  }
};

const usersToSpreadsheet = async (region = null) => {
  try {
    let spreadsheetId = SPREADSHEETS_ID["netherlands"]?.users;
    const filterByRegion = IS_PROD && region && SPREADSHEETS_ID[region]?.users;

    if (filterByRegion) {
      spreadsheetId = SPREADSHEETS_ID[region].users;
    }

    const sheetName = "Members";

    // Connecting to Google Spreadsheet
    const credentials = JSON.parse(
      process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS
    );
    const auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });

    const googleClient = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: googleClient });

    // Fetch users from MongoDB using Mongoose
    const query = filterByRegion ? { region } : {};
    const users = await User.find(query)
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
        password,
        notificationTypeTerms,
        tickets,
        registrationKey,
        __v,
        christmas,
        region,
        subscription,
        status,
        name,
        surname,
        birth,
        roles,
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
        university: university === "other" ? otherUniversityName : university,
        course,
        studentNumber,
        graduationDate: graduationDate || "not specified",
        ...(filterByRegion ? {} : { roles: roles.join(", ") }),
      };

      return Object.values(dataFields);
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
          "Course",
          "Student Number",
          "Graduation Date",
          "Roles",
        ];

    await googleSheets.spreadsheets.values.clear({
      auth,
      spreadsheetId,
      range: sheetName,
    });

    await googleSheets.spreadsheets.values.append({
      auth,
      spreadsheetId,
      range: sheetName,
      valueInputOption: "RAW",
      resource: {
        values: [["Members of:", sheetName], nameOfValues, ...values],
      },
    });

    console.log(`Member Sheet updated for: ${region ?? "Netherlands"}`);
  } catch (error) {
    console.error("Error in usersToSpreadsheet:", error);
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
  startRow,
  endRow
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

export {
  searchInDatabase,
  eventToSpreadsheet,
  specialEventsToSpreadsheet,
  usersToSpreadsheet,
};
