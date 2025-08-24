import express from "express";
import { check } from "express-validator";
import {
  signup,
  login,
  postSendPasswordResetEmail,
  patchUserPassword,
  postCheckEmail,
  postCheckMemberKey,
  postVerifyToken,
  adminPatchUserPassword,
  alumniSignup,
} from "../controllers/security-controller.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
dotenv.config();

const securityRouter = express.Router();

securityRouter.post(
  "/check-email",
  [check("email").notEmpty()],
  postCheckEmail
);

securityRouter.post(
  "/check-member-key",
  [check("email").notEmpty()],
  postCheckMemberKey
);

securityRouter.post(
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

securityRouter.post(
  "/alumni-signup",
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  [
    check("name").notEmpty(),
    check("surname").notEmpty(),
    check("email").notEmpty(),
    check("password").isLength({ min: 5 }),
  ],
  alumniSignup
);

securityRouter.post("/login", login);

securityRouter.post("/send-password-token", postSendPasswordResetEmail);

securityRouter.post(
  "/verify-token",
  [
    check("email").notEmpty(),
    check("token").notEmpty(),
    check("birth").notEmpty(),
    check("phone").notEmpty(),
  ],
  postVerifyToken
);

securityRouter.patch(
  "/change-password",
  [check("password").isLength({ min: 5 })],
  patchUserPassword
);

securityRouter.patch("/force-change-password", adminPatchUserPassword);

export default securityRouter;
