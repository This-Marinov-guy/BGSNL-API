import express from "express";
import { check } from "express-validator";
import {
  checkEligibleGuestForDiscount,
  checkEligibleMemberForPurchase,
  getEventById,
  getEventPurchaseAvailability,
  getEvents,
  getSoldTicketQuantity,
  postAddGuestToEvent,
  postAddMemberToEvent,
  postNonSocietyEvent,
  postSyncEventsCalendar,
  updatePresence
} from "../../controllers/Events/events-controllers.js";
import fileUpload from "../../middleware/file-upload.js";
import dotenv from "dotenv";
import { adminMiddleware, authMiddleware } from "../../middleware/authorization.js";
import { ACCESS_3 } from "../../util/config/defines.js";
dotenv.config();

const eventRouter = express.Router();

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
  "/check-guest-discount/:eventId",
  [
    check("email").notEmpty(),
    check("name").notEmpty(),
    check("surname").notEmpty(),
  ],
  checkEligibleGuestForDiscount
);

eventRouter.post(
  "/purchase-ticket/guest",
  fileUpload(process.env.BUCKET_GUEST_TICKETS).single("image"),
  [
    check("eventName").notEmpty(),
    check("eventDate").notEmpty(),
    check("guestName").notEmpty(),
    check("guestEmail").notEmpty(),
    check("guestPhone").notEmpty(),
  ],
  postAddGuestToEvent
);

eventRouter.post(
  "/purchase-ticket/member",
  authMiddleware,
  fileUpload(process.env.BUCKET_MEMBER_TICKETS).single("image"),
  [
    check("userId").notEmpty(),
    check("eventName").notEmpty(),
    check("eventDate").notEmpty(),
  ],
  postAddMemberToEvent
);

eventRouter.post(
  "/register/non-society-event",
  authMiddleware,
  fileUpload(process.env.BUCKET_MEMBER_TICKETS).single("image"),
  [
    check("event").notEmpty(),
    check("user").notEmpty(),
    check("name").notEmpty(),
    check("email").notEmpty(),
    check("phone").notEmpty(),
    check("notificationTypeTerms").notEmpty(),
  ],
  postNonSocietyEvent
);

eventRouter.post(
  "/sync-calendar-events",
  [],
  postSyncEventsCalendar
);

eventRouter.patch(
  '/check-guest-list',
  adminMiddleware(ACCESS_3),
  [
  check("eventId").notEmpty(),
  check("name").notEmpty(),
  check("email").notEmpty()
  ],
  updatePresence
)

export default eventRouter;
