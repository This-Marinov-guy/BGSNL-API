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
  const userQuery = User.findOne({ email });
  const alumniQuery = AlumniUser.findOne({ email });

  const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

  return alumni || user;
};

export const findUserById = async (id) => {
  const userQuery = User.findById(id);
  const alumniQuery = AlumniUser.findById(id);

  const [user, alumni] = await Promise.all([userQuery, alumniQuery]);

  return alumni || user;
};
