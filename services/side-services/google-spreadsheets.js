import { MongoClient, ObjectId } from "mongodb";
import { google } from "googleapis";
import {
  BGSNL_MEMBERS_SPREADSHEETS_ID,
  CLONE_SHEETS,
  SPREADSHEETS_ID,
} from "../../util/config/SPREEDSHEATS.js";
import mongoose from "mongoose";
import moment from "moment-timezone";
import Event from "../../models/Event.js";
import { BGSNL_URL, REGIONS } from "../../util/config/defines.js";
import User from "../../models/User.js";
import { refactorToKeyValuePairs } from "../../util/functions/helpers.js";

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

          if (result.length > 0) {
            // Event found
            console.log(eventName);
            console.log(result[0].guests);
          } else {
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
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
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
      ],
      [
        status,
        region,
        title,
        moment(correctedDate ?? date).format("D MMM YYYY hh:mm a"),
        location,
        moment(ticketTimer).format("D MMM YYYY , hh:mm a"),
        ticketLimit,
        product?.guest.price ?? "-",
        product?.member.price ?? "-",
        product?.activeMember.price ?? "-",
        ticketLink,
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
      "Ticket",
    ];
    const guests = result[0].guests.map((obj) => [
      obj.status === 1 ? "present" : "missing",
      obj.type,
      moment(obj.timestamp).format("D MMM YYYY, hh:mm:ss a"),
      obj.name,
      obj.email,
      obj.phone,
      obj.preferences ? refactorToKeyValuePairs(obj.preferences) : "N/A",
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

const usersToSpreadsheet = async (region = null) => {
  try {
    let spreadsheetId = BGSNL_MEMBERS_SPREADSHEETS_ID;
    const filterByRegion = region && SPREADSHEETS_ID[region]?.users;

    if (filterByRegion) {
      spreadsheetId = SPREADSHEETS_ID[region].users;
    }

    const sheetName = "Members";

    // Connecting to Google Spreadsheet
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets",
    });

    const googleClient = await auth.getClient();
    const googleSheets = google.sheets({ version: "v4", auth: googleClient });

    // Fetch users from MongoDB using Mongoose
    const query = filterByRegion ? { region } : {};
    const users = await User.find(query).lean();

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

      const formattedBirth = moment(new Date(birth)).format("D MMM YYYY");
      const formattedPurchaseDate = moment(rest.purchaseDate).format(
        "D MMM YYYY"
      );
      const formattedExpireDate = moment(rest.expireDate).format("D MMM YYYY");

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

export { searchInDatabase, eventToSpreadsheet, usersToSpreadsheet };
