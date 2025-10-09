import moment from "moment";
import { MongoClient, ObjectId } from "mongodb";
import {
  ADMIN,
  ALUMNI,
  BOARD_MEMBER,
  COMMITTEE_MEMBER,
  DELOITTE_TEMPLATE,
  MEMBER,
  PWC_TEMPLATE,
  VIP,
} from "../config/defines.js";
import { ALUMNI_MIGRATED, ALUMNI as ALUMNI_STATUS, USER_STATUSES } from "../config/enums.js";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import { sendMarketingEmail } from "../../services/side-services/email-transporter.js";

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
    const events = database.collection("events");

    const emailsToFind = [];

    // Find all users
    const cursor = users.find({ email: { $in: emailsToFind } });
    // const cursor = users.find();

    // // Iterate over all users
    for await (const user of cursor) {
      // Create a new object without the 'roles' property
      const newUserDoc = { ...user };

      // Find the position of 'status' and insert 'roles' after it
      const keys = Object.keys(newUserDoc);
      const statusIndex = keys.indexOf("status");

      // Convert fields to Date objects

      const newObj = {};
      keys.forEach((key, index) => {
        newObj[key] = newUserDoc[key];
      });

      newObj.roles = [BOARD_MEMBER];

      delete newUserDoc._id; // _id is immutable, so we remove it

      // Update the user
      const result = await users.replaceOne({ _id: user._id }, newObj);
      console.log(
        `Updated user ${user.name} ${user.surname} | ${user._id}: ${result.modifiedCount} document(s) modified`
      );
    }
  } catch (err) {
    console.log(err);
  } finally {
    console.log("Script executed successfully");
  }
}

export async function getMarketingUsers() {
  try {
    const today = new Date(); // Current date and time

    const clients = await User.find({
      expireDate: { $gte: today }, // $lt means "less than" (before today)
    }).select("email name"); // Select only email and name fields
    
    console.log(clients);

    clients.forEach(
      async (client) =>
        await sendMarketingEmail(PWC_TEMPLATE, client.email, client.name)
    );

    return clients;
  } catch (error) {
    console.error("Error fetching expired users:", error);
    return [];
  } finally {
    console.log("Done");
  }
}

export async function convertUserIdByEmail(email) {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const users = database.collection("users");
    const alumniUsers = database.collection("alumniusers");
    
    // First, check if the user exists in either collection
    let user = await users.findOne({ email });
    let isAlumni = false;
    
    if (!user) {
      user = await alumniUsers.findOne({ email });
      isAlumni = true;
      
      if (!user) {
        console.log(`No user found with email: ${email}`);
        return null;
      }
    }
    
    // Original ID (with prefix)
    const originalId = user._id;
    console.log(`Original ID: ${originalId}`);
    
    // Extract the MongoDB ObjectId part from the string ID (after the prefix)
    const idMatch = originalId.match(/_(.*)/);
    if (!idMatch || !idMatch[1]) {
      console.log(`ID ${originalId} doesn't match the expected format.`);
      return null;
    }
    
    // Create a new MongoDB ObjectId from the extracted part
    const objectIdPart = idMatch[1];
    const newObjectId = new ObjectId(objectIdPart);
    console.log(`New ObjectId: ${newObjectId}`);
    
    // Create a new user object with the ObjectId
    const updatedUser = { ...user };
    delete updatedUser._id; // Remove the old _id
    
    // Update the user in the appropriate collection
    const collection = isAlumni ? alumniUsers : users;
    
    // First delete the original document with string ID to avoid duplicate key errors
    await collection.deleteOne({ _id: originalId });
    
    // Then insert the updated document with the new ObjectId
    await collection.insertOne({ _id: newObjectId, ...updatedUser });
    
    console.log(`Updated user with email ${email}: ID changed from ${originalId} to ${newObjectId}`);
    return { oldId: originalId, newId: newObjectId };
    
  } catch (error) {
    console.error("Error converting user ID:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("ID conversion process completed");
  }
}

