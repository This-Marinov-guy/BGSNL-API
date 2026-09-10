import HttpError from "../models/Http-error.js";
import { trustedWebsiteRequest, requestClientAddress } from "../util/auth/request-client.js";
import { limitGoogleRequests } from "../services/authentication/google.js";
import { sessions } from "../services/authentication/sessions.js";

// Refresh credentials never go to resource handlers, public APIs or webhooks.
export const sessionAction = (action, { service = sessions, limit = limitGoogleRequests } = {}) => async (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  if (!trustedWebsiteRequest(req)) return next(new HttpError("Website authentication required", 403));
  try {
    await limit(`session-lifecycle:${requestClientAddress(req)}`, 600);
    if (action === "logout") {
      await service.revoke(req.body?.refreshToken);
      return res.json({ status: true });
    }
    return res.json(await service.refresh(req.body?.refreshToken, { activity: action === "activity" }));
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("Session renewal is temporarily unavailable. Please retry.", 503));
  }
};
