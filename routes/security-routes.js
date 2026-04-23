import express from "express";
import { check } from "express-validator";
import {
  login,
  postSendPasswordResetEmail,
  patchUserPassword,
  postCheckEmail,
  postVerifyToken,
  adminPatchUserPassword,
  encryptDataController,
  postDirectSignupDisabled,
} from "../controllers/security-controller.js";
import dotenv from "dotenv";
dotenv.config();

const securityRouter = express.Router();

securityRouter.post(
  "/check-email",
  [check("email").notEmpty()],
  postCheckEmail
);

securityRouter.post(
  "/signup",
  postDirectSignupDisabled
);

securityRouter.post(
  "/alumni-signup",
  postDirectSignupDisabled
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

securityRouter.post("/encrypt-data", encryptDataController);

export default securityRouter;