/**
 * Creates new alumni users for regular users that don't have a corresponding alumni account
 * @returns {Array|null} - Array of created alumni users, or null if operation failed
 */
export async function createNewAlumniUsersFromRegularUsers() {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const users = database.collection("users");
    const alumniUsers = database.collection("alumniusers");
    
    // Find all regular users
    const userCursor = users.find();
    const results = [];
    let count = 0;
    
    // Iterate over all regular users
    for await (const user of userCursor) {
      try {
        if (!user._id || !user._id.includes('member_')) {
          console.log(`User ${user._id} doesn't have the expected prefix, skipping...`);
          continue;
        }
        
        // Extract the ObjectId part after the prefix
        const idMatch = user._id.match(/member_(.*)/);
        if (!idMatch || !idMatch[1]) {
          console.log(`ID ${user._id} doesn't match the expected format.`);
          continue;
        }
        
        // Check if an alumni user with matching ID already exists
        const matchingAlumniId = `alumni_${idMatch[1]}`;
        const existingAlumni = await alumniUsers.findOne({ _id: matchingAlumniId });
        
        if (existingAlumni) {
          console.log(`Alumni user already exists with ID: ${matchingAlumniId}, skipping...`);
          continue;
        }
        
        // Create a new alumni user with data from the regular user
        const newAlumniUser = {
          _id: matchingAlumniId,
          status: user.status || "active",
          tier: 0, // Default tier
          roles: ["alumni"],
          purchaseDate: user.purchaseDate || new Date(),
          expireDate: user.expireDate || new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
          image: user.image || "",
          name: user.name,
          surname: user.surname,
          email: user.email,
          password: user.password,
          tickets: user.tickets || [],
          christmas: user.christmas || []
        };
        
        // Insert the new alumni user document
        await alumniUsers.insertOne(newAlumniUser);
        
        results.push({
          alumniId: matchingAlumniId,
          userId: user._id,
          email: user.email
        });
        count++;
        console.log(`Created alumni user ${count} for regular user: ${user.email}`);
      } catch (userError) {
        console.error(`Error processing user ${user._id || user.email}:`, userError);
        // Continue with next user despite error
      }
    }
    
    console.log(`Successfully created ${count} alumni users`);
    return results;
    
  } catch (error) {
    console.error("Error creating new alumni users:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("Alumni creation process completed");
  }
}

/**
 * Updates existing alumni user entries with data from regular users with matching IDs
 * @returns {Array|null} - Array of updated alumni users, or null if operation failed
 */
export async function createAlumniFromUsers() {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const users = database.collection("users");
    const alumniUsers = database.collection("alumniusers");
    
    // Find all alumni users
    const alumniCursor = await alumniUsers.find();
    const results = [];
    let count = 0;
    
    // Iterate over all alumni users
    for await (const alumniUser of alumniCursor) {
      try {
        if (!alumniUser._id || !alumniUser._id.includes('alumni_')) {
          console.log(`Alumni user ${alumniUser._id} doesn't have the expected prefix, skipping...`);
          continue;
        }
        
        // Extract the ObjectId part after the prefix
        const idMatch = alumniUser._id.match(/alumni_(.*)/);
        if (!idMatch || !idMatch[1]) {
          console.log(`ID ${alumniUser._id} doesn't match the expected format.`);
          continue;
        }
        
        // Look for a regular user with matching ID but "member_" prefix
        const matchingId = `member_${idMatch[1]}`;
        const regularUser = await users.findOne({ _id: matchingId });
        
        if (!regularUser) {
          console.log(`No matching user found with ID: ${matchingId}`);
          continue;
        }
        
        // Check if the alumni user is already populated with data
        if (alumniUser.email && alumniUser.name && alumniUser.surname) {
          console.log(`Alumni user ${alumniUser._id} already has data, skipping...`);
          continue;
        }
        
        // Create a new alumni user with data from the regular user
        const updatedAlumniUser = {
          _id: alumniUser._id,
          status: regularUser.status || "active",
          tier: 0, // Default tier
          roles: ["alumni"],
          purchaseDate: regularUser.purchaseDate || new Date(),
          expireDate: regularUser.expireDate || new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
          image: regularUser.image || "",
          name: regularUser.name,
          surname: regularUser.surname,
          email: regularUser.email,
          password: regularUser.password,
          tickets: regularUser.tickets || [],
          christmas: regularUser.christmas || []
        };
        
        // First delete the original alumni document
        await alumniUsers.deleteOne({ _id: alumniUser._id });
        
        // Then insert the updated document
        await alumniUsers.insertOne(updatedAlumniUser);
        
        results.push({
          alumniId: alumniUser._id,
          userId: matchingId,
          email: regularUser.email
        });
        count++;
        console.log(`Processed ${count} users`);
      } catch (userError) {
        console.error(`Error processing alumni user ${alumniUser._id}:`, userError);
        // Continue with next user despite error
      }
    }
    
    console.log(`Successfully processed ${count} alumni users`);
    return results;
    
  } catch (error) {
    console.error("Error creating alumni from users:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("Alumni creation process completed");
  }
}

