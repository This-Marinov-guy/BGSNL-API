import { MongoClient } from 'mongodb';
import { google } from 'googleapis';

const searchInDatabase = (eventName) => {
  const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
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

const eventToSpreadsheet = async (eventName) => {
  // Connecting to Google Spreadsheet
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: "https://www.googleapis.com/auth/spreadsheets"
  });

  const googleClient = await auth.getClient();

  const googleSheets = google.sheets({ version: 'v4', auth: googleClient })

  const spreadsheetId = '1PEWOKkkrjDAuW30p2pgThQQZFQWMwO7n2gIa1KIF-i8'

  const metaData = await googleSheets.spreadsheets.get({
    auth,
    spreadsheetId,
  })

  const sheetsList = metaData.data.sheets;
  const sheetExists = sheetsList.some((sheet) => sheet.properties.title === eventName);

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
                title: eventName,
              },
            },
          },
        ],
      },
    });

    console.log(`Sheet '${eventName}' has been created.`);
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

export { searchInDatabase, eventToSpreadsheet };