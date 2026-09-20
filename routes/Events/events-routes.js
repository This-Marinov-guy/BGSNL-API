import express from "express";
import multer from "multer";
import {
  checkEligibleMemberForPurchase,
  checkTicketEligibility,
  getEventById,
  getEventPurchaseAvailability,
  getEvents,
  getSoldTicketQuantity,
  postAddGuestToEvent,
  postAddMemberToEvent,
  postNonSocietyEvent,
  postSendNonSocietyEventFinalReminderEmail,
  postSendNonSocietyEventResendEmail,
  postSyncEventsCalendar,
  updatePresence,
  getEventGuestList,
  updateGuestPresence,
} from "../../controllers/Events/events-controllers.js";
import fileUpload from "../../middleware/file-upload.js";
import dotenv from "dotenv";
import { adminMiddleware, authMiddleware, optionalAuthMiddleware, requireBenefits } from "../../middleware/authorization.js";
import { EVENT_MANAGEMENT_ACCESS } from "../../util/config/defines.js";
import { validateRequest } from "../../middleware/validate-request.js";
import {
  checkTicketEligibilityValidators,
  guestCheckInValidators,
  guestPresenceValidators,
  guestTicketValidators,
  manualMemberTicketValidators,
  nonSocietyEmailValidators,
  nonSocietyRegistrationValidators,
} from "../../validation/form-validators.js";
dotenv.config();

const eventRouter = express.Router();
const formDataUpload = multer({ storage: multer.memoryStorage() });

eventRouter.get(
  "/get-purchase-status/:eventId",
  getEventPurchaseAvailability
);

eventRouter.get(
  "/event-details/:eventId",
  getEventById
);

eventRouter.get(
  "/events-list",
  getEvents
);

eventRouter.get(
  "/sold-ticket-count/:eventId",
  getSoldTicketQuantity
);

eventRouter.get(
  "/check-member/:userId/:eventId",
  authMiddleware,
  requireBenefits("memberDiscount"),
  checkEligibleMemberForPurchase
);

eventRouter.post(
  "/check-ticket-eligibility",
  optionalAuthMiddleware,
  checkTicketEligibilityValidators,
  validateRequest,
  checkTicketEligibility
);

eventRouter.post(
  "/purchase-ticket/guest",
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  formDataUpload.none(),
  guestTicketValidators,
  validateRequest,
  postAddGuestToEvent,
);

eventRouter.post(
  "/purchase-ticket/member",
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  fileUpload(process.env.BUCKET_MEMBER_TICKETS).single("image"),
  manualMemberTicketValidators,
  validateRequest,
  postAddMemberToEvent,
);

eventRouter.post(
  "/register/non-society-event",
  optionalAuthMiddleware,
  formDataUpload.none(),
  nonSocietyRegistrationValidators,
  validateRequest,
  postNonSocietyEvent
);

eventRouter.post(
  "/non-society-event/resend-email",
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  nonSocietyEmailValidators,
  validateRequest,
  postSendNonSocietyEventResendEmail
);

eventRouter.post(
  "/non-society-event/final-reminder-email",
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  nonSocietyEmailValidators,
  validateRequest,
  postSendNonSocietyEventFinalReminderEmail
);

eventRouter.post(
  "/sync-calendar-events",
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  postSyncEventsCalendar
);

eventRouter.patch(
  '/check-guest-list',
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  guestCheckInValidators,
  validateRequest,
  updatePresence
);

eventRouter.get(
  "/guest-list/:eventId",
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  getEventGuestList
);

eventRouter.patch(
  "/guest-presence",
  adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  guestPresenceValidators,
  validateRequest,
  updateGuestPresence
);

export default eventRouter;
