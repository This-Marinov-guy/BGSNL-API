import express from "express";
import { sessionAction } from "../controllers/session-controller.js";
import {
  login,
  postSendPasswordResetEmail,
  patchUserPassword,
  postCheckEmail,
  postVerifyToken,
  encryptDataController,
  postDirectSignupDisabled,
} from "../controllers/security-controller.js";
import { validateRequest } from "../middleware/validate-request.js";
import { createPasswordRateLimit } from "../middleware/password-rate-limit.js";
import { confirmProfile } from "../controllers/profile-change-controller.js";
import { authMiddleware } from "../middleware/authorization.js";
import { requireGoogleOrigin } from "../services/authentication/google.js";
import { getGoogleConfig, getConnectedAccounts, prepareGoogle, completeGoogle, disconnectGoogle } from "../controllers/google-auth-controller.js";
import { googleChallengeValidators, googleLinkChallengeValidators, googleCredentialValidators, googlePasswordValidators } from "../validation/google-auth-validators.js";
import { requirePasskeyOrigin } from "../services/authentication/passkeys.js";
import { getPasskeys, prepare as preparePasskey, complete as completePasskey, remove as removePasskey } from "../controllers/passkey-auth-controller.js";
import { passkeyOptionsValidators, passkeyRegistrationOptionsValidators, passkeyCredentialValidators, passkeyRemoveValidators } from "../validation/passkey-auth-validators.js";
import {
  changePasswordValidators,
  checkEmailValidators,
  encryptDataValidators,
  loginValidators,
  passwordResetEmailValidators,
  passwordTokenValidators,
} from "../validation/form-validators.js";
import dotenv from "dotenv";
dotenv.config();

const securityRouter = express.Router();
securityRouter.post("/session/refresh", sessionAction("refresh"));
securityRouter.post("/session/activity", sessionAction("activity"));
securityRouter.post("/session/logout", sessionAction("logout"));
securityRouter.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });

securityRouter.use("/passkeys", (_req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  next();
});

securityRouter.get("/passkeys", authMiddleware, getPasskeys);
securityRouter.post("/passkeys/login/options", requirePasskeyOrigin, passkeyOptionsValidators, validateRequest, preparePasskey("login"));
securityRouter.post("/passkeys/login", requirePasskeyOrigin, passkeyCredentialValidators("login"), validateRequest, completePasskey("login"));
securityRouter.post("/passkeys/register/options", requirePasskeyOrigin, authMiddleware, passkeyRegistrationOptionsValidators, validateRequest, preparePasskey("register"));
securityRouter.post("/passkeys/register", requirePasskeyOrigin, authMiddleware, passkeyCredentialValidators("register"), validateRequest, completePasskey("register"));
securityRouter.post("/passkeys/remove", requirePasskeyOrigin, authMiddleware, passkeyRemoveValidators, validateRequest, removePasskey);

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

securityRouter.post("/login", loginValidators, validateRequest, createPasswordRateLimit("login"), login);
securityRouter.post("/profile-change/confirm", createPasswordRateLimit("profile-confirm"), confirmProfile);

securityRouter.post(
  "/send-password-token",
  passwordResetEmailValidators,
  validateRequest,
  createPasswordRateLimit("reset-send"),
  postSendPasswordResetEmail
);

securityRouter.post(
  "/verify-token",
  passwordTokenValidators,
  validateRequest,
  createPasswordRateLimit("reset-attempt"),
  postVerifyToken
);

securityRouter.patch(
  "/change-password",
  changePasswordValidators,
  validateRequest,
  createPasswordRateLimit("reset-attempt"),
  patchUserPassword
);

// Retired: this legacy route allowed password changes without authentication.
// Do not redirect it to another mutation route.
securityRouter.all("/force-change-password", (_req, res) =>
  res.status(410).json({ status: false, message: "This endpoint has been removed. Please use password reset." })
);

securityRouter.post(
  "/encrypt-data",
  encryptDataValidators,
  validateRequest,
  encryptDataController
);

export default securityRouter;
