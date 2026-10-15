import express from "express";
import { getScannerEvents } from "../../controllers/Events/scanner-events-controller.js";
import { updateEventSales } from "../../controllers/Events/event-sales-controller.js";
import dotenv from "dotenv";
import multer from "multer";
import { addEvent, archiveExpiredEvents, confirmEventCancellation, deleteEvent, editEvent, fetchFullDataEvent, fetchFullDataEventsList, getEventDraftCount, previewEventCancellation, requestEventCancellation, sendEventDraftReminder } from "../../controllers/Events/future-events-action-controller.js";
import { adminMiddleware, optionalAuthMiddleware } from "../../middleware/authorization.js";
import { ACCESS_3, EVENT_MANAGEMENT_ACCESS } from "../../util/config/defines.js";
import { validateRequest } from "../../middleware/validate-request.js";
import { unsupportedUploadError } from "../../middleware/upload-validation-error.js";
import {
    addEventValidators,
    confirmEventCancellationValidators,
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

futureEventRouter.get("/scanner-events", adminMiddleware(EVENT_MANAGEMENT_ACCESS), getScannerEvents);

futureEventRouter.get(
    '/full-event-details/:eventId',
    optionalAuthMiddleware,
    fetchFullDataEvent
);

futureEventRouter.post("/archive-expired", archiveExpiredEvents);

futureEventRouter.get(
    '/full-data-events-list',
    adminMiddleware(EVENT_MANAGEMENT_ACCESS),
    fetchFullDataEventsList
);

futureEventRouter.get(
    '/draft-count',
    adminMiddleware(EVENT_MANAGEMENT_ACCESS),
    getEventDraftCount
);

futureEventRouter.patch("/sales/:eventId", adminMiddleware(EVENT_MANAGEMENT_ACCESS), updateEventSales);

const eventImageUploads = upload.fields([
    { name: 'images', maxCount: 4 },
    { name: 'ticketImg', maxCount: 1 },
    { name: 'poster', maxCount: 1 }
]);

futureEventRouter.post(
    "/add-event",
    adminMiddleware(EVENT_MANAGEMENT_ACCESS),
    eventImageUploads,
    addEventValidators,
    validateRequest,
    addEvent
);

futureEventRouter.patch(
    "/edit-event/:eventId",
    adminMiddleware(EVENT_MANAGEMENT_ACCESS),
    eventImageUploads,
    editEventValidators,
    validateRequest,
    editEvent
);

futureEventRouter.post(
    "/draft/:eventId/reminder",
    adminMiddleware(EVENT_MANAGEMENT_ACCESS),
    eventDraftReminderValidators,
    validateRequest,
    sendEventDraftReminder
);

futureEventRouter.delete(
    "/delete-event/:eventId",
    adminMiddleware(EVENT_MANAGEMENT_ACCESS),
    deleteEventValidators,
    validateRequest,
    deleteEvent
);

futureEventRouter.get("/cancel-event/:eventId/preview", adminMiddleware(ACCESS_3),
    deleteEventValidators, validateRequest, previewEventCancellation);
futureEventRouter.post("/cancel-event/:eventId", adminMiddleware(ACCESS_3),
    deleteEventValidators, validateRequest, requestEventCancellation);
futureEventRouter.post("/cancel-event/:eventId/confirm", adminMiddleware(ACCESS_3),
    confirmEventCancellationValidators, validateRequest, confirmEventCancellation);

export default futureEventRouter;
