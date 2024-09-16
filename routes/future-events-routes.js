import express from "express";
import dotenv from "dotenv";
import multer from "multer";
import { addEvent, deleteEvent, editEvent, fetchFullDataEvent, fetchFullDataEventsList } from "../controllers/future-events-action-controller.js";
dotenv.config();

const upload = multer({ storage: multer.memoryStorage() })
const futureEventRouter = express.Router();

futureEventRouter.get('/full-event-details/:eventId', fetchFullDataEvent)

futureEventRouter.get('/full-data-events-list', fetchFullDataEventsList)

const eventImageUploads = upload.fields([
    { name: 'images', maxCount: 4 },
    { name: 'ticketImg', maxCount: 1 },
    { name: 'bgImageExtra', maxCount: 1 },
    { name: 'poster', maxCount: 1 }
])

futureEventRouter.post(
    "/add-event",
    // adminMiddleware(ACCESS_1),
    eventImageUploads,
    addEvent
);

futureEventRouter.patch(
    "/edit-event/:eventId",
    // adminMiddleware(ACCESS_1),
    eventImageUploads,
    editEvent
);

futureEventRouter.delete(
    "/delete-event/:eventId",
    // adminMiddleware(ACCESS_1),
    deleteEvent
);

export default futureEventRouter;