import HttpError from "../models/Http-error.js";
import { confirmProfileChange } from "../services/authentication/profile-change.js";
import { verifySessionToken } from "../util/auth/session-token.js";
import { sessions } from "../services/authentication/sessions.js";
import { getTokenFromHeader } from "../util/functions/security.js";

export const createConfirmProfile = ({ confirm = confirmProfileChange, verify = verifySessionToken, sign = sessions.replace } = {}) => async (req, res, next) => {
  try {
    const result = await confirm(req.body?.confirmationToken);
    let token;
    if (result.user) {
      try {
        const claims = verify(getTokenFromHeader(req));
        if (claims.userId === result.user.id && claims.auth_time === result.authTime && claims.sessionVersion === result.previousVersion) {
          token = await sign(result.user, { session: claims });
        }
      } catch { /* Email confirmation does not log a different browser in. */ }
    }
    return res.json({ status: true, state: result.state, message: result.message, ...(token ? typeof token === "string" ? { token } : token : {}) });
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("We could not confirm this change. Please try again or request a new confirmation from your profile.", 503));
  }
};
export const confirmProfile = createConfirmProfile();
