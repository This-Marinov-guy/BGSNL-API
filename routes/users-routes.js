import express from "express";
import { check } from "express-validator";
import {
  getCurrentUser,
  patchUserInfo,
  postActiveMember,
  getCurrentUserRoles,
  refreshToken,
  getCurrentUserSubscriptionStatus,
  submitCalendarVerification,
} from "../controllers/users-controllers.js";
import {
  cancelSubscription
} from "../controllers/payments-controllers.js"
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
import multiFileUpload from "../middleware/multiple-file-upload.js";
import { authMiddleware } from "../middleware/authorization.js";
import fileUpload from "../middleware/file-upload.js";
dotenv.config();

const userRouter = express.Router();

userRouter.get("/current", authMiddleware, getCurrentUser);

userRouter.get("/get-subscription-status", authMiddleware, getCurrentUserSubscriptionStatus);

userRouter.get("/refresh-token", refreshToken);

userRouter.get("/roles", authMiddleware, getCurrentUserRoles);

userRouter.post('/active-member', authMiddleware, multiFileUpload(process.env.BUCKET_AM).fields([
  { name: 'cv', maxCount: 2 },
  // { name: 'letter', maxCount: 2 },
]),
[
  check("email").notEmpty(),
  check("phone").notEmpty(),
  check("questions").notEmpty(),
],
postActiveMember
)

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
;

export default userRouter;