/**
 * Iterates over all users and converts their ObjectIds to string IDs with the given prefix
 * @param {string} prefix - The prefix to add to the ObjectId (e.g., "member_")
 * @returns {Array|null} - Array of conversion results, or null if operation failed
 */
export async function convertAllUserIdsToString(prefix = "member_") {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const users = database.collection("users");
    
    // Find all users
    const cursor = users.find();
    const results = [];
    let count = 0;
    
    // Iterate over all users
    for await (const user of cursor) {
      try {
        if (!user.email) {
          console.log(`User ${user._id} has no email, skipping...`);
          continue;
        }
        
        // Convert the ID to string with prefix
        const result = await convertUserIdToStringWithPrefix(user.email, prefix);
        
        if (result) {
          results.push(result);
          count++;
          console.log(`Processed ${count} users`);
        }
      } catch (userError) {
        console.error(`Error processing user ${user._id || user.email}:`, userError);
        // Continue with next user despite error
      }
    }
    
    console.log(`Successfully processed ${count} users`);
    return results;
    
  } catch (error) {
    console.error("Error converting all user IDs:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("All user ID conversion process completed");
  }
}

/**
 * Converts a user's ObjectId to a string ID with a given prefix
 * @param {string} email - The user's email to find the document
 * @param {string} prefix - The prefix to add to the ObjectId (e.g., "user_", "alumni_")
 * @returns {Object|null} - Object with oldId and newId, or null if operation failed
 */
export async function convertUserIdToStringWithPrefix(email, prefix) {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const users = database.collection("users");
    const alumniUsers = database.collection("alumniusers");
    
    // First, check if the user exists in either collection
    let user = await users.findOne({ email });
    let isAlumni = false;
    
    if (!user) {
      console.log(`No user found with email: ${email}`);
      return null;
    }
    
    // Original ID (ObjectId)
    const originalId = user._id;
    console.log(`Original ID: ${originalId}`);
    
    // Check if the ID is already a string with a prefix
    if (typeof originalId === 'string' && originalId.includes('_')) {
      console.log(`ID ${originalId} is already a string with a prefix.`);
      return { oldId: originalId, newId: originalId };
    }
    
    // Create the new string ID with the provided prefix
    const newStringId = `${prefix}${originalId}`;
    console.log(`New String ID: ${newStringId}`);
    
    // Create a new user object
    const updatedUser = { ...user };
    delete updatedUser._id; // Remove the old _id
    
    // Update the user in the appropriate collection
    const collection = isAlumni ? alumniUsers : users;
    
    // First delete the original document with ObjectId to avoid duplicate key errors
    await collection.deleteOne({ _id: originalId });
    
    // Then insert the updated document with the new string ID
    await collection.insertOne({ _id: newStringId, ...updatedUser });
    
    console.log(`Updated user with email ${email}: ID changed from ${originalId} to ${newStringId}`);
    return { oldId: originalId, newId: newStringId };
    
  } catch (error) {
    console.error("Error converting user ID to string with prefix:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("ID conversion process completed");
  }
}

