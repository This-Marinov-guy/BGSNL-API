import express from "express";
import { authMiddleware } from "../middleware/authorization.js";
import HttpError from "../models/Http-error.js";
import { createSupportService } from "../services/support/conversations.js";
import { isSupportStaff, normalizeContact } from "../services/support/policy.js";
import { limitSupportRequest } from "../services/support/rate-limit.js";
import supportImageUpload from "../middleware/support-image-upload.js";
import { formatUploadValidationError } from "../middleware/upload-validation-error.js";
import { uploadSupportImages } from "../services/support/attachments.js";
import { notifySupportTicketCreated, notifySupportTicketReplied } from "../services/background-services/internal-notifications.js";
import { logOperationalError } from "../middleware/axiom-logger.js";
import { publishSupportChanged, supportLiveScopes, streamSupport } from "../services/support/live.js";

export function supportPrivacy(req, res, next) {
  if (/^\/api\/(?:v\d+\/)?support(?:\/|$)/i.test(req.path)) {
    req.supportPrivate = true;
    res.locals.skipMarketingCapture = true;
    res.set("Cache-Control", "private, no-store");
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  return next();
}

// Also handle parser/firewall errors that happen before the support router.
// Express JSON parse errors can contain the original private request body.
export function supportError(error, req, res, next) {
  if (!req.supportPrivate) return next(error);
  if ((error.statusCode || 503) >= 500) logOperationalError("endpoint.support", error);
  if (error instanceof HttpError) return res.status(error.statusCode || 500).json({ message: error.message });
  const uploadValidation = formatUploadValidationError(error);
  if (uploadValidation) return res.status(422).json(uploadValidation);
  if (error.type === "entity.too.large") return res.status(413).json({ message: "This report is too large. Shorten your message and try again." });
  if (error.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid support request. Please reload and try again." });
  return res.status(503).json({ message: "Support is temporarily unavailable. Please try again." });
}

export function requireSupportOrigin(req, _res, next) {
  if (req.method === "GET") return next();
  const origins = ["https://www.bulgariansociety.nl", "https://bulgariansociety.nl", "https://bulgariansociety.netlify.app"];
  if (process.env.NODE_ENV !== "production") for (const host of ["localhost", "127.0.0.1"]) {
    for (const port of [3000, 3001, 3002]) origins.push(`http://${host}:${port}`);
  }
  if (!origins.includes(req.headers.origin) || !req.is(["application/json", "multipart/form-data"])) return next(new HttpError("Invalid support request origin or content type.", 403));
  return next();
}

export function createSupportRouter({ service = createSupportService({ notifyNewTicket: notifySupportTicketCreated, notifyReply: notifySupportTicketReplied, notifyChanged: publishSupportChanged }), authenticate = authMiddleware, throttle = limitSupportRequest, uploadImages = uploadSupportImages, stream = streamSupport } = {}) {
  const router = express.Router();
  const actor = (req, staff = false) => ({ account: req.account, secret: req.get("X-Support-Token"), staff });
  const action = (handler) => async (req, res, next) => {
    try { return await handler(req, res); }
    catch (error) {
      if (error instanceof HttpError) return next(error);
      // Database errors may contain message bodies, contact data or access
      // hashes. Do not forward/log raw provider errors.
      return next(new HttpError("Support is temporarily unavailable. Your message has not been confirmed; please retry.", 503));
    }
  };
  const authorizeMessageUpload = (staff = false) => async (req, _res, next) => {
    try { await service.get(req.params.id, actor(req, staff)); return next(); }
    catch (error) { return next(error instanceof HttpError ? error : new HttpError("Support is temporarily unavailable. Please try again.", 503)); }
  };
  const reply = (staff = false) => action(async (req, res) => {
    // Refuse new messages on locked tickets before sending files to Cloudinary.
    // The write rechecks the status/revision in case staff change it mid-upload.
    await service.prepareReply(req.params.id, req.body || {}, actor(req, staff));
    const attachments = await uploadImages(req.files || [], { conversationId: req.params.id, messageId: req.body?.id });
    return res.json({ conversation: await service.reply(req.params.id, { ...(req.body || {}), attachments }, actor(req, staff)) });
  });
  router.use((req, res, next) => req.headers.authorization ? authenticate(req, res, next) : next());
  router.use(requireSupportOrigin);
  router.use((req, res, next) => Promise.resolve().then(() => throttle(req)).then(() => next()).catch((error) =>
    next(error instanceof HttpError ? error : new HttpError("Support is temporarily unavailable. Please try again.", 503))));

  router.post("/live", action(async (req, res) => {
    const scopes = await supportLiveScopes(req.body || {}, actor(req), service);
    return stream(req, res, scopes);
  }));
  router.get("/profile", action(async (req, res) => {
    if (!req.account) throw new HttpError("Please sign in to access your account support profile.", 401);
    return res.json({ accountId: String(req.account._id || req.account.id), contact: normalizeContact({}, req.account), staff: isSupportStaff(req.account) });
  }));
  router.get("/conversations", action(async (req, res) => res.json(await service.list(actor(req), req.query))));
  router.get("/conversations/activity", action(async (req, res) => res.json(await service.activity(actor(req)))));
  router.post("/conversations", action(async (req, res) => res.status(201).json({ conversation: await service.create(req.body || {}, actor(req), { userAgent: req.get("User-Agent") }) })));
  router.get("/conversations/:id", action(async (req, res) => res.json({ conversation: await service.get(req.params.id, actor(req), { before: req.query.before, limit: req.query.limit }) })));
  router.post("/conversations/:id/messages", authorizeMessageUpload(), supportImageUpload.array("images", 3), reply());
  router.post("/conversations/:id/status", action(async (req, res) => res.json({ conversation: await service.changeStatus(req.params.id, req.body || {}, actor(req)) })));

  router.use("/inbox", (req, _res, next) => isSupportStaff(req.account) ? next() : next(new HttpError("Support staff access is required.", 403)));
  router.get("/inbox", action(async (req, res) => res.json(await service.list(actor(req, true), req.query))));
  router.get("/inbox/:id", action(async (req, res) => res.json({ conversation: await service.get(req.params.id, actor(req, true), { before: req.query.before, limit: req.query.limit }) })));
  router.post("/inbox/:id/messages", authorizeMessageUpload(true), supportImageUpload.array("images", 3), reply(true));
  router.post("/inbox/:id/status", action(async (req, res) => res.json({ conversation: await service.changeStatus(req.params.id, req.body || {}, actor(req, true)) })));
  return router;
}

export default createSupportRouter();
