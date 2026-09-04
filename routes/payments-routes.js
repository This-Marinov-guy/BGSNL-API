import express from "express";
import {
  donationConfig,
  postCheckoutFile,
  postCheckoutNoFile,
  postSubscriptionNoFile,
  postSubscriptionFile,
  postDonationIntent,
  postCustomerPortal,
  postPlaygroundTicketPreview,
} from "../controllers/payments-controllers.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import multer from "multer";
import dotenv from "dotenv";
import { authMiddleware } from "../middleware/authorization.js";
import { validateRequest } from "../middleware/validate-request.js";
import {
  customerPortalValidators,
  donationValidators,
  generalCheckoutValidators,
  guestCheckoutValidators,
  memberTicketValidators,
  playgroundTicketValidators,
  signupCheckoutValidators,
  subscriptionCheckoutValidators,
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
  generalCheckoutValidators,
  validateRequest,
  postCheckoutNoFile
);

paymentRouter.post(
  "/checkout/member-ticket",
  authMiddleware,
  formDataUpload.none(),
  memberTicketValidators,
  validateRequest,
  postCheckoutFile
);

paymentRouter.post(
  "/checkout/guest-ticket",
  formDataUpload.none(),
  guestCheckoutValidators,
  validateRequest,
  postCheckoutFile
);

paymentRouter.post(
  "/checkout/signup",
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  signupCheckoutValidators,
  validateRequest,
  postSubscriptionFile
);

// TODO: rename as this is only for unlocking account with old payment system
paymentRouter.post(
  "/subscription/general",
  authMiddleware,
  subscriptionCheckoutValidators,
  validateRequest,
  postSubscriptionNoFile
);

paymentRouter.post(
  '/subscription/customer-portal',
  authMiddleware,
  customerPortalValidators,
  validateRequest,
  postCustomerPortal
);

export default paymentRouter;
