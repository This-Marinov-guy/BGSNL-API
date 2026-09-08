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
import { authMiddleware } from "../middleware/authorization.js";
import { requireGoogleOrigin } from "../services/authentication/google.js";
import { getGoogleConfig, getConnectedAccounts, prepareGoogle, completeGoogle, disconnectGoogle } from "../controllers/google-auth-controller.js";
import { googleChallengeValidators, googleLinkChallengeValidators, googleCredentialValidators, googlePasswordValidators } from "../validation/google-auth-validators.js";
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

securityRouter.get("/google/config", getGoogleConfig);
securityRouter.get("/connected-accounts", authMiddleware, getConnectedAccounts);
securityRouter.post("/google/login/challenge", requireGoogleOrigin, googleChallengeValidators, validateRequest, prepareGoogle("login"));
securityRouter.post("/google/login", requireGoogleOrigin, googleCredentialValidators, validateRequest, completeGoogle("login"));
securityRouter.post("/google/link/challenge", requireGoogleOrigin, authMiddleware, googleLinkChallengeValidators, validateRequest, prepareGoogle("link"));
securityRouter.post("/google/link", requireGoogleOrigin, authMiddleware, googleCredentialValidators, validateRequest, completeGoogle("link"));
securityRouter.post("/google/disconnect", requireGoogleOrigin, authMiddleware, googlePasswordValidators, validateRequest, disconnectGoogle);

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
