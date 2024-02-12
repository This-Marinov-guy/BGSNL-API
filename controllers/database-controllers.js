import { MongoClient } from 'mongodb';
import { google } from 'googleapis';
import HttpError from "../models/Http-error.js";

const searchInDatabase = (req, res, next) => {
    const eventName = req.params.eventName;

    const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
    const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

    let gustList;

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
                gustList = result[0].guests
                console.log(result[0].guests);
            } else {
                console.log("Event not found.");
            }
        });

    })

    res.status(200).send({ guestList: gustList.map((guest) => guest.toObject({ getters: true })) });

}

const eventToSpreadsheet = async (req, res, next) => {
    const eventName = req.params.eventName;
    const sheetName = req.params.sheetName;

    // Connecting to Google Spreadsheet
    const auth = new google.auth.GoogleAuth({
        keyFile: "credentials.json",
        scopes: "https://www.googleapis.com/auth/spreadsheets"
    });

    const googleClient = await auth.getClient();

    const googleSheets = google.sheets({ version: 'v4', auth: googleClient })

    const spreadsheetId = '1ox6YyRwGU0L3WwwTDgqvucVobu0dbCGQmJkrpXgUi-A'

    const metaData = await googleSheets.spreadsheets.get({
        auth,
        spreadsheetId,
    })

    const getRows = await googleSheets.spreadsheets.values.get({
        auth,
        spreadsheetId,
        range: eventName
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

    res.status(200).send({ message: "SpreadSheet Updated!" });

}

const usersToSpreadsheet = async (req, res, next) => {
    const sheetName = 'Members';

    // Connecting to Google Spreadsheet
    const auth = new google.auth.GoogleAuth({
        keyFile: "credentials.json",
        scopes: "https://www.googleapis.com/auth/spreadsheets"
    });

    const googleClient = await auth.getClient();

    const googleSheets = google.sheets({ version: 'v4', auth: googleClient })

    const spreadsheetId = '1LXqEhn6--T_dl2jTvMdfwKlXGj-svoC_wdVKAupVa5Y'

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
                const error = new HttpError("Error - users not found", 404);
                return next(error);
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

    // res.status(200).send({ message: "SpreadSheet Updated!" });

}

const activeMembersToSpreadsheet = async (req, res, next) => {
    const sheetName = 'Board';

    // Connecting to Google Spreadsheet
    const auth = new google.auth.GoogleAuth({
        keyFile: "credentials.json",
        scopes: "https://www.googleapis.com/auth/spreadsheets"
    });

    const googleClient = await auth.getClient();

    const googleSheets = google.sheets({ version: 'v4', auth: googleClient })

    const spreadsheetId = '1491g7vhn6e7DuGQBUmMqLIa-aeOT_Nlrzar-yvVv_nU'

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

        const collection = db.collection('activemembers');

        collection.find({}).toArray(async (err, users) => {
            if (err) {
                const error = new HttpError("Error - users not found", 404);
                return next(error);
            }

            else {
                const values = users.map((user) => {
                    const { _id, timestamp, positions, date, email, phone, cv, questions, __v } = user;
                    return {
                        email,
                        phone,
                        cv: cv ? cv : '-',
                        ...questions,
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
                            ["Active Member submissions"],
                            ["Email", "Phone", 'CV', "1. Защо искате да участвате в Българското Общество в Ротердам?", "2. С какво бихте допринесли към Българското Общество в Ротердам?", "3. Колко свободни часа на седмица можете да отделяте?", "4. Отдават ли ви се числата?", "5. Какви са вашите хобита?", "6. Умеете ли да работите в екип?", "7. Интроверт или екстроверт сте?", "8. Определяте ли се като лидер?", "9. Имате ли опит с content creation, social media , canva/photoshop?", "10.Смятате ли се за подреден човек?"],
                            ...values
                        ]
                    }
                })
            }
        });

    })

    // res.status(200).send({ message: "SpreadSheet Updated!" });

}


export { searchInDatabase, eventToSpreadsheet, usersToSpreadsheet, activeMembersToSpreadsheet }