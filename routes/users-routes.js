import express from "express";
import { check, body } from "express-validator";
import {
  getCurrentUser,
  patchUserInfo,
  postActiveMember,
  getCurrentUserRoles,
  refreshToken,
  getCurrentUserSubscriptionStatus,
  submitCalendarVerification,
  exportVitalStatsXls,
  convertUserToAlumni,
  getActiveAlumniMembers,
  updateAlumniQuote,
  postAddDocument,
  patchEditDocument,
  deleteDocument,
} from "../controllers/users-controllers.js";
import { cancelSubscription } from "../controllers/payments-controllers.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
import multiFileUpload from "../middleware/multiple-file-upload.js";
import { authMiddleware } from "../middleware/authorization.js";
import { adminMiddleware } from "../middleware/authorization.js";
import { ACCESS_2 } from "../util/config/defines.js";
import fileUpload from "../middleware/file-upload.js";
dotenv.config();

const userRouter = express.Router();

userRouter.get("/current", authMiddleware, getCurrentUser);

userRouter.get(
  "/get-subscription-status",
  authMiddleware,
  getCurrentUserSubscriptionStatus
);

userRouter.get("/refresh-token", refreshToken);

userRouter.get("/roles", authMiddleware, getCurrentUserRoles);

userRouter.post(
  "/active-member",
  authMiddleware,
  multiFileUpload(process.env.BUCKET_AM).fields([
    { name: "cv", maxCount: 2 },
    // { name: 'letter', maxCount: 2 },
  ]),
  [
    check("email").notEmpty(),
    check("phone").notEmpty(),
    check("questions").notEmpty(),
  ],
  postActiveMember
);

userRouter.patch(
  "/edit-info",
  authMiddleware,
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  [
    check("name").notEmpty(),
    check("surname").notEmpty(),
    check("phone").notEmpty(),
    check("university").notEmpty(),
    check("email").notEmpty(),
  ],
  patchUserInfo
);

userRouter.delete("/cancel-membership", authMiddleware, cancelSubscription);

userRouter.post(
  "/verify-calendar-subscription",
  authMiddleware,
  fileUpload(process.env.BUCKET_GUEST_TICKETS).single("image"),
  submitCalendarVerification
);
// Anonymized vital stats export (XLS)
userRouter.get(
  "/export-vital-stats",
  // adminMiddleware(ACCESS_2),
  exportVitalStatsXls
);

// Convert a regular user to alumni user
userRouter.post(
  "/convert-to-alumni",
  adminMiddleware(ACCESS_2), // Restrict to admin access
  [check("email").isEmail().withMessage("Please provide a valid email")],
  convertUserToAlumni
);

userRouter.patch("/alumni-quote", authMiddleware, updateAlumniQuote);

// Get active alumni members with basic info
userRouter.get("/active-alumni", getActiveAlumniMembers);

userRouter.post(
  "/add-document",
  authMiddleware,
  fileUpload(process.env.BUCKET_DOCUMENTS).single(
    "content"
  ),
  [
    body("type")
      .custom((value) => {
        const numValue = parseInt(value);
        return numValue === 1 || numValue === 2;
      })
      .withMessage("Wrong type of document"),
    check("content")
      .optional()
      .isString()
      .withMessage("Content must be a string (link) if not uploading a file"),
  ],
  postAddDocument
);

userRouter.patch(
  "/edit-document/:documentId",
  authMiddleware,
  fileUpload(process.env.BUCKET_DOCUMENTS).single("content"),
  [
    body("type")
      .optional()
      .custom((value) => {
        if (value === undefined) return true;
        const numValue = parseInt(value);
        return numValue === 1 || numValue === 2;
      })
      .withMessage("Type must be 1 (CV) or 2 (Cover Letter)"),
    check("name")
      .optional()
      .notEmpty()
      .withMessage("Name cannot be empty if provided"),
    check("content")
      .optional()
      .isString()
      .withMessage("Content must be a string (link) if not uploading a file"),
  ],
  patchEditDocument
);

userRouter.delete("/delete-document/:documentId", authMiddleware, deleteDocument);

export default userRouter;
