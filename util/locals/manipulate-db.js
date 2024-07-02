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

        // Iterate over all users
        for await (const user of cursor) {
            const updateDoc = {
                $set: { roles: ["member"] }
            };

            // Check and update expireDate if necessary
            if (user.expireDate === 'Board Member' || user.expireDate === 'Committee Member') {
                updateDoc.$set.expireDate = '31 Aug 2024';
            }

            // Update the user
            const result = await users.updateOne({ _id: user._id }, updateDoc);
            console.log(`Updated user ${user._id}: ${result.modifiedCount} document(s) modified`);
        }

    } catch (err) {
        console.log(err);
    } 
}
