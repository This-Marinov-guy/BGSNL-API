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
