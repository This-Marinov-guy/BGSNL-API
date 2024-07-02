import { MongoClient } from 'mongodb';

// Connection URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

// Create a new MongoClient
const client = new MongoClient(uri);

export async function updateUsers() {
    try {
        // Connect to the MongoDB server
        await client.connect();
        console.log("Connected successfully to server");

        // Get the database and collection
        const database = client.db();
        const users = database.collection("users");

        // Find all users
        const cursor = users.find({});

        // // Iterate over all users
        // for await (const user of cursor) {
        //     // Create a new object without the 'roles' property
        //     const newUserDoc = { ...user };
        //     delete newUserDoc._id;  // _id is immutable, so we remove it

        //     // Find the position of 'status' and insert 'roles' after it
        //     const keys = Object.keys(newUserDoc);
        //     const statusIndex = keys.indexOf('status');

        //     const newObj = {};
        //     keys.forEach((key, index) => {
        //         newObj[key] = newUserDoc[key];
        //         if (index === statusIndex) {
        //             newObj.roles = ['member'];
        //         }
        //     });

        //     // If 'status' doesn't exist, add 'roles' at the end
        //     if (statusIndex === -1) {
        //         newObj.roles = ['member'];
        //     }

        //     // Update expireDate if necessary
        //     if (user.expireDate === 'Board Member' || user.expireDate === 'Committee Member') {
        //         newObj.expireDate = '31 Aug 2024';
        //     }

        //     // Update the user
        //     const result = await users.replaceOne({ _id: user._id }, newObj);
        //     console.log(`Updated user ${user._id}: ${result.modifiedCount} document(s) modified`);
        // }
    } catch (err) {
        console.log(err);
    } finally {
        console.log('Script executed successfully');
    }
}
