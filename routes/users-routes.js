import express from "express";
import { check } from "express-validator";
import {
  signup,
  login,
  getCurrentUser,
  postSendPasswordResetEmail,
  patchUserPassword,
  patchUserInfo,
  postCheckEmail,
  patchUserStatus,
  postCheckMemberKey,
  postActiveMember,
} from "../controllers/users-controllers.js";
import {
  cancelSubscription
} from "../controllers/payments-controllers.js"
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
import multiFileUpload from "../middleware/multiple-file-upload.js";
import { adminMiddleware } from "../middleware/authorization.js";
dotenv.config();

const userRouter = express.Router();

userRouter.get("/:userId", getCurrentUser);

userRouter.post(
  "/check-email",
  [check("email").notEmpty()],
  postCheckEmail
);

userRouter.post(
  "/check-member-key",
  [check("email").notEmpty(), check("key").notEmpty()],
  postCheckMemberKey
);

userRouter.post(
  "/signup",
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  [
    check("name").notEmpty(),
    check("surname").notEmpty(),
    check("birth").notEmpty(),
    check("phone").notEmpty(),
    check("university").notEmpty(),
    check("email").notEmpty(),
    check("password").isLength({ min: 5 }),
  ],
  signup
);

userRouter.post("/cancel-membership", cancelSubscription)

userRouter.post("/login", login);

userRouter.post('/active-member', multiFileUpload(process.env.BUCKET_AM).fields([
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

userRouter.post(
  "/send-password-token",
  [check("email").notEmpty()],
  postSendPasswordResetEmail
);

userRouter.patch(
  "/edit-info/:userId",
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

userRouter.patch(
  "/change-password",
  [check("password").isLength({ min: 5 })],
  patchUserPassword
);

userRouter.patch("/unlock/:userId", patchUserStatus);

export default userRouter;
