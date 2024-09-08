import { MongoClient, ObjectId } from 'mongodb';
import { google } from 'googleapis';
import { BGSNL_MEMBERS_SPREADSHEETS_ID, SPREADSHEETS_ID } from '../../util/config/SPREEDSHEATS.js';
import moment from 'moment-timezone';
import Event from '../../models/Event.js';
import { REGIONS } from '../../util/config/defines.js';

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

  const { region, date, title, correctedDate, status, location, ticketTimer, ticketLimit, product, sheetName } = event;
  const ticketLink = event.ticketLink ?? 'none';

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

    const sheetsList = metaData.data.sheets;
    let sheetId;
    const sheetExists = sheetsList.some((sheet) => {
      if (sheet.properties.title === sheetName) {
        sheetId = sheet.properties.sheetId;  // Get the numeric sheetId
        return true;
      }
      return false;
    });

    if (!sheetExists) {
      // Create the sheet if it doesn't exist
      const newSheet = await googleSheets.spreadsheets.batchUpdate({
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
      sheetId = newSheet.data.replies[0].addSheet.properties.sheetId;  // Get sheetId of the newly created sheet
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

      let guestListHeaders;
      let guests;

      if (result.length > 0) {
        const eventDetails = [
          ["Status", "Region", "Title", "Date", "Location", "Ticket Timer", "Ticket Limit", "Price", "Member Price", "Active Member Price", "Ticket Link"],
          [status, region, title, moment(correctedDate ?? date).format("D MMM YYYY hh:mm a"), location, moment(ticketTimer).format("D MMM YYYY , hh:mm a"), ticketLimit, product?.guest.price ?? '-', product?.member.price ?? '-', product?.activeMember.price ?? '-', ticketLink]
        ];

        guestListHeaders = ["Status", "Type", "Timestamp", "Name", "Email", "Phone", "Preferences", "Ticket"];
        guests = result[0].guests.map((obj) => [
          obj.status === 1 ? 'present' : 'missing',
          obj.type,
          moment(obj.timestamp).format("D MMM YYYY, hh:mm:ss a"),
          obj.name,
          obj.email,
          obj.phone,
          obj.preferences || "N/A",  // Assuming 'preferences' might not exist for all guests
          obj.ticket
        ]);

        // fix if no guests
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

      if (guests && guests.length) {
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
                        startRowIndex: startRow ,  
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

        try {
          await googleSheets.spreadsheets.batchUpdate(formattingRequest);
          console.log('Conditional formatting applied successfully.');
        } catch (err) {
          console.error('Error applying conditional formatting:', err);
        }
      }

      client.close();
    });
  }
};


const usersToSpreadsheet = async (region = null) => {

  let spreadsheetId = BGSNL_MEMBERS_SPREADSHEETS_ID;
  let filterByRegion = false;

  if (region && SPREADSHEETS_ID[region]?.users) {
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
          let { _id, image, university, otherUniversityName, course, studentNumber, graduationDate, password, notificationTypeTerms, tickets, registrationKey, __v, christmas, region, subscription, status, name, surname, birth, roles, ...rest } = user;
          birth = moment(new Date(birth)).format("D MMM YYYY");
          rest.purchaseDate = moment(rest.purchaseDate).format("D MMM YYYY");
          rest.expireDate = moment(rest.expireDate).format("D MMM YYYY");
          let dataFields;

          if (filterByRegion) {
            dataFields = {
              status,
              type: subscription && subscription.id ? 'Subscription' : 'One-time (old)',
              name,
              surname,
              ...rest,
              birth,
              university: university === 'other' ? otherUniversityName : university,
              course,
              studentNumber,
              graduationDate: graduationDate || 'not specified'
            }
          } else {
            dataFields = {
              region,
              status,
              type: subscription && subscription.id ? 'Subscription' : 'One-time (old)',
              name,
              surname,
              ...rest,
              birth,
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
          nameOfValues = ["Status", "Type", "Name", "Surname", "Purchase Date", "Expire/Renew Date", "Phone", "Email", "Birth", "University", "Course", "Student Number", "Graduation Date"];
        } else {
          nameOfValues = ["Region", "Status", "Type", "Name", "Surname", "Purchase Date", "Expire/Renew Date", "Phone", "Email", "Birth", "University", "Course", "Student Number", "Graduation Date"];
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

        console.log(`Member Sheet updated for: ${region ?? 'Netherlands'}`);
      }
    });

  })

}

export { searchInDatabase, eventToSpreadsheet, usersToSpreadsheet };