/**
 * Sets the joinDate field for all alumni users that don't have it set
 * @param {Date} defaultDate - Optional default date to set for joinDate if not provided
 * @returns {Array|null} - Array of updated alumni users, or null if operation failed
 */
export async function setJoinDateForAllAlumniUsers(defaultDate = new Date()) {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const alumniUsersCollection = database.collection("alumniusers");
    
    // Find all alumni users without joinDate or with null joinDate
    const query = { 
      $or: [
        { joinDate: { $exists: false } },
        { joinDate: null }
      ]
    };
    
    const cursor = alumniUsersCollection.find(query);
    const results = [];
    let count = 0;
    
    // Iterate over all alumni users that need updating
    for await (const user of cursor) {
      try {
        // Set the joinDate field
        await alumniUsersCollection.updateOne(
          { _id: user._id },
          { $set: { joinDate: defaultDate } }
        );
        
        results.push({
          alumniId: user._id,
          email: user.email
        });
        count++;
        console.log(`Updated alumni user ${count}: ${user.email || user._id}`);
      } catch (userError) {
        console.error(`Error updating alumni user ${user._id || user.email}:`, userError);
        // Continue with next user despite error
      }
    }
    
    console.log(`Successfully updated ${count} alumni users with joinDate`);
    return results;
    
  } catch (error) {
    console.error("Error setting joinDate for alumni users:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("joinDate update process completed");
  }
}

/**
 * Migrates a specific user by ID from regular users to alumni users
 * @param {string} userId - The ID of the user to migrate
 * @param {Object} options - Optional configuration for the migration
 * @param {number} options.tier - The tier to assign to the alumni user (default: 0)
 * @param {Object} options.subscription - Subscription data to assign to the alumni user
 * @param {string} options.subscription.id - Stripe subscription ID
 * @param {string} options.subscription.customerId - Stripe customer ID
 * @param {number} options.subscription.period - Subscription period in months
 * @returns {Object|null} - Migration result object, or null if operation failed
 */
