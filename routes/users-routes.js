import express from "express";
import { param } from "express-validator";
import { ACCOUNT_CAMPAIGN_KEYS } from "../util/config/account-campaigns.js";
import { getAccountCampaign, markAccountCampaignSeen } from "../controllers/account-campaigns-controller.js";
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
  convertAlumniToUser,
  getActiveAlumniMembers,
  updateAlumniQuote,
  postAddDocument,
  patchEditDocument,
  deleteDocument,
  getTreeLayout,
} from "../controllers/users-controllers.js";
import { cancelMembershipInPortal } from "../controllers/subscriptions-controller.js";
import { MEMBER_PROMOTIONS } from "../util/config/promotions.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
import multiFileUpload from "../middleware/multiple-file-upload.js";
import { authMiddleware, requireBenefits } from "../middleware/authorization.js";
import { adminMiddleware } from "../middleware/authorization.js";
import { ACCESS_2 } from "../util/config/defines.js";
import fileUpload from "../middleware/file-upload.js";
import { validateRequest } from "../middleware/validate-request.js";
import { createPasswordRateLimit } from "../middleware/password-rate-limit.js";
import {
  activeMemberValidators,
  addDocumentValidators,
  alumniQuoteValidators,
  calendarVerificationValidators,
  convertAlumniToUserValidators,
  convertUserToAlumniValidators,
  deleteDocumentValidators,
  editDocumentValidators,
  editUserValidators,
} from "../validation/form-validators.js";
dotenv.config();

const userRouter = express.Router();

userRouter.get("/current", authMiddleware, getCurrentUser);

const campaignValidators = [param("campaign").isIn(ACCOUNT_CAMPAIGN_KEYS).withMessage("Unknown account campaign")];
userRouter.get("/campaigns/:campaign", authMiddleware, campaignValidators, validateRequest, getAccountCampaign);
userRouter.post("/campaigns/:campaign/seen", authMiddleware, campaignValidators, validateRequest, markAccountCampaignSeen);

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
  requireBenefits("memberDiscount"),
  multiFileUpload(process.env.BUCKET_AM).fields([
    { name: "cv", maxCount: 2 },
    // { name: 'letter', maxCount: 2 },
  ]),
  activeMemberValidators,
  validateRequest,
  postActiveMember
);

userRouter.patch(
  "/edit-info",
  authMiddleware,
  createPasswordRateLimit("profile-change"),
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  editUserValidators,
  validateRequest,
  patchUserInfo
);

userRouter.delete("/cancel-membership", authMiddleware, cancelMembershipInPortal);
userRouter.get("/promotions", authMiddleware, requireBenefits(), (req, res) => res.json({ promotions: MEMBER_PROMOTIONS }));

userRouter.post(
  "/verify-calendar-subscription",
  authMiddleware,
  requireBenefits(),
  fileUpload(process.env.BUCKET_GUEST_TICKETS).single("image"),
  calendarVerificationValidators,
  validateRequest,
  submitCalendarVerification
);
// Anonymized vital stats export (XLS)
userRouter.get(
  "/export-vital-stats",
  adminMiddleware(ACCESS_2),
  exportVitalStatsXls
);

// Convert a regular user to alumni user
userRouter.post(
  "/convert-to-alumni",
  adminMiddleware(ACCESS_2), // Restrict to admin access
  convertUserToAlumniValidators,
  validateRequest,
  convertUserToAlumni
);

// Convert an alumni user back to a regular user
userRouter.post(
  "/convert-alumni-to-user",
  adminMiddleware(ACCESS_2),
  convertAlumniToUserValidators,
  validateRequest,
  convertAlumniToUser
);

userRouter.patch(
  "/alumni-quote",
  authMiddleware,
  requireBenefits(),
  alumniQuoteValidators,
  validateRequest,
  updateAlumniQuote
);

// Get active alumni members with basic info
userRouter.get("/active-alumni", getActiveAlumniMembers);

// Pre-computed tree layout for the alumni tree visualisation
userRouter.get("/tree-layout", getTreeLayout);

userRouter.post(
  "/add-document",
  authMiddleware,
  fileUpload(process.env.BUCKET_DOCUMENTS).single(
    "content"
  ),
  addDocumentValidators,
  validateRequest,
  postAddDocument
);

userRouter.patch(
  "/edit-document/:documentId",
  authMiddleware,
  fileUpload(process.env.BUCKET_DOCUMENTS).single("content"),
  editDocumentValidators,
  validateRequest,
  patchEditDocument
);

userRouter.delete(
  "/delete-document/:documentId",
  authMiddleware,
  deleteDocumentValidators,
  validateRequest,
  deleteDocument
);

export default userRouter;
