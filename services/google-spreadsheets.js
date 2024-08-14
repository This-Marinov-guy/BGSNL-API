import { MongoClient, ObjectId } from 'mongodb';
import { google } from 'googleapis';
import { BGSNL_MEMBERS_SPREADSHEETS_ID, SPREADSHEETS_ID } from '../util/config/SPREEDSHEATS.js';
import HttpError from '../models/Http-error.js';
import moment from 'moment';

const searchInDatabase = (eventName, region) => {
  if (SPREADSHEETS_ID[region]) {
    const spreadsheetId = SPREADSHEETS_ID[region]
    const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
    const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

    client.connect(err => {
      if (err) {
        console.error('Error connecting to MongoDB:', err);
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

      db.collection('events').aggregate([
        {
          $match: {
            event: eventName
          }
        },
        {
          $project: {
            _id: 0,
            guests: {
              $map: {
                input: "$guestList",
                as: "guest",
                in: {
                  index: { $add: [{ $indexOfArray: ["$guestList", "$$guest"] }, 1] }, // Get the index + 1
                  name: "$$guest.name",
                  surname: "$$guest.surname",
                  type: "$$guest.type"
                }
              }
            }
          }
        }
      ]).toArray((err, result) => {
        if (err) {
          console.error("Error:", err);
          return;
        }

        if (result.length > 0) {
          // Event found
          console.log(eventName)
          console.log(result[0].guests);
        } else {
          console.log("Event not found.");
        }
      });

    })
  }
}

const eventToSpreadsheet = async (id) => {
  const event = await Event.findById(id);

  if (!event) {
    return;
  }

  const { region, date, title, status, time, location, ticketTimer, ticketLimit, entry, memberEntry, activeMemberEntry } = event;
  const ticketLink = event.ticketLink ?? 'none'

  if (SPREADSHEETS_ID[region]?.events) {
    const spreadsheetId = SPREADSHEETS_ID[region].events;

    // Connecting to Google Spreadsheet
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets"
    });

    const googleClient = await auth.getClient();
    const googleSheets = google.sheets({ version: 'v4', auth: googleClient });

    const metaData = await googleSheets.spreadsheets.get({
      auth,
      spreadsheetId,
    });

    const sheetName = `${title}|${date}`;
    const sheetsList = metaData.data.sheets;
    const sheetExists = sheetsList.some((sheet) => sheet.properties.title === sheetName);

    if (!sheetExists) {
      // Create the sheet if it doesn't exist
      await googleSheets.spreadsheets.batchUpdate({
        auth,
        spreadsheetId,
        resource: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: sheetName,
                },
              },
            },
          ],
        },
      });

      console.log(`Sheet '${sheetName}' has been created.`);
    }

    // Connecting to MongoDb
    const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
    const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

    client.connect(async (err) => {
      if (err) {
        console.error('Error connecting to MongoDB:', err);
        return;
      }

      const db = client.db();
      const result = await db.collection('events').aggregate([
        { $match: { _id: ObjectId(id) } },
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
                  ticket: "$$guest.ticket"
                }
              }
            }
          }
        }
      ]).toArray();

      if (result.length > 0) {
        const eventDetails = [
          ["Status", "Region", "Title", "Date", "Time", "Location", "Ticket Timer", "Ticket Limit", "Price", "Member Price", "Active Member Price", "Ticket Link"],
          [status, region, title, moment(date).format("D MMM YYYY"), moment(time).format("h:mm:ss a"), location, moment(ticketTimer).format("D MMM YYYY , h:mm:ss a"), ticketLimit, entry, memberEntry, activeMemberEntry, ticketLink]
        ];

        const guestListHeaders = ["Status", "Type", "Timestamp", "Name", "Email", "Phone", "Preferences", "Ticket"];
        const guests = result[0].guests.map((obj) => guestListHeaders.map(header => obj[header]));

        const values = [
          ...eventDetails,
          [],
          ["Guest List", "Presence", guests.length],
          guestListHeaders,
          ...guests
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
            values
          }
        });

        console.log('Event Updated!');
      } else {
        console.log("Event not found.");
      }

      // Apply conditional formatting
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
                      sheetId: sheetsList.find(sheet => sheet.properties.title === sheetName).properties.sheetId,
                      startRowIndex: startRow,
                      endRowIndex: endRow,
                      startColumnIndex: 0,
                      endColumnIndex: guestListHeaders.length,
                    },
                  ],
                  booleanRule: {
                    condition: {
                      type: 'CUSTOM_FORMULA',
                      values: [
                        { userEnteredValue: '=INDIRECT("R[0]C1", FALSE) = 1' },
                      ],
                    },
                    format: {
                      backgroundColor: {
                        red: 0.0,
                        green: 1.0,
                        blue: 0.0,
                      },
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

      client.close();
    });
  }
};

