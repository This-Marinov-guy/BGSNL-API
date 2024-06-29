import express from "express";
import {
  donationConfig,
  postCheckoutFile,
  postCheckoutNoFile,
  postSubscriptionNoFile,
  postSubscriptionFile,
  postDonationIntent,
  postCustomerPortal,
  postWebhookCheckout,
} from "../controllers/payments-controllers.js";
import fileUpload from "../middleware/file-upload.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
dotenv.config();

const paymentRouter = express.Router();

paymentRouter.get("/donation/config", donationConfig)

paymentRouter.post("/donation/create-payment-intent", postDonationIntent)

paymentRouter.post("/checkout-no-file", postCheckoutNoFile);

paymentRouter.post("/subscription-no-file", postSubscriptionNoFile);

paymentRouter.post(
  "/checkout/member",
  fileUpload(process.env.BUCKET_MEMBER_TICKETS).single("image"),
  postCheckoutFile
);
paymentRouter.post(
  "/checkout/guest",
  fileUpload(process.env.BUCKET_GUEST_TICKETS).single("image"),
  postCheckoutFile
);

paymentRouter.post(
  "/checkout/signup",
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  postSubscriptionFile
);

paymentRouter.post(
  '/customer-portal',
  postCustomerPortal
)

paymentRouter.post(
  "/webhook-checkout",
  express.raw({ type: "*/*" }),
  postWebhookCheckout
);

export default paymentRouter;
