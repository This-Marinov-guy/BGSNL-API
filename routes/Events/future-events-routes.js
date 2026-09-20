import express from "express";
import { updateEventSales } from "../../controllers/Events/event-sales-controller.js";
import dotenv from "dotenv";
import multer from "multer";
import { addEvent, deleteEvent, editEvent, fetchFullDataEvent, fetchFullDataEventsList, getEventDraftCount, sendEventDraftReminder } from "../../controllers/Events/future-events-action-controller.js";
import { adminMiddleware, optionalAuthMiddleware } from "../../middleware/authorization.js";
import { ACCESS_4 } from "../../util/config/defines.js";
import { validateRequest } from "../../middleware/validate-request.js";
import { unsupportedUploadError } from "../../middleware/upload-validation-error.js";
import {
    addEventValidators,
    deleteEventValidators,
    eventDraftReminderValidators,
    editEventValidators,
} from "../../validation/form-validators.js";
dotenv.config();

const EVENT_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 7 },
    fileFilter: (_req, file, callback) => {
        if (EVENT_IMAGE_MIME_TYPES.has(file.mimetype)) {
            callback(null, true);
            return;
        }

        callback(unsupportedUploadError(file, "a JPEG, PNG or WebP image"));
    },
});
const futureEventRouter = express.Router();

futureEventRouter.get(
    '/full-event-details/:eventId',
    optionalAuthMiddleware,
    fetchFullDataEvent
);

futureEventRouter.get(
    '/full-data-events-list',
    adminMiddleware(ACCESS_4),
    fetchFullDataEventsList
);

futureEventRouter.get(
    '/draft-count',
    adminMiddleware(ACCESS_4),
    getEventDraftCount
);

futureEventRouter.patch("/sales/:eventId", adminMiddleware(ACCESS_4), updateEventSales);

const eventImageUploads = upload.fields([
    { name: 'images', maxCount: 4 },
    { name: 'ticketImg', maxCount: 1 },
    { name: 'poster', maxCount: 1 }
]);

futureEventRouter.post(
    "/add-event",
    adminMiddleware(ACCESS_4),
    eventImageUploads,
    addEventValidators,
    validateRequest,
    addEvent
);

futureEventRouter.patch(
    "/edit-event/:eventId",
    adminMiddleware(ACCESS_4),
    eventImageUploads,
    editEventValidators,
    validateRequest,
    editEvent
);

futureEventRouter.post(
    "/draft/:eventId/reminder",
    adminMiddleware(ACCESS_4),
    eventDraftReminderValidators,
    validateRequest,
    sendEventDraftReminder
);

futureEventRouter.delete(
    "/delete-event/:eventId",
    adminMiddleware(ACCESS_4),
    deleteEventValidators,
    validateRequest,
    deleteEvent
);

export default futureEventRouter;