const usersToSpreadsheet = async (region = null) => {

  let spreadsheetId = BGSNL_MEMBERS_SPREADSHEETS_ID;
  let filterByRegion = false;

  if (region && SPREADSHEETS_ID[region].users) {
    spreadsheetId = SPREADSHEETS_ID[region].users;
    filterByRegion = true;
  }

  const sheetName = 'Members';

  // Connecting to Google Spreadsheet
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: "https://www.googleapis.com/auth/spreadsheets"
  });

  const googleClient = await auth.getClient();

  const googleSheets = google.sheets({ version: 'v4', auth: googleClient })

  // Connecting to MongoDb
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

  client.connect(err => {
    if (err) {
      console.error('Error connecting to MongoDB:', err);
      return;
    }

    const db = client.db();

    const collection = db.collection('users');

    collection.find({}).toArray(async (err, users) => {
      if (err) {
        console.log('Error while writing in db')
      }

      else {

        let usersArray = users

        if (filterByRegion) {
          usersArray = users.filter((user) => { return user.region === region })
        }

        const values = usersArray.map((user) => {
          let { _id, image, university, otherUniversityName, course, studentNumber, graduationDate, password, notificationTypeTerms, tickets, registrationKey, __v, christmas, region, subscription, roles, ...rest } = user;
          birth = moment(birth).format("D MMM YYYY");
          rest.purchaseDate = moment(rest.purchaseDate).format("D MMM YYYY");
          rest.expireDate = moment(rest.expireDate).format("D MMM YYYY");
          let dataFields;

          if (filterByRegion) {
            dataFields = {
              ...rest,
              university: university === 'other' ? otherUniversityName : university,
              course,
              studentNumber,
              graduationDate: graduationDate || 'not specified'
            }
          } else {
            dataFields = {
              region,
              ...rest,
              university: university === 'other' ? otherUniversityName : university,
              course,
              studentNumber,
              graduationDate: graduationDate || 'not specified'
            };
          }

          return dataFields
        }).map((obj) => Object.values(obj))
        await googleSheets.spreadsheets.values.clear({
          auth,
          spreadsheetId,
          range: sheetName,
        })

        let nameOfValues

        if (filterByRegion) {
          nameOfValues = ["Status", "Purchase Date", "Renew Date", "Name", "Surname", "Birth", "Phone", "Email", "University", "Course", "Student Number", "Graduation Date"];
        } else {
          nameOfValues = ["Region", "Status", "Purchase Date", "Renew Date", "Name", "Surname", "Birth", "Phone", "Email", "University", "Course", "Student Number", "Graduation Date"];
        }


        await googleSheets.spreadsheets.values.append({
          auth,
          spreadsheetId,
          range: sheetName,
          valueInputOption: "RAW",
          resource: {
            values: [
              ["Members of:", sheetName],
              nameOfValues,
              ...values
            ]
          }
        })
      }
    });

  })

}

export { searchInDatabase, eventToSpreadsheet, usersToSpreadsheet };