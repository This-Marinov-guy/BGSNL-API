import express from "express";
import { eventCampaignHandlers } from "../../controllers/Events/event-campaign-controller.js";
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
import dotenv from "dotenv";
import { adminMiddleware, authMiddleware, optionalAuthMiddleware, requireBenefits } from "../../middleware/authorization.js";
import { EVENT_MANAGEMENT_ACCESS, COMMITTEE_MEMBER } from "../../util/config/defines.js";
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
eventRouter.post("/:eventId/campaigns/preview", adminMiddleware(EVENT_MANAGEMENT_ACCESS), eventCampaignHandlers.preview);
eventRouter.post("/:eventId/campaigns/confirm", adminMiddleware(EVENT_MANAGEMENT_ACCESS), eventCampaignHandlers.confirm);
eventRouter.get("/:eventId/campaigns/:campaignId", adminMiddleware(EVENT_MANAGEMENT_ACCESS), eventCampaignHandlers.status);
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
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single("image"),
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
  ["/guest-list/:eventId", "/guest-list/:eventId/stream"],
  adminMiddleware([...EVENT_MANAGEMENT_ACCESS, COMMITTEE_MEMBER, "committee_member"]),
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
