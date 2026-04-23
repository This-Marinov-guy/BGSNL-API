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
dotenv.config();

const paymentRouter = express.Router();
const formDataUpload = multer({ storage: multer.memoryStorage() });

paymentRouter.get("/donation/config", donationConfig)

paymentRouter.post("/donation/create-payment-intent", postDonationIntent)

paymentRouter.post("/playground/ticket", postPlaygroundTicketPreview)

paymentRouter.post("/checkout/general", postCheckoutNoFile);

paymentRouter.post(
  "/checkout/member-ticket",
  authMiddleware,
  formDataUpload.none(),
  postCheckoutFile
);

paymentRouter.post(
  "/checkout/guest-ticket",
  formDataUpload.none(),
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
