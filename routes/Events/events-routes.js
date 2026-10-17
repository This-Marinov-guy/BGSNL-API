import express from "express";
import { ticketWalletDetails } from "../../controllers/Events/ticket-wallet-controller.js";
import { eventCampaignHandlers, guestSignupPrefill } from "../../controllers/Events/event-campaign-controller.js";
import { feedbackReport, feedbackState, submitFeedback } from "../../controllers/Events/event-feedback-controller.js";
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
  postSendNonSocietyEventResendEmail,
  postSyncEventsCalendar,
  updatePresence,
  getEventGuestList,
  updateGuestPresence,
  updateGuestDetails,
  previewGuestRefund,
  refundGuestPurchase,
  sendGuestTicketAgain,
  sendGuestStripeReceipt,
  removeFreeGuestTicket,
} from "../../controllers/Events/events-controllers.js";
import dotenv from "dotenv";
import { adminMiddleware, authMiddleware, optionalAuthMiddleware, requireBenefits } from "../../middleware/authorization.js";
import { ACCESS_3, ALL_EVENT_REGIONS_ACCESS, EVENT_MANAGEMENT_ACCESS, COMMITTEE_MEMBER } from "../../util/config/defines.js";
import { validateRequest } from "../../middleware/validate-request.js";
import {
  checkTicketEligibilityValidators,
  guestCheckInValidators,
  guestPresenceValidators,
  guestDetailsValidators,
  guestRefundPreviewValidators,
  guestRefundValidators,
  eventFeedbackTicketValidators,
  eventFeedbackAnswerValidators,
  guestTicketValidators,
  manualMemberTicketValidators,
  nonSocietyEmailValidators,
  nonSocietyRegistrationValidators,
} from "../../validation/form-validators.js";
dotenv.config();

const eventRouter = express.Router();
eventRouter.post("/wallet/details", ticketWalletDetails);
eventRouter.get("/feedback/:ticketId", eventFeedbackTicketValidators, validateRequest, feedbackState);
eventRouter.post("/feedback/:ticketId", eventFeedbackAnswerValidators, validateRequest, submitFeedback);
eventRouter.get("/:eventId/feedback", adminMiddleware(EVENT_MANAGEMENT_ACCESS), feedbackReport);
eventRouter.get("/guest-signup-prefill", guestSignupPrefill);
eventRouter.post("/:eventId/campaigns/preview", adminMiddleware(EVENT_MANAGEMENT_ACCESS), eventCampaignHandlers.preview);
eventRouter.post("/:eventId/campaigns/confirm", adminMiddleware(EVENT_MANAGEMENT_ACCESS), eventCampaignHandlers.confirm);
eventRouter.get("/:eventId/campaigns/history", adminMiddleware(EVENT_MANAGEMENT_ACCESS), eventCampaignHandlers.history);
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
  adminMiddleware(ALL_EVENT_REGIONS_ACCESS),
  nonSocietyEmailValidators,
  validateRequest,
  postSendNonSocietyEventResendEmail
);

eventRouter.post(
  "/sync-calendar-events",
  adminMiddleware(ALL_EVENT_REGIONS_ACCESS),
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

eventRouter.patch("/guest-list/:eventId/guests/:guestId", adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  guestDetailsValidators, validateRequest, updateGuestDetails);
eventRouter.post("/guest-list/:eventId/guests/:guestId/send-ticket", adminMiddleware(EVENT_MANAGEMENT_ACCESS),
  guestRefundPreviewValidators, validateRequest, sendGuestTicketAgain);
eventRouter.post("/guest-list/:eventId/guests/:guestId/send-receipt", adminMiddleware(ACCESS_3),
  guestRefundPreviewValidators, validateRequest, sendGuestStripeReceipt);
eventRouter.get("/guest-list/:eventId/guests/:guestId/refund", adminMiddleware(ACCESS_3),
  guestRefundPreviewValidators, validateRequest, previewGuestRefund);
eventRouter.post("/guest-list/:eventId/guests/:guestId/refund", adminMiddleware(ACCESS_3),
  guestRefundValidators, validateRequest, refundGuestPurchase);
eventRouter.delete("/guest-list/:eventId/guests/:guestId", adminMiddleware(ACCESS_3),
  guestRefundPreviewValidators, validateRequest, removeFreeGuestTicket);

export default eventRouter;
