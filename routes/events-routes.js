import express from "express";
import { check } from "express-validator";
import {
  checkEligibleGuestForDiscount,
  checkEligibleMemberForPurchase,
  getEvent,
  getEventById,
  getEventPurchaseAvailability,
  getSoldTicketQuantity,
  postAddGuestToEvent,
  postAddMemberToEvent,
  postNonSocietyEvent,
  updatePresence
} from "../controllers/events-controllers.js";
import fileUpload from "../middleware/file-upload.js";
import dotenv from "dotenv";
import multer from "multer";
import { addEvent, deleteEvent, editEvent, fetchEvent, fetchEvents } from "../controllers/events-action-controller.js";
import { authMiddleware } from "../middleware/authorization.js";
dotenv.config();

const upload = multer({ storage: multer.memoryStorage() })
const eventRouter = express.Router();

eventRouter.get(
  "/get-purchase-status/:eventId",
  getEventPurchaseAvailability
)

eventRouter.get(
  "/get-event-details/:region/:eventName",
  getEvent
)

eventRouter.get(
  "/get-event-details-id/:eventId",
  getEventById
)

eventRouter.get(
  "/sold-ticket-count/:eventId",
  getSoldTicketQuantity
)

eventRouter.get(
  "/check-member/:userId/:eventId",
  checkEligibleMemberForPurchase
)

eventRouter.post(
  "/check-guest-discount/:eventId",
  [
    check("email").notEmpty(),
    check("name").notEmpty(),
    check("surname").notEmpty(),
  ],
  checkEligibleGuestForDiscount
)

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

eventRouter.patch(
  '/check-guest-list',
  [
    check("name").notEmpty(),
    check("email").notEmpty()
  ],
  updatePresence
)

//event actions

eventRouter.get('/actions/full-event-details/:eventId', fetchEvent)

eventRouter.get('/actions/events', fetchEvents)

const eventImageUploads = upload.fields([
  { name: 'images', maxCount: 4 },
  { name: 'ticketImg', maxCount: 1 },
  { name: 'bgImageExtra', maxCount: 1 },
  { name: 'poster', maxCount: 1 }
])

eventRouter.post(
  "/actions/add-event",
  eventImageUploads,
  addEvent
);

eventRouter.patch(
  "/actions/edit-event/:eventId",
  eventImageUploads,
  editEvent
);

eventRouter.delete(
  "/actions/delete-event/:eventId",
  deleteEvent
);

export default eventRouter;
