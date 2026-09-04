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
  updatePresence
} from "../../controllers/Events/events-controllers.js";
import fileUpload from "../../middleware/file-upload.js";
import dotenv from "dotenv";
import { adminMiddleware } from "../../middleware/authorization.js";
import { ACCESS_3 } from "../../util/config/defines.js";
import { validateRequest } from "../../middleware/validate-request.js";
import {
  checkTicketEligibilityValidators,
  guestCheckInValidators,
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
  checkEligibleMemberForPurchase
);

eventRouter.post(
  "/check-ticket-eligibility",
  checkTicketEligibilityValidators,
  validateRequest,
  checkTicketEligibility
);

eventRouter.post(
  "/purchase-ticket/guest",
  adminMiddleware(ACCESS_3),
  formDataUpload.none(),
  guestTicketValidators,
  validateRequest,
  postAddGuestToEvent,
);

eventRouter.post(
  "/purchase-ticket/member",
  adminMiddleware(ACCESS_3),
  fileUpload(process.env.BUCKET_MEMBER_TICKETS).single("image"),
  manualMemberTicketValidators,
  validateRequest,
  postAddMemberToEvent,
);

eventRouter.post(
  "/register/non-society-event",
  formDataUpload.none(),
  nonSocietyRegistrationValidators,
  validateRequest,
  postNonSocietyEvent
);

eventRouter.post(
  "/non-society-event/resend-email",
  adminMiddleware(ACCESS_3),
  nonSocietyEmailValidators,
  validateRequest,
  postSendNonSocietyEventResendEmail
);

eventRouter.post(
  "/non-society-event/final-reminder-email",
  adminMiddleware(ACCESS_3),
  nonSocietyEmailValidators,
  validateRequest,
  postSendNonSocietyEventFinalReminderEmail
);

eventRouter.post(
  "/sync-calendar-events",
  [],
  postSyncEventsCalendar
);

eventRouter.patch(
  '/check-guest-list',
  adminMiddleware(ACCESS_3),
  guestCheckInValidators,
  validateRequest,
  updatePresence
);

export default eventRouter;