export async function migrateUserByIdToAlumni(userId, options = {}) {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collections
    const database = client.db();
    const usersCollection = database.collection("users");
    const alumniUsersCollection = database.collection("alumniusers");
    
    // Find the user by ID
    const user = await usersCollection.findOne({ _id: userId });
    
    if (!user) {
      console.log(`No user found with ID: ${userId}`);
      return { success: false, message: "User not found" };
    }
    
    console.log(`Found user: ${user.name} ${user.surname} (${user.email})`);
    
    // Extract the ObjectId part if the user has a prefixed ID
    let objectIdPart;
    if (typeof user._id === 'string' && user._id.includes('member_')) {
      const idMatch = user._id.match(/member_(.*)/);
      if (idMatch && idMatch[1]) {
        objectIdPart = idMatch[1];
      } else {
        console.log(`ID ${user._id} doesn't match the expected format.`);
        return { success: false, message: "Invalid user ID format" };
      }
    } else {
      // If the user has a regular ObjectId, convert it to string
      objectIdPart = user._id.toString();
    }
    
    // Create the alumni ID with the same ObjectId part
    const alumniId = `alumni_${objectIdPart}`;
    
    // Check if an alumni user already exists with this ID or email
    let existingAlumni;
    try {
      existingAlumni = await alumniUsersCollection.findOne({ 
        $or: [
          { _id: alumniId },
          { email: user.email }
        ]
      });
    } catch (err) {
      console.error(`Error checking existing alumni for user ${user.email}:`, err);
      return { success: false, message: "Error checking existing alumni" };
    }
    
    let result = {};
    
    if (existingAlumni) {
      // Update existing alumni user with data from regular user
      const updatedAlumni = { ...existingAlumni };
      updatedAlumni.name = user.name;
      updatedAlumni.surname = user.surname;
      updatedAlumni.email = user.email;
      updatedAlumni.image = user.image || "";
      updatedAlumni.password = user.password;
      updatedAlumni.status = user.status || "active";
      updatedAlumni.tier = options.tier || 0;
      updatedAlumni.purchaseDate = user.purchaseDate || new Date();
      updatedAlumni.expireDate = user.expireDate || new Date(new Date().setFullYear(new Date().getFullYear() + 1));
      updatedAlumni.joinDate = existingAlumni.joinDate || new Date();
      
      // Update subscription if provided
      if (options.subscription) {
        updatedAlumni.subscription = {
          id: options.subscription.id || "",
          customerId: options.subscription.customerId || "",
          period: options.subscription.period || 12
        };
      } else if (user.subscription) {
        updatedAlumni.subscription = user.subscription;
      }
      
      // Make sure the alumni role is set
      if (!updatedAlumni.roles || !updatedAlumni.roles.includes(ALUMNI)) {
        updatedAlumni.roles = [...(updatedAlumni.roles || []), ALUMNI];
      }
      
      // First delete the original alumni document
      await alumniUsersCollection.deleteOne({ _id: existingAlumni._id });
      
      // Then insert the updated document
      await alumniUsersCollection.insertOne(updatedAlumni);
      
      result = {
        success: true,
        action: "updated",
        alumniId: existingAlumni._id,
        userId: user._id,
        email: user.email,
        message: "Updated existing alumni user"
      };
    } else {
      // Create new alumni user with data from regular user
      const newAlumniUser = {
        _id: alumniId,
        name: user.name,
        surname: user.surname,
        email: user.email,
        password: user.password,
        image: user.image || "",
        status: user.status || "active",
        tier: options.tier || 0,
        roles: [ALUMNI],
        purchaseDate: user.purchaseDate || new Date(),
        expireDate: user.expireDate || new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
        joinDate: new Date(),
        tickets: user.tickets || [],
        christmas: user.christmas || []
      };
      
      // Add subscription if provided
      if (options.subscription) {
        newAlumniUser.subscription = {
          id: options.subscription.id || "",
          customerId: options.subscription.customerId || "",
          period: options.subscription.period || 12
        };
      } else if (user.subscription) {
        newAlumniUser.subscription = user.subscription;
      }
      
      // Insert the new alumni user document
      await alumniUsersCollection.insertOne(newAlumniUser);
      
      result = {
        success: true,
        action: "created",
        alumniId: alumniId,
        userId: user._id,
        email: user.email,
        message: "Created new alumni user"
      };
    }
    
    // Update the regular user's status to alumni_migrated
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { status: USER_STATUSES[ALUMNI_MIGRATED] } }
    );
    
    console.log(`Successfully migrated user ${user.email} to alumni`);
    return result;
    
  } catch (error) {
    console.error("Error migrating user to alumni:", error);
    return { success: false, message: error.message };
  } finally {
    // Don't close the client here as it might be reused
    console.log("User migration process completed");
  }
}

/**
 * Converts users without subscription to alumni users
 * @returns {Array|null} - Array of converted users, or null if operation failed
 */
