import { MongoClient } from 'mongodb';
import { google } from 'googleapis';
import { SPREADSHEETS_ID } from './SPREEDSHEATS.js';

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

const eventToSpreadsheet = async (id, eventName, region) => {
  if (SPREADSHEETS_ID[region].events) {
    const spreadsheetId = SPREADSHEETS_ID[region].events
    // Connecting to Google Spreadsheet
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets"
    });

    const googleClient = await auth.getClient();

    const googleSheets = google.sheets({ version: 'v4', auth: googleClient })

    const metaData = await googleSheets.spreadsheets.get({
      auth,
      spreadsheetId,
    })

    const sheetName = eventName + '-' + id;
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

    client.connect(err => {
      if (err) {
        console.error('Error connecting to MongoDB:', err);
        return;
      }

      const db = client.db();

      db.collection('events').aggregate([
        {
          $match: {
            id
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
                  timestamp: "$$guest.timestamp",
                  name: "$$guest.name",
                  email: "$$guest.email",
                  type: "$$guest.type",
                  preferences: "$$guest.preferences"
                }
              }
            }
          }
        }
      ]).toArray(async (err, result) => {
        if (err) {
          console.error("Error:", err);
          return;
        }

        if (result.length > 0) {
          // Event found

          const values = result[0].guests.map((obj) => Object.values(obj))

          await googleSheets.spreadsheets.values.clear({
            auth,
            spreadsheetId,
            range: eventName,
          })

          await googleSheets.spreadsheets.values.append({
            auth,
            spreadsheetId,
            range: eventName,
            valueInputOption: "RAW",
            resource: {
              values: [
                ["Guest List of Event:", eventName],
                ["Index", "Timestamp", "Name", "Email", "Type", 'Preferences'],
                ...values
              ]
            }
          })
        } else {
          const error = new HttpError("Event not found", 404);
          return next(error);
        }
      });

    })
  }
}

const usersToSpreadsheet = async (region) => {
  if (SPREADSHEETS_ID[region].users) {
    const spreadsheetId = SPREADSHEETS_ID[region].users

    const sheetName = 'Members';

    // Connecting to Google Spreadsheet
    const auth = new google.auth.GoogleAuth({
      keyFile: "credentials.json",
      scopes: "https://www.googleapis.com/auth/spreadsheets"
    });

    const googleClient = await auth.getClient();

    const googleSheets = google.sheets({ version: 'v4', auth: googleClient })


    const metaData = await googleSheets.spreadsheets.get({
      auth,
      spreadsheetId,
    })

    const getRows = await googleSheets.spreadsheets.values.get({
      auth,
      spreadsheetId,
      range: sheetName
    })

    const sheetsList = metaData.data.sheets;

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

      // collection.updateMany({}, { $set: { region: 'rotterdam' } });

      collection.find({}).toArray(async (err, users) => {
        if (err) {
          console.log('Error while writing in db')
        }

        else {
          const values = users.map((user) => {
            const { _id, image, university, otherUniversityName, course, studentNumber, graduationDate, password, notificationTypeTerms, tickets, registrationKey, __v, christmas, region, ...rest } = user;
            return {
              ...rest,
              university: university === 'other' ? otherUniversityName : university,
              course,
              studentNumber,
              graduationDate: graduationDate || 'not specified'
            }
          }).map((obj) => Object.values(obj))
          await googleSheets.spreadsheets.values.clear({
            auth,
            spreadsheetId,
            range: sheetName,
          })

          await googleSheets.spreadsheets.values.append({
            auth,
            spreadsheetId,
            range: sheetName,
            valueInputOption: "RAW",
            resource: {
              values: [
                ["Members of:", sheetName],
                ["Status", "Purchase Date", "Expire Date", "Name", "Surname", "Birth", "Phone", "Email", "University", "Course", "Student Number", "Graduation Date"],
                ...values
              ]
            }
          })
        }
      });

    })
  }
}

export { searchInDatabase, eventToSpreadsheet, usersToSpreadsheet };