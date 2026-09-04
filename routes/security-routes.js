import express from "express";
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
import { validateRequest } from "../middleware/validate-request.js";
import {
  changePasswordValidators,
  checkEmailValidators,
  encryptDataValidators,
  forceChangePasswordValidators,
  loginValidators,
  passwordResetEmailValidators,
  passwordTokenValidators,
} from "../validation/form-validators.js";
import dotenv from "dotenv";
dotenv.config();

const securityRouter = express.Router();

securityRouter.post(
  "/check-email",
  checkEmailValidators,
  validateRequest,
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

securityRouter.post("/login", loginValidators, validateRequest, login);

securityRouter.post(
  "/send-password-token",
  passwordResetEmailValidators,
  validateRequest,
  postSendPasswordResetEmail
);

securityRouter.post(
  "/verify-token",
  passwordTokenValidators,
  validateRequest,
  postVerifyToken
);

securityRouter.patch(
  "/change-password",
  changePasswordValidators,
  validateRequest,
  patchUserPassword
);

securityRouter.patch(
  "/force-change-password",
  forceChangePasswordValidators,
  validateRequest,
  adminPatchUserPassword
);

securityRouter.post(
  "/encrypt-data",
  encryptDataValidators,
  validateRequest,
  encryptDataController
);

export default securityRouter;