export async function convertUsersWithoutSubscriptionToAlumni() {
  try {
    // Connect to the MongoDB server
    await client.connect();
    console.log("Connected successfully to server");

    // Get the database and collection
    const database = client.db();
    const usersCollection = database.collection("users");
    const alumniUsersCollection = database.collection("alumniusers");
    
    // Find all users without subscription
    const query = { 
      $or: [
        { subscription: { $exists: false } },
        { subscription: null },
        { "subscription.id": { $exists: false } },
        { "subscription.id": null },
        { "subscription.id": "" },
        { "subscription.customerId": { $exists: false } },
        { "subscription.customerId": null },
        { "subscription.customerId": "" }
      ]
    };
    
    const cursor = usersCollection.find(query);
    const results = [];
    let count = 0;
    
    // Iterate over all users without subscription
    for await (const user of cursor) {
      try {
        // Skip if no email or already alumni status
        if (!user.email) {
          console.log(`User ${user._id} has no email, skipping...`);
          continue;
        }
        
        if (user.status === USER_STATUSES[ALUMNI_STATUS]) {
          console.log(`User ${user.email} is already marked as alumni, skipping...`);
          continue;
        }
        
        // Extract the ObjectId part if the user has a prefixed ID
        let objectIdPart;
        if (typeof user._id === 'string' && user._id.includes('member_')) {
          const idMatch = user._id.match(/member_(.*)/);
          if (idMatch && idMatch[1]) {
            objectIdPart = idMatch[1];
          } else {
            console.log(`ID ${user._id} doesn't match the expected format.`);
            continue;
          }
        } else {
          // If the user has a regular ObjectId, convert it to string
          objectIdPart = user._id.toString();
        }
        
        // Create the alumni ID with the same ObjectId part
        const alumniId = `alumni_${objectIdPart}`;
        
        // Check if an alumni user already exists with this ID or email
        let existingAlumni;
        try {
          existingAlumni = await alumniUsersCollection.findOne({ 
            $or: [
              { _id: alumniId },
              { email: user.email }
            ]
          });
        } catch (err) {
          console.error(`Error checking existing alumni for user ${user.email}:`, err);
          continue;
        }
        
        let result = {};
        
        if (existingAlumni) {
          // Update existing alumni user with data from regular user
          const updatedAlumni = { ...existingAlumni };
          updatedAlumni.name = user.name;
          updatedAlumni.surname = user.surname;
          updatedAlumni.email = user.email;
          updatedAlumni.image = user.image;
          updatedAlumni.password = user.password;
          updatedAlumni.status = user.status || "active";
          updatedAlumni.purchaseDate = user.purchaseDate || new Date();
          updatedAlumni.expireDate = user.expireDate || new Date(new Date().setFullYear(new Date().getFullYear() + 1));
          
          // Make sure the alumni role is set
          if (!updatedAlumni.roles.includes(ALUMNI)) {
            updatedAlumni.roles = [...(updatedAlumni.roles || []), ALUMNI];
          }
          
          // First delete the original alumni document
          await alumniUsersCollection.deleteOne({ _id: existingAlumni._id });
          
          // Then insert the updated document
          await alumniUsersCollection.insertOne(updatedAlumni);
          
          result = {
            action: "updated",
            alumniId: existingAlumni._id,
            userId: user._id,
            email: user.email
          };
        } else {
          // Create new alumni user with data from regular user
          const newAlumniUser = {
            _id: alumniId,
            name: user.name,
            surname: user.surname,
            email: user.email,
            password: user.password,
            image: user.image || "",
            status: user.status || "active",
            tier: 0, // Default tier
            roles: [ALUMNI],
            purchaseDate: user.purchaseDate || new Date(),
            expireDate: user.expireDate || new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
            tickets: user.tickets || [],
            christmas: user.christmas || []
          };
          
          // Insert the new alumni user document
          await alumniUsersCollection.insertOne(newAlumniUser);
          
          result = {
            action: "created",
            alumniId: alumniId,
            userId: user._id,
            email: user.email
          };
        }
        
        // Update the regular user's status to alumni
        await usersCollection.updateOne(
          { _id: user._id },
          { $set: { status: USER_STATUSES[ALUMNI_STATUS] } }
        );
        
        results.push(result);
        count++;
        console.log(`Processed user ${count}: ${user.email} - ${result.action} alumni user`);
      } catch (userError) {
        console.error(`Error processing user ${user._id || user.email}:`, userError);
        // Continue with next user despite error
      }
    }
    
    console.log(`Successfully processed ${count} users`);
    return results;
    
  } catch (error) {
    console.error("Error converting users without subscription to alumni:", error);
    return null;
  } finally {
    // Don't close the client here as it might be reused
    console.log("Conversion process completed");
  }
}