import AlumniUser from "../../models/AlumniUser.js";
import User from "../../models/User.js";
import { USER_STATUSES, MEMBERSHIP_ACTIVE } from "../../util/config/enums.js";
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
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ email, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ email, ...excludeMembershipActive });

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
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ _id: id, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ _id: id, ...excludeMembershipActive });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return (alumni || user);
  } catch (err) {
    console.error("Error in findUserById:", err);
    return null;
  }
};

export const findUserByName = async (name, surname) => {
  try {
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ name, surname, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ name, surname, ...excludeMembershipActive });

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
    const excludeMembershipActive = { status: { $ne: USER_STATUSES[MEMBERSHIP_ACTIVE] } };
    const userQuery = User.findOne({ ...query, ...excludeMembershipActive });
    const alumniQuery = AlumniUser.findOne({ ...query, ...excludeMembershipActive });

    const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

    return alumni || user;
  } catch (err) {
    console.error("Error in findUserByQuery:", err);
    return null;
  }
};