import express from "express";
import {
  donationConfig,
  postCheckoutFile,
  postCheckoutNoFile,
  postSubscriptionNoFile,
  postSubscriptionFile,
  postDonationIntent,
  postCustomerPortal,
} from "../controllers/payments-controllers.js";
import fileUpload from "../middleware/file-upload.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
import { authMiddleware } from "../middleware/authorization.js";
dotenv.config();

const paymentRouter = express.Router();

paymentRouter.get("/donation/config", donationConfig)

paymentRouter.post("/donation/create-payment-intent", postDonationIntent)

paymentRouter.post("/checkout/general", postCheckoutNoFile);

paymentRouter.post(
  "/checkout/member-ticket",
  authMiddleware,
  fileUpload(process.env.BUCKET_MEMBER_TICKETS).single("image"),
  postCheckoutFile
);

paymentRouter.post(
  "/checkout/guest-ticket",
  fileUpload(process.env.BUCKET_GUEST_TICKETS).single("image"),
  postCheckoutFile
);

paymentRouter.post(
  "/checkout/signup",
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  postSubscriptionFile
);

// TODO: rename as this is only for unlocking account with old payment system
paymentRouter.post("/subscription/general", authMiddleware, postSubscriptionNoFile);

paymentRouter.post(
  '/subscription/customer-portal',
  authMiddleware,
  postCustomerPortal
);

export default paymentRouter;
