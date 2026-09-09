import express from "express";
import {
  donationConfig,
  postCheckoutFile,
  postCheckoutNoFile,
  postDonationIntent,
  postPlaygroundTicketPreview,
} from "../controllers/payments-controllers.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import multer from "multer";
import dotenv from "dotenv";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/authorization.js";
import { getMembershipPlans, changeMembership, signupMembership, manageMembership } from "../controllers/subscriptions-controller.js";
import { validateRequest } from "../middleware/validate-request.js";
import { asyncHandler } from "../middleware/async-handler.js";
import {
  customerPortalValidators,
  donationValidators,
  generalCheckoutValidators,
  guestCheckoutValidators,
  memberTicketValidators,
  playgroundTicketValidators,
  signupCheckoutValidators,
  subscriptionCheckoutValidators,
  changeMembershipValidators,
} from "../validation/form-validators.js";
dotenv.config();

const paymentRouter = express.Router();
const formDataUpload = multer({ storage: multer.memoryStorage() });

paymentRouter.get("/donation/config", donationConfig);

paymentRouter.post(
  "/donation/create-payment-intent",
  donationValidators,
  validateRequest,
  postDonationIntent
);

paymentRouter.post(
  "/playground/ticket",
  playgroundTicketValidators,
  validateRequest,
  postPlaygroundTicketPreview
);

paymentRouter.post(
  "/checkout/general",
  optionalAuthMiddleware,
  generalCheckoutValidators,
  validateRequest,
  asyncHandler(postCheckoutNoFile)
);

paymentRouter.post(
  "/checkout/member-ticket",
  authMiddleware,
  formDataUpload.none(),
  memberTicketValidators,
  validateRequest,
  asyncHandler(postCheckoutFile)
);

paymentRouter.post(
  "/checkout/guest-ticket",
  formDataUpload.none(),
  guestCheckoutValidators,
  validateRequest,
  asyncHandler(postCheckoutFile)
);

paymentRouter.post(
  "/checkout/signup",
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  signupCheckoutValidators,
  validateRequest,
  signupMembership
);

// Backward-compatible entry point; all subscription changes share the same policy.
paymentRouter.post(
  "/subscription/general",
  authMiddleware,
  subscriptionCheckoutValidators,
  validateRequest,
  changeMembership
);

paymentRouter.post(
  '/subscription/customer-portal',
  authMiddleware,
  customerPortalValidators,
  validateRequest,
  manageMembership
);

paymentRouter.get("/subscription/plans", authMiddleware, getMembershipPlans);
paymentRouter.post("/subscription/change", authMiddleware, changeMembershipValidators, validateRequest, changeMembership);

export default paymentRouter;
