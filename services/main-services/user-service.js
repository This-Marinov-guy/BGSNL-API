import AlumniUser from "../../models/AlumniUser.js";
import User from "../../models/User.js";
import { extractUserFromRequest } from "../../util/functions/security.js";

export const getFingerprintLite = (req) => {
  try {
    const { userId } = extractUserFromRequest(req);

    return {
      timestamp: new Date(),
      id: userId,
    };
  } catch (err) {
    console.log(err);
    return {};
  }
};

// we always prioritize alumnis
export const findUserByEmail = async (email) => {
  // Check if email is valid before running queries
  if (!email || typeof email !== 'string') {
    return null;
  }

  try {
    const userQuery = User.findOne({ email });
    const alumniQuery = AlumniUser.findOne({ email });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return alumni || user;
  } catch (err) {
    console.error("Error in findUserByEmail:", err);
    return null;
  }
};

export const findUserById = async (id) => {  
  // Check if id is valid before running queries
  if (!id || typeof id !== 'string' && !id.toString) {
    return null;
  }

  try {
    const userQuery = User.findOne({_id: id});
    const alumniQuery = AlumniUser.findOne({_id: id});

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return (alumni || user);
  } catch (err) {
    console.error("Error in findUserById:", err);
    return null;
  }
};

export const findUserByName = async (name, surname) => {
  try {
    const userQuery = User.findOne({ name, surname });
    const alumniQuery = AlumniUser.findOne({ name, surname });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return alumni || user;
  } catch (err) {
    console.error("Error in findUserById:", err);
    return null;
  }
};

// Generic function to find user by any query, prioritizing alumni users
export const findUserByQuery = async (query) => {
  // Check if query is valid
  if (!query || typeof query !== 'object') {
    return null;
  }

  try {
    const userQuery = User.findOne(query);
    const alumniQuery = AlumniUser.findOne(query);

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return alumni || user;
  } catch (err) {
    console.error("Error in findUserByQuery:", err);
    return null;
  }
};